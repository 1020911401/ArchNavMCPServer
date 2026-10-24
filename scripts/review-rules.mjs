#!/usr/bin/env node
/**
 * review-rules — stack-specific review findings for a change set.
 *
 * ArchNav's graph says *what* is connected; it says nothing about the mistakes
 * that are cheap to make in Vue/uni-app and in Laravel/PHP. This layer maps a
 * `changes()` result onto the pitfalls that are structurally detectable, using
 * only evidence already in the index (plus, where a rule needs source text, a
 * real disk read — the same "navigate via graph, verify on disk" principle).
 *
 * Usage:
 *   node scripts/review-rules.mjs [dir] [--scope unstaged|staged|all|compare|corpus]
 *                                 [--base <ref>] [--json] [--gate]
 *
 *   --gate  exit 1 when any finding has severity `error`.
 *
 * Every finding carries `why` — the reason the pattern bites — and `evidence`
 * so a reviewer can check it instead of trusting it.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { archNav } from '../src/navigation.js';
import { getIndex } from '../src/analyzer.js';
import { runRules, GO_RULES, ANY_RULES, VUE_RULES, BINDING_RULES, PHP_RULES, STUB_RULES, vforMissingKeys } from './rules/index.mjs';
// The stub detector and the v-for/:key finder moved into their rule modules; re-exported
// here because the tests (and one older caller) import them from this entry point.
import { stubMarkerInComments } from './rules/stub.mjs';
export { stubMarkerInComments, vforMissingKeys };
import { selectTests } from './test-select.mjs';

const norm = (p) => String(p ?? '').replace(/\\/g, '/');

/** Files that are almost never the file you meant to edit. */
const BACKUP_RE = /(副本|复制|copy|\.bak|\.orig|\.old|\.20\d{6}|_20\d{6}|\.blade\.\d{8})/i;

/**
 * Names whose duplication says nothing about review risk: PHP magic methods and
 * Vue option/lifecycle keys are *expected* to repeat in every file. Without this
 * filter the same-name rule fires on `__construct` (32 defs) and `onLoad` (119)
 * in every diff, which trains the reviewer to ignore the rule.
 */
const LIFECYCLE_NAME_RE = /^(__.*|construct|constructor|handle|boot|booted|data|props|computed|watch|methods|components|filters|directives|mixins|created|beforeCreate|beforeMount|mounted|beforeUpdate|updated|beforeDestroy|destroyed|activated|deactivated|setup|render|onLoad|onShow|onReady|onHide|onUnload|onPullDownRefresh|onReachBottom|onShareAppMessage|onPageScroll|onLaunch)$/;
// ── front-end / back-end boundary ────────────────────────────────────────────
// The boundary is where the two repos must agree, and it is invisible to either
// index alone: the front-end calls `request.get('order/list')`, the backend
// declares `Route::get('order/list', ...)`. Matching them needs both indexes.

const REQUEST_RE = /\brequest\s*\.\s*(get|post|put|delete|patch)\s*\(\s*(['"])([^'"]+)\2/g;
const DYN_REQUEST_RE = /\brequest\s*\.\s*(get|post|put|delete|patch)\s*\(\s*(['"])([^'"]+)\2\s*\+/g;

export function extractFrontCalls(files, readFile) {
  const calls = [];
  for (const file of files) {
    const src = readFile(file);
    if (!src) continue;
    // A dynamic call (`request.get('x/' + id)`) also satisfies the static pattern,
    // so record its offsets first and let the static pass skip them.
    const dynamicKeys = new Set();
    for (const m of src.matchAll(DYN_REQUEST_RE)) dynamicKeys.add(`${m.index}:${m[1]}:${m[3]}`);
    for (const m of src.matchAll(REQUEST_RE)) {
      if (dynamicKeys.has(`${m.index}:${m[1]}:${m[3]}`)) continue;
      calls.push({ file, method: m[1].toUpperCase(), path: m[3], dynamic: false });
    }
    for (const m of src.matchAll(DYN_REQUEST_RE)) {
      calls.push({ file, method: m[1].toUpperCase(), path: m[3], dynamic: true });
    }
  }
  return calls;
}

export function backendRoutes(index) {
  return (index?.knowledgeGraph?.nodes || [])
    .filter((n) => String(n.id).startsWith('route:'))
    .map((n) => ({
      method: String(n.method || '').toUpperCase(),
      uri: String(n.uri || ''),
      file: norm(n.file || ''),
      line: n.line ?? null,
      controller: n.controller || null,
      action: n.action || null,
    }));
}

const normPath = (p) => String(p).split('?')[0].split('#')[0].trim().replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/').toLowerCase();

function uniquePathsSample(calls, n = 3) {
  const uniq = [...new Set(calls.map((c) => `${c.method} ${c.path}`))];
  return uniq.slice(0, n).join(', ');
}
const segs = (p) => normPath(p).split('/').filter(Boolean);
const isParam = (v) => v.startsWith(':') || v.startsWith('{');

/** `customer/{customer}` matches `customer/5`; everything else must be equal. */
export function pathMatches(a, b) {
  const A = segs(a); const B = segs(b);
  if (A.length !== B.length) return false;
  return A.every((x, i) => isParam(x) || isParam(B[i]) || x === B[i]);
}

/**
 * Cross-repo comparison. `matchRate` is measured first and deliberately: two
 * indexes that were never a front/back pair (different applications) produce a
 * near-zero rate, and listing ~270 individual "missing endpoint" errors from
 * that would be pure noise. Below `pairingFloor` we report the pairing problem
 * once instead of the fake findings.
 */
export function compareBoundary(frontCalls, routes, { pairingFloor = 0.2 } = {}) {
  const staticCalls = frontCalls.filter((c) => !c.dynamic);
  const matched = []; const missing = []; const methodMismatch = [];
  const used = new Set();
  for (const c of staticCalls) {
    const samePath = routes.filter((r) => pathMatches(r.uri, c.path));
    if (!samePath.length) { missing.push(c); continue; }
    const ok = samePath.find((r) => r.method === c.method || r.method === 'ANY');
    if (ok) { matched.push({ call: c, route: ok }); used.add(`${ok.method} ${ok.uri}`); }
    else methodMismatch.push({ call: c, routes: samePath });
  }
  const uniquePaths = new Set(staticCalls.map((c) => normPath(c.path))).size;
  const matchedPaths = new Set(matched.map((m) => normPath(m.call.path))).size;
  const matchRate = uniquePaths ? matchedPaths / uniquePaths : 1;
  const unused = routes.filter((r) => !used.has(`${r.method} ${r.uri}`));
  return {
    matched, missing, methodMismatch, unused,
    dynamic: frontCalls.filter((c) => c.dynamic),
    matchRate, pairingFloor, pairSuspect: matchRate < pairingFloor,
  };
}

// ── review-tooling output (SARIF / GitHub annotations) ───────────────────────
const SARIF_LEVEL = { error: 'error', warn: 'warning', info: 'note' };

export function toSarif(findings, { toolName = 'archnav-review-rules', toolVersion = '1.0.0' } = {}) {
  // Code scanning rejects a result without a location ("locationFromSarifResult:
  // expected at least one location" — measured on a real run). Findings that have
  // no file (repo-level ones like fe-be-pairing-suspect) cannot be annotated, so
  // they stay in --json/--markdown and are counted here instead.
  const located = findings.filter((f) => f.file);
  const ruleIds = [...new Set(located.map((f) => f.rule))];
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{
      tool: {
        driver: {
          name: toolName,
          version: toolVersion,
          informationUri: 'https://github.com/',
          rules: ruleIds.map((id) => ({ id, shortDescription: { text: id } })),
        },
      },
      properties: { droppedWithoutLocation: findings.length - located.length },
      results: located.map((f) => ({
        ruleId: f.rule,
        level: SARIF_LEVEL[f.severity] || 'note',
        message: { text: `${f.message} | why: ${f.why} | evidence: ${f.evidence}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: f.file }, ...(f.line ? { region: { startLine: f.line } } : {}) } }],
      })),
    }],
  };
}

export function toGithubAnnotations(findings) {
  // Workflow-command syntax: ::error file=...,line=...,title=...::message
  const LEVEL = { error: 'error', warn: 'warning', info: 'notice' };
  return findings.map((f) => {
    const props = [f.file ? `file=${f.file}` : null, f.line ? `line=${f.line}` : null, `title=${f.rule}`]
      .filter(Boolean).join(',');
    return `::${LEVEL[f.severity] || 'notice'} ${props}::${String(f.message).replace(/\r?\n/g, ' ')}`;
  }).join('\n');
}

// ── security / performance smells in the *content* of changed files ──────────
// These are diff-local pattern checks over real source text (never the graph):
// they cannot prove exploitability or measure runtime, and they are deliberately
// narrow — measured on bench/php-app, the naive `(password|secret) => '…'`
// pattern matched 5 times and every one was a *validation rule* ('required|min:6'),
// so the secret check requires an assignment-shaped value and excludes those.

const SEC_PATTERNS = [
  {
    rule: 'php-raw-sql-interpolation', severity: 'error',
    // Only double-quoted interpolation or concatenation — `'name = $q'` in single
    // quotes is a literal in PHP, so flagging it would be a false positive.
    // Covered shapes: interpolation inside either quote style, and concatenation of
    // either quote style. `DB::select/statement/unprepared` join `whereRaw`/`DB::raw`
    // because they take a raw string just the same — a real repo interpolated a table
    // name into `DB::select("PRAGMA table_info(\`{$t}\`)")` and the narrower rule missed it.
    re: /(?:whereRaw|orderByRaw|selectRaw|havingRaw|DB::(?:raw|select|statement|unprepared|insert|update|delete))\s*\(\s*(?:"[^"]*\$[^"]*"|[^'"]*(['"])[^'"]*\1\s*\.\s*\$)/,
    why: '原始 SQL 里直接插值/拼接变量就是 SQL 注入。改用绑定参数（whereRaw($sql, [$x])）或查询构造器。',
  },
  {
    rule: 'php-dangerous-function', severity: 'error',
    re: /\b(eval|exec|shell_exec|system|passthru|proc_open|popen|unserialize|extract)\s*\(/,
    why: '这些函数把输入变成代码/命令/对象（RCE、反序列化）。除非紧跟着白名单校验，否则不允许出现在请求路径上。',
  },
  {
    rule: 'php-debug-left-on', severity: 'warn',
    re: /(?<![\w>$])(dd|dump|var_dump|print_r|die|ray)\s*\(/,
    why: '调试输出留在提交里会泄漏变量、内部路径和 SQL；dd() 还会直接中断响应。',
  },
];

/** Python: the same three classes as PHP/JS — dangerous calls, swallowed errors,
 * injection, plus the two traps that are Python-only (mutable default args,
 * requests without a timeout). */
const PY_PATTERNS = [
  {
    rule: 'py-dangerous-function', severity: 'error',
    re: /\b(?:eval|exec)\s*\(|pickle\.loads?\s*\(|os\.system\s*\(|subprocess\.[a-z_]+\([^)\n]*shell\s*=\s*True/,
    why: 'eval/exec/pickle/os.system/shell=True 把数据变成代码或命令：任何拼进来的变量都是 RCE 或反序列化入口。',
  },
  {
    rule: 'py-raw-sql', severity: 'error',
    re: /\.execute\s*\(\s*f['"]|\.execute\s*\(\s*['"][^'"]*['"]\s*(?:%|\+)/,
    why: 'f-string / % / 拼接进 SQL 就是注入；用参数化（execute(sql, params)）。',
  },
  {
    rule: 'py-bare-except', severity: 'warn',
    re: /except\s*:/,
    why: '裸 except 连 KeyboardInterrupt/SystemExit 一起吞：至少写 except Exception as e 并记录。',
  },
  {
    rule: 'py-mutable-default-arg', severity: 'warn',
    re: /def\s+\w+\s*\([^)]*=\s*(?:\[\]|\{\}|set\(\))/,
    why: '可变默认参数在调用之间共享同一个对象（经典 Python 陷阱）：默认值用 None，函数体内再建。',
  },
  {
    rule: 'py-debug-left-on', severity: 'warn',
    re: /(?<![\w.])(?:breakpoint\(\)|pdb\.set_trace\(\))/,
    why: 'breakpoint()/pdb 留在提交里会让服务在请求路径上直接挂住。',
  },
  {
    rule: 'py-requests-no-timeout', severity: 'warn',
    re: /requests\.(?:get|post|put|delete|patch|request)\s*\((?![^)\n]*timeout\s*=)/,
    why: '没有 timeout 的 requests 调用在对方不响应时会一直挂着（连同线程/worker 一起耗尽）。',
  },
  {
    rule: 'py-import-star', severity: 'info',
    re: /^[ \t]*from\s+[\w.]+\s+import\s+\*[ \t]*$/m,
    why: 'import * 覆盖本地名字、让 callers/影响面分析失效（图谱看不到具体符号）。',
  },
];
const PY_SECRET_RE = /(?:^|[\s(,])([A-Za-z_]*(?:password|passwd|secret|api_?key|access_?token|private_?key)[A-Za-z_]*)\s*=\s*['"]([^'"]{8,})['"]/gim;
const PY_STDLIB = new Set(['os', 'sys', 're', 'json', 'math', 'time', 'datetime', 'pathlib', 'typing', 'collections', 'itertools', 'functools', 'subprocess', 'logging', 'csv', 'sqlite3', 'unittest', 'asyncio', 'hashlib', 'random', 'shutil', 'tempfile', 'urllib', 'http', 'socket', 'threading', 'multiprocessing', 'uuid', 'base64', 'glob', 'io', 'argparse', 'contextlib', 'dataclasses', 'enum', 'decimal', 'statistics', 'traceback', 'warnings', 'zipfile', 'tarfile', 'gzip', 'xml', 'email', 'smtplib', 'ssl', 'secrets', 'string', 'textwrap', 'pprint', 'copy', 'inspect', 'importlib', 'signal', 'queue', 'heapq', 'bisect', 'array', 'struct', 'difflib', 'fnmatch', 'getpass', 'platform', 'sysconfig', 'codecs', 'locale', 'calendar', 'zoneinfo', 'tomllib', 'abc', 'concurrent', 'ctypes', 'unicodedata', 'webbrowser', 'tkinter', 'venv', 'site', 'atexit', 'pickle', 'shlex', 'stat', 'sched', 'select', 'errno', 'operator', 'numbers', 'fractions', 'graphlib', 'weakref', 'gc', 'types']);
const JS_SEC_PATTERNS = [
  {
    rule: 'js-dangerous-function', severity: 'error',
    re: /\beval\s*\(|new\s+Function\s*\(/,
    why: 'eval / new Function 会把字符串当代码执行：任何拼进来的变量都是 XSS 或 RCE 通道。',
  },
  {
    rule: 'vue-v-html', severity: 'warn',
    re: /\bv-html\s*=/,
    why: 'v-html 不做转义（等同 innerHTML）；只要内容可能来自接口/用户，就必须先过滤，否则是 XSS。',
  },
  {
    rule: 'js-innerhtml', severity: 'warn',
    re: /\.innerHTML\s*=/,
    why: '直接赋值 innerHTML 会执行注入的标记；优先 textContent 或白名单过滤。',
  },
];

// Key names *containing* a sensitive word (`stripe_secret`, `mail_password`) count —
// requiring an exact key missed the real hardcoded credentials.
const SECRET_KEY = '(?:[A-Za-z0-9_-]*(?:password|passwd|secret|api_?key|access_?token|private_?key|auth_?token)[A-Za-z0-9_-]*)';
const SECRET_ARRAY_RE = new RegExp(`['"](${SECRET_KEY})['"]\\s*=>\\s*['"]([^'"]{8,})['"]`, 'gi');
const SECRET_VAR_RE = new RegExp(`\\$(${SECRET_KEY})\\s*=\\s*['"]([^'"]{8,})['"]`, 'gi');
// Laravel validation strings live in the same key names (`'password' => 'required|min:6'`).
const VALIDATION_RULE_VALUE_RE = /^(required|nullable|sometimes|bail|string|numeric|integer|boolean|array|email|url|date|confirmed|image|file|alpha|min:|max:|between:|in:|not_in:|regex:|unique:|exists:|digits|size:)/;
// Placeholders in shipped example configs are not credentials.
const PLACEHOLDER_VALUE_RE = /^(your|my|change|example|dummy|test|xxx|xxxx|placeholder|todo|fake|sk_test|\.\.\.)/i;

// The controller-shape regexes (query-in-loop / pagination / mass input / validation
// present) moved into scripts/rules/php.mjs, where the rules that read them live.

// The v-for/:key tag regex moved into scripts/rules/vue.mjs.

/**
 * Blank *template literal* contents (backticks only, length preserved). Our own
 * scripts write source code into template strings (fixture builders, rule tables,
 * regex sources); scanning those as if they were code produced false findings —
 * e.g. `tests/selftest.mjs` "imports" a controller file it only writes out.
 */
export function blankTemplateLiterals(src) {
  const text = String(src || '');
  const out = text.split('');
  const blank = (from, to) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
  };
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') { i++; continue; }
    // Walk to the closing backtick: escapes, `${ ... }` nesting (braces) and nested
    // templates all have to be understood. The old non-greedy regex stopped at the
    // first inner backtick, so the rest of a nested template leaked into the "code"
    // stream — that is how `mkText(`${a} files, ${b} symbols`)` was counted as two
    // arguments.
    let j = i + 1;
    let depth = 0;
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') { j += 2; continue; }
      if (depth === 0) {
        if (c === '`') break;
        if (c === '$' && text[j + 1] === '{') { depth = 1; j += 2; continue; }
        j++;
        continue;
      }
      if (c === '{') { depth++; j++; continue; }
      if (c === '}') { depth--; j++; continue; }
      if (c === '`') {                      // nested template inside ${ … }
        let k = j + 1;
        let inner = 0;
        while (k < text.length) {
          const d = text[k];
          if (d === '\\') { k += 2; continue; }
          if (inner === 0 && d === '`') break;
          if (inner === 0 && d === '$' && text[k + 1] === '{') { inner = 1; k += 2; continue; }
          if (inner > 0) { if (d === '{') inner++; else if (d === '}') inner--; }
          k++;
        }
        j = k + 1;
        continue;
      }
      if (c === '\'' || c === '"') {        // string inside ${ … }
        const q = c;
        let k = j + 1;
        while (k < text.length) {
          if (text[k] === '\\') { k += 2; continue; }
          if (text[k] === q || text[k] === '\n') break;
          k++;
        }
        j = k + 1;
        continue;
      }
      j++;
    }
    blank(i + 1, j);
    i = j + 1;
  }
  return out.join('');
}

// stubMarkerInComments now lives in scripts/rules/stub.mjs, together with the rule that
// uses it (and re-exported at the top of this file).

/**
 * Blank out string, comment and regex-literal *contents* in one pass, keeping the
 * text length (so every offset still points at the same place).
 *
 * A single state machine, because the previous two regex passes could be fooled:
 * a regex literal like `/['"]/` opened a phantom "string" that swallowed the rest
 * of the file until the next quote, and a `/*` inside a string started a phantom
 * block comment. Both silently blanked real code — which is how `js-unused-binding`
 * reported five used bindings in this very file as unused (occurrences=0).
 */
export function blankNonCode(src, { onComment = null } = {}) {
  const text = String(src || '');
  const out = text.split('');
  const LINE_BREAKS = String.fromCharCode(13, 10);
  const blank = (from, to) => {
    for (let i = from; i < to; i++) {
      const ch = out[i];
      if (!LINE_BREAKS.includes(ch)) out[i] = ' ';
    }
  };
  const REGEX_PRECEDERS = '(,=:[!&|?{};+-*%~^<>';
  const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await', 'instanceof']);
  let i = 0;
  let prev = '';          // last significant code character
  let word = '';          // trailing identifier, for `return /re/` style keywords
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      let end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
      if (onComment) onComment(i, end);
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && n === '*') {
      let end = text.indexOf('*/', i + 2);
      end = end === -1 ? text.length : end + 2;
      if (onComment) onComment(i, end);
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === c || text[j] === '\n') break;
        j++;
      }
      if (text[j] === c) {
        blank(i + 1, j);
        i = j + 1;
        prev = c;
        word = '';
        continue;
      }
      i++;                                    // unterminated quote: never swallow the file
      continue;
    }
    if (c === '/' && (prev === '' || REGEX_PRECEDERS.includes(prev) || REGEX_KEYWORDS.has(word))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < text.length) {
        const d = text[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        blank(i + 1, j);
        i = j + 1;
        prev = '/';
        word = '';
        continue;
      }
      i++;                                    // division, not a regex
      continue;
    }
    if (!/\s/.test(c)) {
      prev = c;
      word = /[\w$]/.test(c) ? word + c : '';
    }
    i++;
  }
  return out.join('');
}

/**
 * Blank out string/comment *contents* (length preserved, so offsets stay valid)
 * before matching operator-level traps: `where('x', '!=', 'y')` and `'a' == 'b'`
 * are operators inside literals, not loose comparisons.
 */
export function blankLiterals(src) {
  return blankNonCode(src);
}

/** POSIX join+normalize (`..`/`.` segments) for import-path resolution. */
export function joinPosix(dir, spec, ...more) {
  const out = [];
  const segments = [dir, spec, ...more].flatMap((s) => String(s == null ? '' : s).split('/'));
  for (const part of segments) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

// v-for/:key detection lives in scripts/rules/vue.mjs with the rule that uses it;
// re-exported here because the tests import it from this entry point.

export function scanContent(file, src) {
  const findings = [];
  if (!src) return findings;
  const lineOf = (idx) => src.slice(0, idx).split(/\r?\n/).length;
  const f = norm(file);

  const isPhp = /\.php$/i.test(file);
  const isJs = /\.(js|ts|vue)$/i.test(file);
  const isPy = /\.py$/i.test(file);
  const isRequestPath = /(^|\/)(Http\/Controllers|Controllers|Services|Repositories|Presenters|Validators)\//i.test(file);

  if (isPhp) {
    for (const p of SEC_PATTERNS) {
      const m = p.re.exec(src);
      if (!m) continue;
      findings.push({
        rule: p.rule, severity: p.severity, file: f, line: lineOf(m.index),
        message: `${file} 命中 ${p.rule.replace(/^php-/, '')}：\`${m[0].slice(0, 40)}\``,
        why: p.why,
        evidence: `matched: ${m[0].slice(0, 60)}`,
      });
    }

    for (const re of [SECRET_ARRAY_RE, SECRET_VAR_RE]) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) {
        const value = m[2];
        if (VALIDATION_RULE_VALUE_RE.test(value)) continue; // 'required|min:6' is not a secret
        if (PLACEHOLDER_VALUE_RE.test(value)) continue; // 'your-key', 'changeme', 'xxxx'
        findings.push({
          rule: 'php-hardcoded-secret', severity: 'error', file: f, line: lineOf(m.index),
          message: `${file} 里 ${m[1]} 被写成字面量（值长度 ${value.length}）。`,
          why: '硬编码凭据会随仓库扩散且无法轮换：应放进 .env + config()，或交给密钥管理服务。',
          evidence: `key=${m[1]}, valueLen=${value.length}`,
        });
      }
    }
  }

  if (isJs) {
    for (const p of JS_SEC_PATTERNS) {
      const m = p.re.exec(src);
      if (!m) continue;
      findings.push({
        rule: p.rule, severity: p.severity, file: f, line: lineOf(m.index),
        message: `${file} 命中 ${p.rule}：\`${m[0].slice(0, 40)}\``,
        why: p.why,
        evidence: `matched: ${m[0].slice(0, 60)}`,
      });
    }
  }

  if (isPy) {
    for (const p of PY_PATTERNS) {
      const m = p.re.exec(src);
      if (!m) continue;
      findings.push({
        rule: p.rule, severity: p.severity, file: f, line: lineOf(m.index),
        message: `${file} 命中 ${p.rule.replace(/^py-/, '')}：\`${m[0].slice(0, 40)}\``,
        why: p.why,
        evidence: `matched: ${m[0].slice(0, 60)}`,
      });
    }
    // `except ...: pass` is Python's empty catch — same rule id as the JS/PHP one
    const exceptPass = /except[^:\n]*:\s*(?:\n[ \t]*)?pass\b/.exec(src);
    if (exceptPass) {
      findings.push({
        rule: 'empty-catch', severity: 'warn', file: f, line: lineOf(exceptPass.index),
        message: `${file} 用 except: pass 静默吞掉了异常。`,
        why: 'AI/偷懒代码最常见的"看起来能跑"写法：异常被吞后线上只剩空数据没有日志，排查成本极高。',
        evidence: `matched: ${exceptPass[0].replace(/\s+/g, ' ').slice(0, 40)}`,
      });
    }
    PY_SECRET_RE.lastIndex = 0;
    for (const m of src.matchAll(PY_SECRET_RE)) {
      const value = m[2];
      if (VALIDATION_RULE_VALUE_RE.test(value) || PLACEHOLDER_VALUE_RE.test(value)) continue;
      findings.push({
        rule: 'py-hardcoded-secret', severity: 'error', file: f, line: lineOf(m.index),
        message: `${f} 里 ${m[1]} 被写成字面量（值长度 ${value.length}）。`,
        why: '硬编码凭据会随仓库扩散且无法轮换：放进环境变量或密钥管理。',
        evidence: `name=${m[1]}, valueLen=${value.length}`,
      });
    }
  }

  // ── controller-shape rules now live in scripts/rules/php.mjs (declarative) ──
  // `isController` is a filename test, not a language test — the unbounded-query rule
  // has always keyed off it alone, which the module documents and the golden holds.
  const isController = /controller/i.test(file);
  const phpCtx = { file: f, f, src, lineOf, isPhp, isController, isRequestPath };
  findings.push(...runRules(PHP_RULES, phpCtx));

  // (the v-for/:key rule joined the Vue family in scripts/rules/vue.mjs — one call site,
  // further down, runs all four Vue rules)

  // ── language traps + AI-code smells (diff-local, content only) ─────────────
  // Grounded in the pitfall classes the 2024-2026 LLM-code studies report most
  // (API misuse / hallucinated libraries, leftover debug & TODO stubs, loose
  // typing, swallowed errors) plus the canonical language-level traps.
  const JS_OR_VUE = /\.(js|ts|mjs|cjs|vue)$/i.test(file);
  const commentSpans = [];
  const blanked = blankNonCode(src, { onComment: (start, end) => commentSpans.push([start, end]) });
  // Detection rules read `scannable`: template-literal contents are *other* code
  // (scripts and tests hold fixtures/rule tables there), so a Go `if rows == nil`
  // inside a template string must not be reported as a JS loose comparison. Binding
  // counting keeps `blanked` — identifiers are used inside `${…}` expressions, and
  // blanking those made every templated binding look unused.
  const scannable = blankTemplateLiterals(blanked);

  // ── PHP/JS language rules now live in scripts/rules/any.mjs (declarative) ───
  const isCli = /^#!/.test(src);
  const isCode = /\.(php|js|ts|mjs|cjs|jsx|tsx|vue|py)$/i.test(file);
  findings.push(...runRules(ANY_RULES, {
    file: f, src, scannable, lineOf, isCode, isJsOrVue: JS_OR_VUE, isCli,
  }));

  // ── stub markers now live in scripts/rules/stub.mjs (declarative) ──────────
  findings.push(...runRules(STUB_RULES, { file, f, src, lineOf, isCode, isPhp, commentSpans }));

  // ── Vue family now lives in scripts/rules/vue.mjs (declarative) ────────────
  findings.push(...runRules(VUE_RULES, { file, f, src, lineOf }));

  // ── JS/Vue dead bindings now live in scripts/rules/bindings.mjs ───────────
  findings.push(...runRules(BINDING_RULES, { f, src, blanked, lineOf, isJsOrVue: JS_OR_VUE }));

  // ── Go: rules now live in scripts/rules/index.mjs (declarative {id, run}) ───
  if (/\.go$/i.test(file)) findings.push(...runRules(GO_RULES, { file: f, src, lineOf }));

  return findings;
}

/**
 * AI-code hallucination checks — the class the 2024-2026 studies measure most
 * (8.1–40% of LLM answers use library features that do not exist). We can only
 * check what the index knows: local paths and the project's own dependency lists.
 */
export function hallucinationFindings(file, src, { indexedFiles, deps, psr4, pyDeps = null }) {
  const out = [];
  if (!src) return out;
  const f = norm(file);
  // Only code is scanned: a Markdown file (or a template string inside a script)
  // is prose *about* code, and treating it as an import/dependency source produced
  // false findings on this repo's own docs and fixture builders.
  const isCodeFile = /\.(js|ts|mjs|cjs|jsx|tsx|vue|py|php)$/i.test(f);
  if (!isCodeFile) return out;
  const isJsLike = /\.(js|ts|mjs|cjs|jsx|tsx|vue)$/i.test(f);
  const srcScan = isJsLike ? blankTemplateLiterals(src) : src;
  const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
  const lineOf = (idx) => src.slice(0, idx).split(/\r?\n/).length;
  const exists = (p) => indexedFiles.has(norm(p));
  const EXT = ['', '.js', '.ts', '.vue', '.json', '.mjs', '.cjs'];
  const INDEX = ['/index.js', '/index.ts', '/index.vue'];
  // Assets (.png/.css/.scss/…) never appear in a code index — treating them as
  // unresolved made 101 findings out of 20 real ones (measured on bench/vue-app).
  const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|bmp|ico|mp3|mp4|wav|avi|css|scss|sass|less|styl|ttf|woff2?|eot|otf|md|txt|html?)$/i;
  const tryResolve = (spec) => [...EXT.map((e) => `${spec}${e}`), ...INDEX.map((e) => `${spec}${e}`)].filter(exists);

  for (const m of srcScan.matchAll(/^[ \t]*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]|(?<![\w.])require\(\s*['"]([^'"]+)['"]\s*\)|(?<![\w.])import\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
    const spec = m[1] || m[2] || m[3];
    if (!spec) continue;
    if (ASSET_RE.test(spec)) continue; // images/styles/fonts are not code-index entries
    if (spec.startsWith('.')) {
      const base = joinPosix(dir, spec);
      if (!tryResolve(base).length) {
        out.push({
          rule: 'js-unresolved-local-import', severity: 'warn', file: f, line: lineOf(m.index),
          message: `${f} import 了 \`${spec}\`，但它解析不到索引里的任何文件。`,
          why: '本地路径写错/文件没建 = 构建期或运行期直接炸；AI 生成代码里这种"看起来合理但不存在的路径"很常见。',
          evidence: `specifier=${spec}, candidates tried=${EXT.length}`,
        });
      }
    } else if (spec.startsWith('@/') || spec.startsWith('~@/')) {
      const rest = spec.replace(/^~?@\//, '');
      if (!tryResolve(rest).length && !tryResolve(`${rest}/index`).length) {
        out.push({
          rule: 'js-unresolved-local-import', severity: 'warn', file: f, line: lineOf(m.index),
          message: `${f} 的别名 import \`${spec}\` 解析不到文件。`,
          why: 'uni-app 常省略 `/index.vue`：解析不到要么是路径写错，要么是别名没配（这是影响面扫描也会漏的地方）。',
          evidence: `specifier=${spec}`,
        });
      }
    } else if (deps && !deps.has(spec.split('/')[0].startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])) {
      const pkg = spec.split('/')[0].startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (['fs', 'path', 'os', 'crypto', 'url', 'util', 'http', 'https', 'child_process', 'node:fs', 'node:path', 'node:url', 'node:crypto', 'node:test', 'node:assert', 'node:child_process', 'node:process', 'assert'].includes(pkg)) continue;
      if (pkg.startsWith('node:')) continue;
      out.push({
        rule: 'hallucinated-dependency', severity: 'warn', file: f, line: lineOf(m.index),
        message: `${f} 依赖了 \`${pkg}\`，但它不在 package.json 的 dependencies/devDependencies 里。`,
        why: '幻觉依赖/漏加依赖：本地可能因提升的 node_modules 侥幸跑通，CI 或换机器就装不上（实测 LLM 答案里 8.1–40% 用到不存在的库特性）。',
        evidence: `package=${pkg}, declared=${deps.size}`,
      });
    }
  }

  if (/\.php$/i.test(f) && psr4) {
    for (const m of src.matchAll(/^\s*use\s+([A-Z][\w\\]+)\s*;/gm)) {
      const cls = m[1];
      if (!Object.keys(psr4).some((prefix) => cls.startsWith(prefix))) continue;
      const rel = cls.replace(/\\/g, '/') + '.php';
      const mapped = Object.entries(psr4).filter(([prefix]) => cls.startsWith(prefix))
        .map(([prefix, base]) => norm(`${base.replace(/\/$/, '')}/${cls.slice(prefix.length).replace(/\\/g, '/')}.php`));
      if (!mapped.some(exists)) {
        out.push({
          rule: 'php-unknown-class-import', severity: 'warn', file: f, line: lineOf(m.index),
          message: `${f} use 了 \`${cls}\`，但索引里没有对应文件（${mapped.join(', ')}）。`,
          why: 'PSR-4 命名空间与文件路径必须一一对应：AI 常"造"出合理的类名（Service/Helper/Request），本地没 autoload 到就是致命错误。',
          evidence: `class=${cls}, expected=${mapped[0] || rel}`,
        });
      }
    }
  }
  if (/\.py$/i.test(f)) {
    // relative imports: `from .mod import x` / `from ..pkg.mod import y`
    for (const m of src.matchAll(/^[ \t]*from[ \t]+(\.+)([\w.]*)[ \t]+import[ \t]+/gm)) {
      const dots = m[1].length;
      const mod = m[2];
      let base = dir;
      for (let i = 1; i < dots; i++) base = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
      const target = mod ? mod.replace(/\./g, '/') : '';
      const candidates = target
        ? [joinPosix(base, `${target}.py`), joinPosix(base, target, '__init__.py')]
        : [joinPosix(base, '__init__.py')];
      if (!candidates.some(exists)) {
        out.push({
          rule: 'py-unresolved-local-import', severity: 'warn', file: f, line: lineOf(m.index),
          message: `${f} 的相对 import \`from ${'.'.repeat(dots)}${mod} import …\` 找不到对应模块。`,
          why: '相对 import 写错层数或模块名（AI 生成代码里"看起来对"的包结构）在运行期直接 ImportError。',
          evidence: `tried: ${candidates.join(', ')}`,
        });
      }
    }
    // absolute imports: only judged when the project's dependencies are known
    for (const m of src.matchAll(/^[ \t]*(?:from|import)[ \t]+([A-Za-z_][\w.]*)/gm)) {
      const mod = m[1];
      const top = mod.split('.')[0];
      if (PY_STDLIB.has(top)) continue;
      const asPath = mod.replace(/\./g, '/');
      if ([...indexedFiles].some((p) => p === `${asPath}.py` || p.startsWith(`${asPath}/`))) continue;
      if (deps && deps.has(top)) continue;
      if (!pyDeps) continue; // no requirements.txt/pyproject → cannot judge, stay silent
      // declared names differ from import names (`python-dotenv` → `import dotenv`)
      if ([...pyDeps].some((d) => d === top || d.includes(top) || top.includes(d))) continue;
      out.push({
        rule: 'hallucinated-dependency', severity: 'warn', file: f, line: lineOf(m.index),
        message: `${f} 依赖了 \`${top}\`，但它既不在 requirements.txt/pyproject 里，也不是标准库。`,
        why: '幻觉依赖/漏加依赖：本地可能因为某个已装包侥幸跑通，CI 或换机器就 ImportError。',
        evidence: `module=${top}, declared=${pyDeps.size}`,
      });
    }
  }
  return out;
}

/**
 * Laravel Blade `{!! !!}` prints raw, unescaped HTML — the classic XSS hole in a
 * Blade view when the value can come from a request. One finding per file (with a
 * count) instead of one per occurrence.
 */
export function bladeRawOutputFindings(file, src) {
  if (!/\.blade\.php$/i.test(file)) return [];
  const matches = [...src.matchAll(/\{!!([\s\S]{0,300}?)!!\}/g)];
  if (!matches.length) return [];
  const first = matches[0];
  const line = src.slice(0, first.index).split(/\r?\n/).length;
  return [{
    rule: 'php-blade-unescaped-output', severity: 'warn', file: norm(file), line,
    message: `${file} 有 ${matches.length} 处 \`{!! !!}\` 原样输出：\`${first[0].replace(/\s+/g, ' ').slice(0, 60)}\``,
    why: '`{!! !!}` 不做转义（`{{ }}` 的反面）：只要内容可能来自用户/请求，就是 XSS。确认来源可信（富文本白名单），否则改用 `{{ }}`。',
    evidence: `occurrences=${matches.length}, first=@${line}`,
  }];
}

/** Count top-level arguments starting at the index of an opening paren. */
export function countArgs(src, openIdx) {
  let depth = 0;
  let count = 0;
  let sawContent = false;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') {
      // Content *inside* a nested literal is still content: `f({a: 1})` passes one
      // argument. Missing this made the rule report `orderPay({…})` as 0 args —
      // caught by checking the finding against the source.
      if (depth >= 1 && !/\s/.test(c)) sawContent = true;
      depth++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return sawContent ? count + 1 : 0;
      if (!/\s/.test(c)) sawContent = true;
      continue;
    }
    if (depth >= 1) {
      if (c === ',' && depth === 1) { count++; sawContent = true; continue; }
      if (!/\s/.test(c)) sawContent = true;
    }
  }
  return null; // unbalanced → do not guess
}

/** Required / total parameter counts from a `name(a, b = 1, ...rest)` signature. */
export function parseSignature(signature) {
  const s = String(signature || '');
  const open = s.indexOf('(');
  if (open === -1) return { required: null, total: null, variadic: false };
  const close = s.lastIndexOf(')');
  const inner = s.slice(open + 1, close === -1 ? s.length : close);
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of inner) {
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  const cleaned = parts.map((p) => p.trim()).filter(Boolean);
  const variadic = cleaned.some((p) => p.includes('...'));
  const required = cleaned.filter((p) => !p.includes('=') && !p.startsWith('?') && !p.includes('...')).length;
  return { required, total: cleaned.length, variadic };
}

/**
 * Call-site arity vs definition. Deliberately narrow, because every relaxation here
 * produces false positives:
 *   - only names with **exactly one** definition in the index (no dynamic dispatch);
 *   - never method calls (`->` / `.` / `::`), keywords, or definition sites;
 *   - JS/TS/Vue only: the PHP WASM parser flattens default values into the param list
 *     (`fetch($a,$b,$c,$d, 0)`), so "required" is unknowable there — the rule stays
 *     silent for `.php` rather than guessing.
 */
export function arityFindings(file, src, { symbols = [] } = {}) {
  const f = norm(file);
  if (!/\.(js|ts|mjs|cjs|jsx|tsx|vue)$/i.test(file)) return [];
  const out = [];
  const byName = new Map();
  for (const s of symbols) {
    if (!s || typeof s.name !== 'string') continue;
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'instanceof', 'new', 'await', 'else', 'do', 'constructor', 'super', 'delete', 'void', 'yield', 'in', 'of', 'case', 'with', 'throw']);
  // Measured noise control (333-file uni-app fixture: 144 findings without these):
  // vendored/minified trees define look-alike helpers (makeMap, B, …) that shadow
  // the app's own names, and one- and two-letter names are minified identifiers.
  const VENDORED = /(^|\/)(plugin|vendor|node_modules|uni_modules|dist|static|libs?)\//i;
  if (VENDORED.test(f) || /\.min\.[cm]?js$/i.test(f)) return [];
  const scrubbed = blankTemplateLiterals(blankLiterals(src));
  for (const m of scrubbed.matchAll(/(?<![\w.$>])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    const defs = byName.get(name);
    if (!defs || defs.length !== 1) continue;
    if (name.length < 3) continue;                                  // minified identifier
    if (VENDORED.test(norm(defs[0].file))) continue;                // definition is vendored code
    const before = src.slice(Math.max(0, m.index - 20), m.index);
    if (/(?:function|=>)\s*$/.test(before)) continue;          // definition site
    if (/(?:->|\.|::)\s*$/.test(before)) continue;             // method / property call
    const argCount = countArgs(scrubbed, m.index + m[0].length - 1);
    if (argCount === null) continue;
    const def = defs[0];
    // A non-exported symbol is local to its own file: a local `key()`/`spawnImpl()`
    // in another file is not this call's callee (that produced cross-file arity
    // findings on test helpers). Only when the index actually knows `exported === false`
    // — an index without export info must keep the old behaviour.
    if (def.exported === false && norm(def.file) !== f) continue;
    const { required, total, variadic } = parseSignature(def.signature);
    if (required === null || !total) continue;
    const line = src.slice(0, m.index).split(/\r?\n/).length;
    if (argCount < required) {
      out.push({
        rule: 'arity-mismatch', severity: 'warn', file: f, line,
        message: `${f}:${line} 调用 ${name}(${argCount} 个参数)，而 ${norm(def.file)} 的定义至少需要 ${required} 个（共 ${total}）。`,
        why: '少传必填参数：JS 里会变成 undefined（悄悄算错，或在更深的地方炸）。',
        evidence: `call=${name}(${argCount}), required=${required}, total=${total}, def=${norm(def.file)}:${def.line_start ?? '?'}`,
      });
    } else if (!variadic && argCount > total) {
      out.push({
        rule: 'arity-mismatch', severity: 'info', file: f, line,
        message: `${f}:${line} 调用 ${name}(${argCount} 个参数)，而定义只有 ${total} 个。`,
        why: '多传参数通常无害（被忽略），但常说明调用的是"记忆里的另一个签名"——AI 生成代码里很常见。',
        evidence: `call=${name}(${argCount}), total=${total}, def=${norm(def.file)}`,
      });
    }
  }
  return out;
}

/**
 * Taint, intra-file: an external input assigned to a variable, then that variable
 * reaching a dangerous sink without a sanitiser on the way.
 *
 * Boundary (deliberate, and printed in the finding's why): this is name-based and
 * file-local. It does not follow the value across function calls, does not model
 * framework validation, and does not know your custom escaper — so it reports only
 * the shapes where the source and the sink are visible in the same file. For real
 * interprocedural taint use `--semgrep` (Semgrep taint mode) if it is installed.
 */
const TAINT = {
  php: {
    source: /\$\w+\s*=\s*(?:\$request->(?:input|get|post|query|all|json)\s*\(|\$_GET|\$_POST|\$_REQUEST|\$request->\w+)/g,
    sinks: [
      { re: /\b(?:echo|print)\b[^;]*/, kind: 'output' },
      { re: /(?:whereRaw|selectRaw|orderByRaw|DB::raw)\s*\([^;]*/, kind: 'sql' },
      { re: /\b(?:exec|shell_exec|system|eval)\s*\([^;]*/, kind: 'exec' },
    ],
    sanitizers: /(htmlspecialchars|\be\s*\(|intval\s*\(|filter_var\s*\(|\(int\)|strip_tags\s*\(|\bas\s+\$\w+\s*->\s*\w+|validate\s*\()/,
  },
  js: {
    source: /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*(?:req\.(?:query|body|params)|request\.(?:query|body|params)|location\.(?:search|hash)|uni\.getStorageSync)/g,
    sinks: [
      { re: /\.innerHTML\s*=[^;]*/, kind: 'output' },
      { re: /\bdocument\.write\s*\([^;]*/, kind: 'output' },
      { re: /v-html\s*=\s*["'][^"']*["']/, kind: 'output' },
      { re: /\b(?:eval|new\s+Function)\s*\([^;]*/, kind: 'exec' },
    ],
    sanitizers: /(encodeURIComponent|escapeHtml|\bNumber\s*\(|parseInt\s*\(|parseFloat\s*\(|textContent\s*=)/,
  },
  python: {
    source: /(\w+)\s*=\s*[^\n#]*(?:request\.(?:args|form|json|values|get_json)|\binput\s*\()/g,
    sinks: [
      { re: /\.execute\s*\([^\n]*/, kind: 'sql' },
      { re: /\b(?:eval|exec)\s*\([^\n]*/, kind: 'exec' },
      { re: /\bos\.system\s*\([^\n]*|subprocess\.[\w_]+\([^\n]*shell\s*=\s*True/, kind: 'exec' },
      { re: /render_template_string\s*\([^\n]*/, kind: 'output' },
    ],
    sanitizers: /(html\.escape|\bint\s*\(|float\s*\(|escape\s*\(|quote\s*\()/,
  },
};

export function taintFindings(file, src) {
  const f = norm(file);
  const lang = /\.php$/i.test(f) ? 'php' : /\.(js|ts|mjs|cjs|jsx|tsx|vue)$/i.test(f) ? 'js' : /\.py$/i.test(f) ? 'python' : null;
  if (!lang) return [];
  const cfg = TAINT[lang];
  const lines = src.split(/\r?\n/);
  const tainted = new Map(); // variable → source line
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    cfg.source.lastIndex = 0;
    for (const m of line.matchAll(cfg.source)) {
      const name = lang === 'php' ? (m[0].match(/^(\$\w+)/)?.[1] || 'request') : m[1];
      if (name) tainted.set(name, i + 1);
    }
    if (!tainted.size) continue;
    if (cfg.sanitizers.test(line)) continue;      // sanitised on the way to the sink
    for (const sink of cfg.sinks) {
      if (!sink.re.test(line)) continue;
      for (const [name, srcLine] of tainted) {
        if (!new RegExp(`(^|[^\\w$])${name.replace(/\$/g, '\\$')}([^\\w$]|$)`).test(line)) continue;
        out.push({
          rule: 'taint-source-to-sink',
          severity: sink.kind === 'exec' ? 'error' : 'warn',
          file: f, line: i + 1,
          message: `${f}:${i + 1} 外部输入（第 ${srcLine} 行的 ${name}）直达 ${sink.kind} sink：\`${line.trim().slice(0, 60)}\``,
          why: '文件内可见的 source→sink 直达：参数来自请求且没有转义/强转。exec 类 sink 直接是 RCE，sql/output 类是注入/XSS。此规则只做**文件内、按变量名**的追踪（不跨函数、不认自定义转义函数），跨函数的数据流要上 Semgrep taint。',
          evidence: `source=${name}@${srcLine} → sink=${sink.kind}@${i + 1}`,
        });
        break;
      }
    }
  }
  return out;
}

export function reviewFindings({ changes, index, readFile, backendIndex = null, boundary = null, tier = 'all' }) {
  const findings = [];
  const read = readFile || ((rel) => {
    try { return fs.readFileSync(rel, 'utf8'); } catch { return null; }
  });
  const add = (f) => findings.push(f);

  const changedFiles = (changes.changed_files || []).map((r) => norm(r.file));
  // corpus = every indexed file, not a diff: rules that describe *this change* have no
  // meaning there (nothing "changed"), while the per-file content rules are the point.
  const corpusMode = changes.scope === 'corpus';
  const changedSymbols = changes.changed_symbols || [];
  const impacted = changes.impacted || [];
  const kg = index?.knowledgeGraph || {};
  const edges = kg.edges || [];
  const symbols = index?.symbols || [];

  // ── index-derived facts ────────────────────────────────────────────────────
  const registeredPages = new Set(
    edges.filter((e) => norm(e.from).startsWith('page:') && norm(e.to).startsWith('file:'))
      .map((e) => norm(e.to).slice(5))
  );
  const inboundComponents = new Set(
    edges.filter((e) => norm(e.from).startsWith('file:') && norm(e.to).startsWith('file:'))
      .map((e) => norm(e.to).slice(5))
  );
  const defsByName = new Map();
  const exportedByName = new Map();
  const exportedAt = new Set();
  for (const s of symbols) {
    const k = s.name;
    if (!defsByName.has(k)) defsByName.set(k, []);
    defsByName.get(k).push(norm(s.file));
    if (s.exported) {
      exportedByName.set(k, (exportedByName.get(k) || 0) + 1);
      exportedAt.add(`${k}@${norm(s.file)}`);
    }
  }
  // Same-name is only real ambiguity when the *exported* definitions collide: every
  // script here has its own local `parseArgs`/`main`/`norm`, and flagging those
  // buried the real cases (measured: 11 findings, ~2 of them meaningful).
  const hasExportInfo = symbols.some((s) => typeof s.exported === 'boolean');
  const ambiguous = (name) => defsByName.get(name)?.length >= 2 && (!hasExportInfo || (exportedByName.get(name) || 0) >= 2);
  // Names another file actually imports. Two definitions of a name nobody imports
  // cannot make `locate`/`impact` pick the wrong one, so it is not a review risk:
  // every CLI script here defines its own `parseArgs`/`renderMarkdown` (measured:
  // 9 and 3 definitions, 0 importers). The PHP path keeps the old behaviour —
  // controllers are reached through routes, not imports.
  const importedNames = new Set();
  for (const s of symbols) {
    for (const imp of (s.imports || [])) {
      for (const spec of (imp.specifiers || [])) {
        const local = String(spec).split(/\s+as\s+/).pop().trim();
        if (local) importedNames.add(local);
      }
    }
  }
  const usedAcrossFiles = (name) => importedNames.has(name);
  const classFile = new Map();
  for (const s of symbols) if ((s.kind || '').includes('class') || /^[A-Z]/.test(s.name || '')) {
    if (!classFile.has(s.name)) classFile.set(s.name, norm(s.file));
  }
  const unresolvedRoutes = index?.unresolvedRoutes || [];
  const unresolvedPages = index?.unresolvedPages || [];

  // ── PHP: resource route with a bound parameter and no visible authorization ─
  // This is a *prompt*, not a verdict: authorization can live in middleware or a
  // policy the file does not mention, so it reports only when the changed set
  // touches the controller of a parameterised route and none of the common checks
  // appear in that file. Severity is info for exactly that reason.
  const AUTH_HINTS = /(\$this->authorize\s*\(|Gate::|->can\s*\(|->cannot\s*\(|->policy\s*\(|abort_unless\s*\(|->where\(\s*['"]user_id|auth\(\)->id\(\)|Auth::id\(\)|\$request->user\(\)->id)/;
  for (const route of (kg.nodes || [])) {
    const id = String(route.id || '');
    if (!id.startsWith('route:')) continue;
    const uri = String(route.uri || '');
    if (!/[{:]\w+/.test(uri)) continue;                       // no bound parameter
    const ctrlFile = route.controller ? classFile.get(route.controller) : null;
    if (!ctrlFile || !changedFiles.includes(norm(ctrlFile))) continue;
    const src = read(norm(ctrlFile));
    if (!src || AUTH_HINTS.test(src)) continue;
    add({
      rule: 'php-idor-missing-authorization', severity: 'info', file: norm(ctrlFile), line: route.line ?? null,
      message: `${route.method || 'GET'} ${uri} 绑定参数，而 ${norm(ctrlFile)} 里看不到鉴权调用。`,
      why: '带 {id} 的资源路由若只按 id 取数据，换个 id 就能读别人的记录（IDOR）——这是 Laravel 生产环境最常见的漏洞。此条是**复核项**：鉴权也可能在中间件/策略里，请人工确认这一条路由的授权链。',
      evidence: `route=${route.method || 'GET'} ${uri}, controller=${route.controller || '?'}, checked=${norm(ctrlFile)}（无 authorize/Gate/policy/abort_unless/owner-check）`,
    });
  }

  // ── cross-cutting ──────────────────────────────────────────────────────────
  if (index && symbols.length && !Object.keys(index.layerMap || {}).length) {
    add({
      rule: 'layer-model-missing', severity: 'info', file: null, line: null,
      message: `索引里没有任何符号被分到架构层（layerMap 空）——\`impact\` 的 Layer 恒为 null，architecture.violations 恒为 0。`,
      why: '分层模式目录名大小写不匹配时（Laravel 的 app/Http/Controllers、app/Models）符号不会入层；把"violations 为 0"当通过证据是错的。',
      evidence: `symbols=${symbols.length}, layerMap=0`,
    });
  }
  // Files with no symbol of their own split in two: a *code* file that the index
  // failed to map is a real gap (parser miss, new file, ignore pattern — go look),
  // while docs/config/assets never have symbols and cannot have line-level evidence.
  // Reporting those per file trained reviewers to ignore the rule (7 of 25 findings
  // in the self-review were README/docs/package.json).
  const NON_CODE_FILE_RE = /\.(md|markdown|txt|rst|json|jsonc|ya?ml|toml|ini|cfg|conf|lock|css|scss|sass|less|html?|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|eot|map|env|example|editorconfig|gitignore|sh|bash|bat|ps1)$/i;
  const unmappedCode = [];
  const unmappedOther = [];
  for (const file of changedFiles) {
    if (symbols.some((s) => norm(s.file) === file)) continue;
    (NON_CODE_FILE_RE.test(file) ? unmappedOther : unmappedCode).push(file);
    if (BACKUP_RE.test(path.basename(file))) {
      add({
        rule: 'backup-file-changed', severity: 'warn', file, line: null,
        message: '改动的文件看起来是备份/副本文件。',
        why: '仓库里同时存在日期备份与正本时，很容易改到副本（本 fixture 里 app/Http/Controllers/HomeController - 副本.php 与 views/home/index.blade.20211102.php 都被索引了）。',
        evidence: `basename=${path.basename(file)}`,
      });
    }
  }
  for (const file of unmappedCode) {
    if (corpusMode) continue;   // "this change touched an unmapped file" needs a change
    add({
      rule: 'unmapped-change', severity: 'warn', file, line: null,
      message: '改动的代码文件在索引里没有任何符号——行级证据不可用。',
      why: '代码文件理应有符号：索引不到说明解析失败、是新文件没进索引，或被 --ignore 排除了。这类改动无法用图谱判断影响面，必须人工读。',
      evidence: 'changed code file not present in index.symbols',
    });
  }
  if (unmappedOther.length && !corpusMode) {
    add({
      rule: 'unmapped-change', severity: 'info', file: null, line: null,
      message: `${unmappedOther.length} 个非代码文件（文档/配置/资源）改动，没有符号可定位。`,
      why: '文档、配置、静态资源本来就没有符号：这一条只是提醒"这些文件的行级影响面算不出来"，不是缺陷。',
      evidence: `files: ${unmappedOther.slice(0, 8).join(', ')}${unmappedOther.length > 8 ? ` … +${unmappedOther.length - 8}` : ''}`,
    });
  }
  const sel = selectTests(changes);
  // One finding per file: a class symbol plus its methods would otherwise flood
  // the report (a 1-line edit inside a class reports every sibling method).
  const uncoveredByFile = new Map();
  for (const s of sel.uncovered_symbols) {
    if (!uncoveredByFile.has(s.file)) uncoveredByFile.set(s.file, []);
    uncoveredByFile.get(s.file).push(s);
  }
  // A repo with no indexed test files at all cannot be judged by coverage — say
  // that once instead of emitting a warning per changed symbol (the common case
  // for the Laravel/uni-app repos this was built for).
  const anyIndexedTest = symbols.some((s) => /(^|\/)(__tests__|tests?|spec|e2e)\//i.test(norm(s.file)) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(norm(s.file)));
  if (!anyIndexedTest && uncoveredByFile.size) {
    add({
      rule: 'repo-has-no-tests', severity: 'info', file: null, line: null,
      message: `索引里没有任何测试文件（${uncoveredByFile.size} 个改动文件因此都"无覆盖"）。`,
      why: '这张报告里 no-test-coverage 一律不适用；真正的问题是这个仓库没有测试基线，图谱只能给影响面。',
      evidence: 'indexed test files = 0',
    });
  } else {
    for (const [file, syms] of uncoveredByFile) {
      // Coverage is judged on the addressable surface: an inner helper (`blank`,
      // `bump`, a nested `runner`) has no inbound edge of its own and is exercised
      // through its caller, and `main` is a CLI entry point (e2e, not unit tests).
      // Counting them produced one "uncovered" row per script even when every
      // exported function in it was tested.
      const mainOnly = (s) => s.symbol === 'main';
      const surface = hasExportInfo
        ? syms.filter((s) => !mainOnly(s) && exportedAt.has(`${s.symbol}@${norm(s.file)}`))
        : syms.filter((s) => !mainOnly(s));
      if (!surface.length) continue;
      add({
        rule: 'no-test-coverage', severity: 'warn', file,
        line: surface[0].line_start,
        message: `${surface.length} 个改动符号没有任何测试经图谱可达：${surface.slice(0, 5).map((s) => s.symbol).join(', ')}${surface.length > 5 ? ` … +${surface.length - 5}` : ''}`,
        why: '改了核心符号却零覆盖，回归只能靠人肉；CI 里用 scripts/test-select.mjs --gate 卡住。',
        evidence: `symbols=${surface.length}, tests reaching them=0${syms.length > surface.length ? `, internals skipped=${syms.length - surface.length}` : ''}`,
      });
    }
  }
  // Same-name rules: one finding per (rule, name) — a whole-file change (new file)
  // makes every symbol in it "changed", which otherwise produced 177 findings.
  const seenSameName = new Set();
  for (const r of impacted) {
    if (r.kind !== 'symbol') continue;
    const n = r.symbol || '';
    const defs = defsByName.get(n) || [];
    if (!ambiguous(n) || LIFECYCLE_NAME_RE.test(n)) continue;
    const lang = norm(r.file).endsWith('.php') ? 'php' : null;
    const id = lang === 'php' ? 'php-same-name-method' : 'js-same-name-method';
    if (id === 'js-same-name-method' && !usedAcrossFiles(n)) continue;
    if (seenSameName.has(`${id}:${n}`)) continue;
    seenSameName.add(`${id}:${n}`);
    add({
      rule: id, severity: 'warn', file: norm(r.file), line: r.line,
      message: `${n} 在索引里有 ${defs.length} 个定义，受影响的是这一处：${norm(r.file)}:${r.line}。`,
      why: '同名方法（PHP 的 index/store/__construct，Vue 的 onLoad/data，api/order.js 与 api/activity.js 的 orderTake）会让 locate/callers/impact 命中错误的定义，必须带 --file 消歧后再改。',
      evidence: `defs: ${defs.slice(0, 4).join(', ')}${defs.length > 4 ? ` … +${defs.length - 4}` : ''}`,
    });
  }
  for (const s of changedSymbols) {
    const defs = defsByName.get(s.symbol) || [];
    if (!ambiguous(s.symbol) || LIFECYCLE_NAME_RE.test(s.symbol)) continue;
    const isPhp = norm(s.file).endsWith('.php');
    const id = isPhp ? 'php-same-name-method' : 'js-same-name-method';
    if (id === 'js-same-name-method' && !usedAcrossFiles(s.symbol)) continue;
    if (seenSameName.has(`${id}:${s.symbol}`)) continue;
    seenSameName.add(`${id}:${s.symbol}`);
    add({
      rule: id, severity: 'warn', file: norm(s.file), line: s.line_start,
      message: `改动的 ${s.symbol} 有 ${defs.length} 个同名定义。`,
      why: '同名符号是改错文件的第一大来源；先 --file 确认，再看 callers 是否只落到这一处。',
      evidence: `defs: ${defs.slice(0, 4).join(', ')}`,
    });
  }

  // ── PHP / Laravel ──────────────────────────────────────────────────────────
  const changedPhp = changedFiles.filter((f) => f.endsWith('.php'));
  for (const route of unresolvedRoutes) {
    const ctrlFile = classFile.get(route.controller) || null;
    const relevant = changedPhp.includes(norm(route.file)) || (ctrlFile && changedPhp.includes(ctrlFile));
    if (!relevant) continue;
    add({
      rule: 'php-route-unknown-action', severity: 'error', file: norm(route.file), line: route.line ?? null,
      message: `${route.method} ${route.uri} → ${route.controller}::${route.action} 解析不到对应方法（${route.reason}），改动涉及这条路由。`,
      why: '路由指向不存在的方法就是 404。改控制器方法名/删方法时最容易漏掉 routes/*.php 里的这一条。',
      evidence: `index.unresolvedRoutes 命中 ${route.controller}::${route.action}`,
    });
  }
  for (const file of changedPhp) {
    const src = read(file);
    if (!src) continue;
    if (/extends\s+Model\b/.test(src) && !/\$(fillable|guarded)\b/.test(src)) {
      add({
        rule: 'php-mass-assignment', severity: 'warn', file, line: null,
        message: '改动的是 Eloquent Model，但类里既没有 $fillable 也没有 $guarded。',
        why: 'Laravel 里缺这两个属性时 create()/update($request->all()) 会被批量赋值，任何人都能写任意字段。',
        evidence: 'extends Model && !$fillable && !$guarded',
      });
    }
    if (/\.blade\.php$/.test(file)) {
      const calls = (src.match(/\$[A-Za-z_][\w$]*\s*->\s*[A-Za-z_]\w*\s*\(/g) || []).length;
      const bound = edges.filter((e) => norm(e.from).startsWith('file:') && norm(e.from).slice(5) === file && (e.source_kind === 'template' || e.source_kind === 'ast')).length;
      if (calls > bound) {
        add({
          rule: 'php-blade-unverified-calls', severity: 'info', file, line: null,
          message: `Blade 里有 ${calls} 处 \`$x->y()\` 调用，图谱只绑定上 ${bound} 处。`,
          why: '模板调用只能靠变量名推断（$departmentPresenter → DepartmentPresenter），大多数（实测 343 处里 295 处）解不到具体类，所以"模板里没人调用我"不能作为删方法的安全证据。',
          evidence: `template calls=${calls}, bound edges=${bound}`,
        });
      }
    }
  }

  // ── Vue / uni-app ──────────────────────────────────────────────────────────
  const perFilePages = new Map();
  for (const u of unresolvedPages) {
    const f = norm(u.file);
    if (!perFilePages.has(f)) perFilePages.set(f, []);
    perFilePages.get(f).push(u);
  }
  for (const file of changedFiles) {
    if (!file.endsWith('.vue')) continue;
    const isPageDir = /(^|\/)pages\//.test(file);
    const isUnderComponents = /(^|\/)components\//.test(file);
    if (isPageDir && !isUnderComponents && !registeredPages.has(file)) {
      add({
        rule: 'vue-page-not-registered', severity: 'error', file, line: null,
        message: '这个页面目录下的 .vue 没有出现在 pages.json 的任何页面条目里。',
        why: 'uni-app 只打包 pages.json 注册过的页面：改了它不会有任何效果，别人 navigateTo 过去也是 404（本 fixture 实测 178 个 pages/**/*.vue 里有 52 个未注册）。',
        evidence: `registered pages=${registeredPages.size}`,
      });
    }
    if (isUnderComponents && !inboundComponents.has(file)) {
      add({
        rule: 'vue-component-orphan', severity: 'warn', file, line: null,
        message: '组件在索引里没有任何文件 import 它。',
        why: '死组件：改了不生效，也别指望 impact 能告诉你影响面（本 fixture 实测 50 个 components/*.vue 里 4 个是孤儿）。',
        evidence: 'no inbound file→file edge',
      });
    }
  }
  for (const [file, rows] of perFilePages) {
    if (!changedFiles.includes(file)) continue;
    const dynamic = rows.filter((r) => r.reason === 'dynamic-url');
    const unknown = rows.filter((r) => r.reason === 'unknown-page');
    const unimp = rows.filter((r) => r.reason === 'unresolved-import');
    if (unknown.length) {
      add({
        rule: 'vue-nav-unknown-page', severity: 'error', file, line: unknown[0].line ?? null,
        message: `${unknown.length} 处跳转的目标页面不存在：${unknown.slice(0, 3).map((r) => `${r.via} → ${r.target}`).join('; ')}`,
        why: 'navigateTo 到未注册/不存在的页面是运行时 404；改页面路径时最容易漏。',
        evidence: `unresolvedPages reason=unknown-page ×${unknown.length}`,
      });
    }
    if (unimp.length) {
      add({
        rule: 'vue-unresolved-import', severity: 'warn', file, line: unimp[0].line ?? null,
        message: `${unimp.length} 处 import 解析不到目标文件。`,
        why: '别名/省略 /index.vue 的写法会让组件影响面扫不到（$@/components/payment$ 这种省略 index.vue 的引用要两种名字都试）。',
        evidence: `unresolvedPages reason=unresolved-import ×${unimp.length}`,
      });
    }
    if (dynamic.length) {
      add({
        rule: 'vue-nav-dynamic-url', severity: 'info', file, line: dynamic[0].line ?? null,
        message: `${dynamic.length} 处跳转的目标是动态拼接的 URL，静态解析不了。`,
        why: '**审核边界**：动态 url 的入口页面无法静态确定，图谱给不出该页面的上游；这类改动必须人工确认调用方（本 fixture 有 124 处）。',
        evidence: `unresolvedPages reason=dynamic-url ×${dynamic.length}`,
      });
    }
  }
  for (const file of changedFiles) {
    if (/(^|\/)(store|mixins)\//.test(file)) {
      add({
        rule: 'vue-global-blast', severity: 'info', file, line: null,
        message: '改动在 store/ 或 mixins/ 下，影响面通常是全局的（本次图谱统计受影响符号 ' + impacted.filter((r) => r.kind === 'symbol').length + ' 个）。',
        why: 'mixin/store 被多页面复用，改一行可能波及几十个页面；单看 callers 容易低估。',
        evidence: `impacted symbols=${impacted.filter((r) => r.kind === 'symbol').length}`,
      });
    }
  }

  // ── security / performance: content of the changed files ───────────────────
  for (const file of changedFiles) {
    const src = read(file);
    if (!src) continue;
    findings.push(...scanContent(file, src));
    findings.push(...bladeRawOutputFindings(file, src));
    findings.push(...arityFindings(file, src, { symbols }));
    findings.push(...taintFindings(file, src));
  }

  // ── AI-code hallucinations: imports that resolve to nothing ────────────────
  const indexedFiles = new Set(symbols.map((s) => norm(s.file)));
  for (const n of (kg.nodes || [])) {
    const id = norm(n.id);
    if (id.startsWith('file:')) indexedFiles.add(id.slice(5));
  }
  const deps = new Set();
  const pkgSrc = read('package.json');
  if (pkgSrc) {
    try {
      const pkg = JSON.parse(pkgSrc);
      for (const k of Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) })) deps.add(k);
    } catch { /* malformed package.json: skip the dependency check, don't guess */ }
  }
  let psr4 = null;
  const composerSrc = read('composer.json');
  if (composerSrc) {
    try {
      const c = JSON.parse(composerSrc);
      const map = ((c.autoload || {})['psr-4']) || {};
      if (Object.keys(map).length) psr4 = map;
    } catch { /* malformed composer.json: skip */ }
  }
  let pyDeps = null;
  const reqSrc = read('requirements.txt');
  const pyprojSrc = read('pyproject.toml');
  if (reqSrc || pyprojSrc) {
    const set = new Set();
    if (reqSrc) {
      for (const line of reqSrc.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#') || t.startsWith('-')) continue;
        const m = /^([A-Za-z_][\w.-]*)/.exec(t);
        if (m) set.add(m[1].toLowerCase().replace(/-/g, '_'));
      }
    }
    if (pyprojSrc) {
      for (const m of pyprojSrc.matchAll(/^\s*"?([A-Za-z_][\w.-]*)"?\s*[<>=~!\[]/gm)) set.add(m[1].toLowerCase().replace(/-/g, '_'));
    }
    if (set.size) pyDeps = set;
  }
  for (const file of changedFiles) {
    const src = read(file);
    if (!src) continue;
    findings.push(...hallucinationFindings(file, src, { indexedFiles, deps: deps.size ? deps : null, psr4, pyDeps }));
  }

  // ── front-end / back-end boundary (needs the other repo's index) ───────────
  if (backendIndex) {
    const frontFiles = changedFiles.filter((f) => /\.(js|vue|ts)$/.test(f));
    const calls = extractFrontCalls(frontFiles, read);
    const routes = backendRoutes(backendIndex);
    if (calls.length && routes.length) {
      const cmp = compareBoundary(calls, routes, boundary?.pairingFloor ? { pairingFloor: boundary.pairingFloor } : {});
      if (cmp.pairSuspect) {
        add({
          rule: 'fe-be-pairing-suspect', severity: 'warn', file: null, line: null,
          message: `前后端匹配率只有 ${(cmp.matchRate * 100).toFixed(1)}%（${calls.length} 个前端调用 vs ${routes.length} 条后端路由）——这两个索引很可能不是同一对前后端。`,
          why: '**边界前置校验**：先把"两边是不是一套系统"验掉，再谈逐条接口核对；否则会产出"缺几百个接口"的假报告（本 fixture 就是两个不同应用：CRMEB 商城前端 vs 医院后台）。',
          evidence: `matchRate=${(cmp.matchRate * 100).toFixed(1)}% < floor=${(cmp.pairingFloor * 100).toFixed(0)}%；示例前端路径 ${uniquePathsSample(calls)}`,
        });
      } else {
        for (const c of cmp.missing.slice(0, 10)) {
          add({
            rule: 'fe-be-path-not-found', severity: 'error', file: c.file, line: null,
            message: `前端 ${c.method} ${c.path} 在后端路由表里找不到对应路由。`,
            why: '这是前后端边界上最贵的错：前端能编译、能打包，运行时才 404。改接口路径/前缀时必然出现。',
            evidence: `front call: ${c.file} · ${c.path}; backend routes: ${routes.length}`,
          });
        }
        for (const m of cmp.methodMismatch.slice(0, 10)) {
          add({
            rule: 'fe-be-method-mismatch', severity: 'error', file: m.call.file, line: null,
            message: `前端用 ${m.call.method} ${m.call.path}，后端同路径只有 ${m.routes.map((r) => r.method).join('/')}（${m.routes.map((r) => `${r.file}:${r.line}`).join(', ')}）。`,
            why: '路径对、方法错是最难查的一类 404/405：IDE 跳转正常、抓包才看出来。',
            evidence: `backend methods: ${m.routes.map((r) => `${r.method} ${r.uri}`).join(' | ')}`,
          });
        }
        for (const r of cmp.unused.slice(0, 5)) {
          add({
            rule: 'fe-be-route-unused', severity: 'info', file: r.file, line: r.line,
            message: `后端路由 ${r.method} ${r.uri} 本次改动的前端文件里没有任何调用。`,
            why: '反向边界：改后端接口时先确认谁在调（可能是别的端：小程序/H5/后台），别按"前端没调"就删。',
            evidence: `unused routes in this change set: ${cmp.unused.length} of ${routes.length}`,
          });
        }
      }
      if (cmp.dynamic.length) {
        add({
          rule: 'fe-dynamic-request-path', severity: 'info', file: cmp.dynamic[0].file, line: null,
          message: `${cmp.dynamic.length} 处请求路径是动态拼接的（如 request.get('x/' + id)），边界无法静态核对。`,
          why: '**边界盲区**：拼接路径只能人工确认；这类调用最容易把参数拼错成不存在的路由。',
          evidence: `sample: ${cmp.dynamic.slice(0, 3).map((c) => `${c.method} ${c.path}+…`).join('; ')}`,
        });
      }
    }
  }

  // tier: `brief` mode keeps only the high-signal rules (a legacy repo makes the
  // extended ones fire on half the files, which is noise, not a review finding).
  const kept = tier === 'core' ? findings.filter((f) => !EXTENDED_RULES.has(f.rule)) : findings;
  kept.sort((a, b) => {
    const sev = { error: 0, warn: 1, info: 2 };
    return (sev[a.severity] - sev[b.severity]) || String(a.file).localeCompare(String(b.file)) || (a.line ?? 0) - (b.line ?? 0);
  });
  return kept;
}

const ICON = { error: '⛔', warn: '⚠️ ', info: 'ℹ️ ' };

/**
 * Rule tiers + mode presets. `brief` is the default so a routine change costs a
 * few hundred tokens instead of the full task sheet; context/noise rules stay
 * behind `--mode standard|deep` (measured: `js-loose-equality` fires on 160/333
 * files of a legacy repo — that is not a signal, it is weather).
 */
export const EXTENDED_RULES = new Set([
  'php-loose-comparison',        // 34/286 files fire
  'php-blade-unverified-calls',  // evidence caveat, not a defect
  'js-loose-equality',           // 160/333 files fire
  'js-debug-left-on',            // 23/333 files fire
  'vue-global-blast',            // context
  'vue-nav-dynamic-url',         // boundary note
  'py-import-star',              // style, not a defect
]);

export const MODE_PRESETS = {
  brief: { tier: 'core', checklist: false, impact: false, deep: false, duplication: false, dupKinds: [], compact: true },
  standard: { tier: 'all', checklist: true, impact: true, deep: false, duplication: true, dupKinds: ['renamed', 'similar'], compact: false },
  deep: { tier: 'all', checklist: true, impact: true, deep: true, duplication: true, dupKinds: ['renamed', 'similar', 'gap'], compact: false, audit: true },
  // `deep` also audits dependencies (OSV over HTTP): repo-level mode is the one that
  // runs periodically, not per commit — a network hiccup shows up as a na row, never
  // as a failed build.
};

export function applyMode(opts) {
  const preset = MODE_PRESETS[opts.mode] || MODE_PRESETS.brief;
  const anyAnalysisFlag = Boolean(opts.impactFlag || opts.deepFlag || opts.duplicationFlag);
  const out = { ...opts };
  // explicit --all-rules must win over the preset tier (same failure mode as --compact:
  // the preset assignment below runs after arg parsing, so without the flag it is a no-op)
  out.tier = opts.allRulesFlag ? 'all' : preset.tier;
  out.impact = opts.impactFlag || (preset.impact && !opts.duplicationOnly);
  out.deep = opts.deepFlag || preset.deep;
  out.duplication = opts.duplicationFlag || preset.duplication;
  // null = follow the preset (deep audits); explicit --audit / --no-audit wins
  out.audit = opts.auditFlag === null || opts.auditFlag === undefined ? Boolean(preset.audit) : Boolean(opts.auditFlag);
  // an explicit analysis flag implies at least `standard` output: asking for the
  // analysis and then hiding the sheet would be surprising
  out.checklist = opts.checklistFlag !== null ? opts.checklistFlag : (preset.checklist || anyAnalysisFlag);
  if (!opts.dupKindsFlag && !out.dupKinds.length) out.dupKinds = preset.dupKinds;
  if (opts.compactFlag === null) out.compact = preset.compact;
  // explicit --no-compact must win over the brief default (line above only follows the
  // preset when the flag is absent, so without this `--no-compact` could never turn
  // compact off — `--json` then emitted the compact summary with no checklist/why/evidence).
  else out.compact = Boolean(opts.compactFlag);
  return out;
}

/**
 * Harness manifest — the "what was the harness" half of an evaluation record.
 *
 * A review result is only comparable if the thing that produced it is named:
 * preset, rule tier, the knob values the preset resolved to, the enabled rule
 * set (digest), and the index it ran against. Without this block two runs cannot
 * be attributed to two harnesses, so a before/after comparison has no evidence
 * chain — that was the `review.json` gap `scripts/probe.mjs` needs closed.
 * Deliberately model-free: the review layer never calls a model.
 */
export function rulesetDigest(tier) {
  const enabled = tier === 'core'
    ? RULE_REGISTRY.filter((r) => !EXTENDED_RULES.has(r.id))
    : RULE_REGISTRY;
  const ids = enabled.map((r) => r.id).sort();
  return {
    digest: crypto.createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16),
    enabled: ids.length,
  };
}

export function buildHarnessManifest({ opts, changes = null, dir = '.', version = null, flags = [] }) {
  const { digest: ruleset, enabled } = rulesetDigest(opts.tier);
  return {
    tool: 'archnav/review-rules',
    version: version || pkgVersion(),
    preset: opts.mode,
    tier: opts.tier,
    rules: { enabled, registry: RULE_REGISTRY.length, extended: EXTENDED_RULES.size, ruleset },
    knobs: {
      impact: Boolean(opts.impact), deep: Boolean(opts.deep), duplication: Boolean(opts.duplication),
      dupKinds: [...(opts.dupKinds || [])], dupMinLines: opts.dupMinLines ?? null, dupMinTokens: opts.dupMinTokens ?? null,
      dupMaxNewClones: opts.dupMaxNewClones ?? null,
      audit: Boolean(opts.audit), semgrep: Boolean(opts.semgrep),
      checklist: Boolean(opts.checklist), compact: Boolean(opts.compact),
      pairingFloor: opts.pairingFloor ?? null, impactDepth: opts.impactDepth ?? null,
      impactMaxRisk: opts.impactMaxRisk ?? null, moduleMaxRisk: opts.moduleMaxRisk ?? null,
      clusterLevel: opts.deepClusterLevel || 'files',
      waivers: opts.waivers ? String(opts.waivers) : null,
    },
    explicitFlags: [...flags],
    scope: { mode: changes?.scope ?? null, via: changes?.via ?? null, files: (changes?.changed_files || []).length },
    index: { commit: readIndexCommit(dir), dir: path.resolve(dir) },
    // the loop is model-free: probes vary the harness, never the model
    model: null,
  };
}

function pkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || null;
  } catch { return null; }
}

function readIndexCommit(dir) {
  try { return fs.readFileSync(path.join(dir, '.archnav', 'commit'), 'utf8').trim() || null; } catch { return null; }
}
/**
 * How Semgrep is located, in order (first candidate that starts wins):
 *   1. `$SEMGREP_BIN`
 *   2. `semgrep` on PATH
 *   3. the console scripts of the python that reports them — pip --user installs into a
 *      Scripts dir that is **not** on PATH (measured on this machine:
 *      `%APPDATA%\Python\Python314\Scripts\semgrep.exe`, while the interpreter's own
 *      Scripts dir has no semgrep at all). `semgrep.exe` is a launcher that spawns
 *      `pysemgrep` by name, so its PATH gets that dir prepended; the `pysemgrep`
 *      script sitting next to it needs no such help.
 *   4. `python -m semgrep` — last resort: Semgrep ≥ 1.38 refuses to run that way
 *      (measured: exit 2 with a deprecation notice), so it only helps on old installs.
 */
export function semgrepCandidates(env = process.env, { scriptsDirs = [] } = {}) {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const out = [];
  if (env.SEMGREP_BIN) out.push({ bin: env.SEMGREP_BIN, prefix: [] });
  out.push({ bin: 'semgrep', prefix: [] });
  for (const dir of scriptsDirs) {
    out.push({ bin: path.join(dir, `semgrep${exe}`), prefix: [], pathPrefix: dir });
    out.push({ bin: path.join(dir, `pysemgrep${exe}`), prefix: [] });
  }
  out.push({ bin: env.PYTHON || 'python', prefix: ['-m', 'semgrep'] });
  return out;
}

/**
 * Where the active python keeps console scripts: the interpreter's own dir and the user
 * base dir (`pip --user` puts them there — on this machine that is the only copy, and it
 * is not on PATH). Both are returned; missing ones simply fail to spawn.
 */
export function pythonScriptsDirs(env = process.env, spawnImpl = spawnSync) {
  const code = 'import sys,sysconfig;u="nt_user" if sys.platform=="win32" else "posix_user";print(sysconfig.get_path("scripts"));print(sysconfig.get_path("scripts",u))';
  try {
    const r = spawnImpl(env.PYTHON || 'python', ['-c', code], {
      encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error || r.status !== 0) return [];
    return [...new Set(String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean))];
  } catch { return []; }
}

/**
 * Walk the candidate list until one actually starts. Returns `{ bin, result }` for the
 * first spawn that was not a plain "not found"; when nothing is found the last ENOENT
 * result comes back so the caller can report *why* instead of staying silent.
 */
export function resolveSemgrep({ env = process.env, args = [], spawnImpl = spawnSync } = {}) {
  let order = semgrepCandidates(env);
  let last = null;
  for (let i = 0; i < order.length; i++) {
    const c = order[i];
    const spawnEnv = c.pathPrefix ? { ...env, PATH: `${c.pathPrefix}${path.delimiter}${env.PATH || ''}` } : env;
    const result = spawnImpl(c.bin, [...c.prefix, ...args], {
      encoding: 'utf8', timeout: 10 * 60 * 1000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv,
    });
    last = { bin: c.bin, prefix: c.prefix, result };
    if (!(result.error && result.error.code === 'ENOENT')) return last;
    if (c.bin === 'semgrep') {                       // not on PATH: ask python where pip put it
      const dirs = pythonScriptsDirs(env, spawnImpl);
      if (dirs.length) order = semgrepCandidates(env, { scriptsDirs: dirs });
    }
  }
  return last;
}

/** Semgrep may print warnings before the JSON payload; take the first JSON object. */
export function parseSemgrepJson(stdout) {
  try { return JSON.parse(String(stdout || '').replace(/^[^{]*/, '')); } catch { return null; }
}

export function firstLine(text) {
  return String(text || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
}

export const RULE_REGISTRY = [
  // ── 结构 / 通用 ────────────────────────────────────────────────────────────
  { id: 'taint-source-to-sink', group: '污点', family: 'any', title: '外部输入直达危险 sink（文件内污点追踪）' },
  { id: 'unmapped-change', group: '结构', family: 'any', title: '改动文件是否有符号可定位（不可定位=只能人工看）' },
  { id: 'backup-file-changed', group: '结构', family: 'any', title: '是否改到副本/日期备份文件' },
  { id: 'layer-model-missing', group: '结构', family: 'any', needs: ['index'], title: '分层模型是否生效（否则"0 违规"不算通过）' },
  { id: 'no-test-coverage', group: '测试', family: 'any', needs: ['tests'], title: '改动符号是否有测试可达' },
  { id: 'repo-has-no-tests', group: '测试', family: 'any', title: '仓库是否存在测试基线' },
  { id: 'php-same-name-method', group: '结构', family: 'php', title: 'PHP 同名方法（locate/callers 需 --file 消歧）' },
  { id: 'js-same-name-method', group: '结构', family: 'front', title: '前端同名方法（orderTake 这类多处定义）' },
  // ── PHP / Laravel ─────────────────────────────────────────────────────────
  { id: 'php-route-unknown-action', group: 'PHP', family: 'php', title: '路由指向不存在的控制器方法（404）' },
  { id: 'php-mass-assignment', group: 'PHP·安全', family: 'php', title: 'Eloquent 模型缺 $fillable/$guarded' },
  { id: 'php-raw-sql-interpolation', group: 'PHP·安全', family: 'php', title: 'raw SQL 插值/拼接（注入）' },
  { id: 'php-dangerous-function', group: 'PHP·安全', family: 'php', title: 'eval/exec/unserialize 等危险函数' },
  { id: 'php-hardcoded-secret', group: 'PHP·安全', family: 'php', title: '硬编码凭据（排除校验串/占位符）' },
  { id: 'php-unvalidated-mass-input', group: 'PHP·安全', family: 'php', title: '$request->all() 无校验' },
  { id: 'php-unknown-class-import', group: 'PHP·安全', family: 'php', needs: ['composer'], title: 'use 的类在 PSR-4 下不存在（幻觉类名）' },
  { id: 'php-loose-comparison', group: 'PHP', family: 'php', title: '松散比较 == / !=（类型杂耍）' },
  { id: 'php-debug-left-on', group: 'PHP', family: 'php', title: 'dd()/dump() 调试残留' },
  { id: 'php-blade-unverified-calls', group: 'PHP', family: 'php', title: 'Blade 模板调用无法绑定（证据边界）' },
  { id: 'php-blade-unescaped-output', group: 'PHP·安全', family: 'php', title: 'Blade `{!! !!}` 原样输出（XSS）' },
  { id: 'arity-mismatch', group: '结构', family: 'front', title: '调用点参数数与定义签名不符（JS/Vue）' },
  { id: 'php-n-plus-one', group: 'PHP·性能', family: 'php', title: '循环体内查库（N+1 启发式）' },
  { id: 'php-unbounded-query', group: 'PHP·性能', family: 'php', title: '无分页全量取数' },
  // ── Python ───────────────────────────────────────────────────────────────
  { id: 'py-dangerous-function', group: 'Python·安全', family: 'python', title: 'eval/exec/pickle/os.system/shell=True' },
  { id: 'py-raw-sql', group: 'Python·安全', family: 'python', title: 'SQL f-string/拼接（注入）' },
  { id: 'py-hardcoded-secret', group: 'Python·安全', family: 'python', title: '硬编码凭据' },
  { id: 'py-bare-except', group: 'Python', family: 'python', title: '裸 except（吞 KeyboardInterrupt）' },
  { id: 'py-mutable-default-arg', group: 'Python', family: 'python', title: '可变默认参数（跨调用共享）' },
  { id: 'py-debug-left-on', group: 'Python', family: 'python', title: 'breakpoint()/pdb 残留' },
  { id: 'py-requests-no-timeout', group: 'Python', family: 'python', title: 'requests 调用没有 timeout' },
  { id: 'py-unresolved-local-import', group: 'AI·幻觉', family: 'python', title: '本地 import 指向不存在的模块' },
  { id: 'py-import-star', group: 'Python', family: 'python', title: 'from x import *' },
  { id: 'php-read-modify-write', group: 'PHP·性能', family: 'php', title: '读-改-写同一字段（并发丢更新）' },
  { id: 'php-idor-missing-authorization', group: 'PHP·安全', family: 'php', title: '带参数的资源路由看不到鉴权调用（IDOR 复核项）' },
  // ── Go ───────────────────────────────────────────────────────────────────
  { id: 'go-ignored-error', group: 'Go', family: 'go', title: '丢弃返回值（通常是 error）' },
  { id: 'go-panic-in-library', group: 'Go', family: 'go', title: '非 main 包 panic' },
  { id: 'go-sql-injection', group: 'Go·安全', family: 'go', title: '拼接/格式化构造 SQL' },
  // ── 前端 / Vue / uni-app ──────────────────────────────────────────────────
  { id: 'vue-page-not-registered', group: '前端', family: 'front', title: '页面未在 pages.json 注册' },
  { id: 'vue-nav-unknown-page', group: '前端', family: 'front', title: '跳转目标页面不存在' },
  { id: 'vue-nav-dynamic-url', group: '前端', family: 'front', title: '动态拼接跳转 URL（影响面边界）' },
  { id: 'vue-unresolved-import', group: '前端', family: 'front', title: '组件 import 解析不到（省略 index.vue）' },
  { id: 'vue-component-orphan', group: '前端', family: 'front', title: '组件无人 import（改了不生效）' },
  { id: 'vue-global-blast',            // context
    group: '前端', family: 'front', title: 'store/mixins 全局影响面' },
  { id: 'vue-vfor-missing-key', group: '前端', family: 'front', title: 'v-for 缺 :key' },
  { id: 'vue-v-html', group: '前端·安全', family: 'front', title: 'v-html（XSS）' },
  { id: 'js-innerhtml', group: '前端·安全', family: 'front', title: '.innerHTML 赋值' },
  { id: 'js-dangerous-function', group: '前端·安全', family: 'front', title: 'eval / new Function' },
  { id: 'js-debug-left-on', group: '前端', family: 'front', title: 'console.log / debugger 残留' },
  { id: 'js-loose-equality', group: '前端', family: 'front', title: '判断里用 == / !=' },
  { id: 'vue-mutating-props', group: '前端', family: 'front', title: '子组件直接改 prop' },
  { id: 'vue-v-if-with-v-for', group: '前端', family: 'front', title: '同一元素上 v-if 与 v-for 并存' },
  { id: 'vue-timer-leak', group: '前端', family: 'front', title: 'setInterval 没有 clearInterval' },
  { id: 'js-unused-binding', group: 'AI·幻觉', family: 'front', title: 'import/局部变量从未被使用（死绑定）' },
  // ── AI 代码特有 ──────────────────────────────────────────────────────────
  { id: 'js-unresolved-local-import', group: 'AI·幻觉', family: 'front', title: '本地/别名 import 指向不存在的文件' },
  { id: 'hallucinated-dependency', group: 'AI·幻觉', family: 'front', needs: ['packageJson'], title: '依赖不在 package.json（幻觉包）' },
  { id: 'empty-catch', group: 'AI', family: 'any', title: '空 catch 吞异常' },
  { id: 'ai-todo-left', group: 'AI', family: 'any', title: 'TODO/FIXME 占位残留' },
  // ── 前后端边界 ───────────────────────────────────────────────────────────
  { id: 'fe-be-pairing-suspect', group: '边界', family: 'boundary', needs: ['backend'], title: '两个索引是否同一对前后端' },
  { id: 'fe-be-path-not-found', group: '边界', family: 'boundary', needs: ['backend'], title: '前端在调、后端无此路由' },
  { id: 'fe-be-method-mismatch', group: '边界', family: 'boundary', needs: ['backend'], title: '路径对、HTTP 方法错' },
  { id: 'fe-be-route-unused', group: '边界', family: 'boundary', needs: ['backend'], title: '后端路由无前端调用' },
  { id: 'fe-dynamic-request-path', group: '边界', family: 'boundary', needs: ['backend'], title: '请求路径动态拼接（无法静态核对）' },
];

const NOT_APPLICABLE = {
  familyPhp: '本次没有 PHP 改动',
  familyFront: '本次没有 JS/Vue 改动',
  familyPython: '本次没有 Python 改动',
  familyGo: '本次没有 Go 改动',
  familyBoundary: '未提供 --backend（前后端边界需要两个索引）',
  index: '索引不可用（先 archnav analyze）',
  tests: '仓库里没有测试文件',
  composer: '仓库没有 composer.json（无法做 PSR-4 校验）',
  packageJson: '仓库没有 package.json（无法校验依赖声明）',
  noChanges: '本次没有改动',
};

export function buildChecklist({ findings = [], meta = {} }) {
  const byRule = new Map();
  for (const f of findings) byRule.set(f.rule, (byRule.get(f.rule) || 0) + 1);
  const rows = RULE_REGISTRY.map((r) => {
    let status = 'pass';
    let reason = null;
    if (!meta.hasChanges) { status = 'na'; reason = NOT_APPLICABLE.noChanges; }
    else if (r.family === 'php' && !meta.changedPhp) { status = 'na'; reason = NOT_APPLICABLE.familyPhp; }
    else if (r.family === 'front' && !meta.changedFront) { status = 'na'; reason = NOT_APPLICABLE.familyFront; }
    else if (r.family === 'python' && !meta.changedPy) { status = 'na'; reason = NOT_APPLICABLE.familyPython; }
    else if (r.family === 'go' && !meta.changedGo) { status = 'na'; reason = NOT_APPLICABLE.familyGo; }
    else if (r.family === 'boundary' && !meta.hasBackend) { status = 'na'; reason = NOT_APPLICABLE.familyBoundary; }
    else if ((r.needs || []).includes('index') && !meta.hasIndex) { status = 'na'; reason = NOT_APPLICABLE.index; }
    else if ((r.needs || []).includes('composer') && !meta.hasComposer) { status = 'na'; reason = NOT_APPLICABLE.composer; }
    else if ((r.needs || []).includes('packageJson') && !meta.hasPackageJson) { status = 'na'; reason = NOT_APPLICABLE.packageJson; }
    else if ((r.needs || []).includes('tests') && !meta.hasTests) { status = 'na'; reason = NOT_APPLICABLE.tests; }
    return { ...r, hits: byRule.get(r.id) || 0, status: status === 'na' ? 'na' : (byRule.get(r.id) ? 'hit' : 'pass'), reason };
  });
  const summary = {
    total: rows.length,
    hit: rows.filter((r) => r.status === 'hit').length,
    pass: rows.filter((r) => r.status === 'pass').length,
    na: rows.filter((r) => r.status === 'na').length,
    findings: findings.length,
  };
  return { rows, summary, meta };
}

/**
 * Stack detection: which language profiles this repo/change actually is, so the
 * relevant analyzers can switch on by themselves instead of the user remembering
 * that page-registration checks only mean something for uni-app, or that route
 * flows only exist behind a Laravel/Express router. Evidence over vibes: each
 * profile carries the files/nodes that proved it.
 */
export function detectStacks({ index, dir, changedFiles = [] }) {
  const has = (rel) => { try { return fs.existsSync(path.join(dir, rel)); } catch { return false; } };
  const nodes = index?.knowledgeGraph?.nodes || [];
  const kindCount = (prefix) => nodes.filter((n) => String(n.id).startsWith(`${prefix}:`)).length;
  const profiles = [];
  const evidence = [];
  if (has('composer.json') || has('artisan') || kindCount('route') > 0) {
    profiles.push('laravel');
    evidence.push(['composer.json', has('artisan') ? 'artisan' : null, kindCount('route') ? `${kindCount('route')} route 节点` : null].filter(Boolean).join(' + '));
  }
  if (kindCount('page') > 0 || has('pages.json')) {
    profiles.push('uni-app');
    evidence.push([has('pages.json') ? 'pages.json' : null, kindCount('page') ? `${kindCount('page')} page 节点` : null].filter(Boolean).join(' + '));
  } else if (has('vue.config.js') || has('src/App.vue')) {
    profiles.push('vue');
    evidence.push(has('vue.config.js') ? 'vue.config.js' : 'src/App.vue');
  }
  if (has('package.json')) { profiles.push('node'); evidence.push('package.json'); }
  if (has('requirements.txt') || has('pyproject.toml') || changedFiles.some((f) => f.endsWith('.py'))) {
    profiles.push('python');
    evidence.push(has('pyproject.toml') ? 'pyproject.toml' : has('requirements.txt') ? 'requirements.txt' : 'changed .py');
  }
  const langs = {};
  for (const f of changedFiles) {
    const ext = path.extname(f).toLowerCase() || '(none)';
    langs[ext] = (langs[ext] || 0) + 1;
  }
  return {
    profiles,
    evidence,
    langs,
    nodeKinds: ['route', 'page', 'flow'].filter((k) => kindCount(k) > 0),
    // a front-end repo gets a concrete, actionable hint instead of a silent gap
    suggestsBackend: (profiles.includes('uni-app') || profiles.includes('vue')) && !profiles.includes('laravel'),
  };
}

export function renderStacks(stacks) {
  if (!stacks?.profiles?.length) return '栈: 未能识别（无 composer.json/package.json/pages.json 等标志文件）';
  const langs = Object.entries(stacks.langs).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e, n]) => `${e}×${n}`).join(' ');
  return `栈 ${stacks.profiles.join('+')}（依据 ${stacks.evidence.join('；')}）${langs ? `　改动 ${langs}` : ''}`;
}
const STATUS_MARK = { pass: '✅ 通过', hit: '⚠️  命中', na: '➖ 不适用' };
const MD_MARK = { pass: '✅', hit: '⚠️', na: '➖' };

/** GitHub-flavored markdown task sheet — PR comment body / $GITHUB_STEP_SUMMARY. */
export function renderMarkdown(checklist, findings = [], meta = {}, extra = {}) {
  const L = [];
  L.push(`## 📋 审核任务书 — \`${meta.dir || '.'}\``);
  L.push('');
  L.push(`**改动** ${meta.changedTotal} 文件（PHP ${meta.changedPhp || 0} / 前端 ${meta.changedFront || 0} / 其他 ${meta.changedOther || 0}）`
    + ` · **索引** ${meta.symbols ?? '?'} 符号 · **后端索引** ${meta.hasBackend ? '已提供' : '未提供'}`
    + (extra.dupPercent !== undefined ? ` · **仓库重复率** ${extra.dupPercent}%` : '')
    + (extra.risk ? ` · **风险** ${extra.risk.level}（${extra.risk.score}）` : ''));
  if (meta.stackLine) L.push(`${meta.stackLine}`);
  if (meta.stacks?.suggestsBackend && !meta.hasBackend) {
    L.push('', '> 💡 检测到前端仓：加 `--backend <后端仓>` 可做接口边界核对（前端在调、后端有没有这条路由）');
  }
  L.push('');
  if (extra.impact) {
    const i = extra.impact;
    L.push(`**影响面** 直接 ${i.direct} · 间接 ${i.indirect} · 路由 ${i.routes.length} · 页面 ${i.pages.length} · 流程 ${i.flows.length} · 命令 ${i.commands.length} · 波及层 ${i.layers.join('/') || '—'}`);
    L.push('');
    const entries = [
      ...i.routes.slice(0, 10).map((r) => `🛣️ \`${r.node.replace(/^route:/, '')}\` — ${r.entryFile}:${r.entryLine}`),
      ...i.pages.slice(0, 10).map((r) => `📄 \`${r.node.replace(/^page:/, '')}\`（depth ${r.depth}）`),
      ...i.flows.slice(0, 10).map((r) => `🔗 \`${r.node.replace(/^flow:/, '')}\``),
      ...i.commands.slice(0, 10).map((c) => `⚙️ [${c.kind}] \`${c.node}\``),
    ];
    if (entries.length) {
      L.push('<details><summary>受影响入口</summary>');
      L.push('');
      for (const e of entries) L.push(`- ${e}`);
      L.push('');
      L.push('</details>');
      L.push('');
    }
    if (extra.risk?.reasons?.length) {
      L.push(`> 风险因子：${extra.risk.reasons.map((r) => `${r.label} +${r.points}`).join('，')}`);
      L.push('');
    }
  }
  L.push(`**规则** ${checklist.summary.total} 条：✅ 通过 ${checklist.summary.pass} · ⚠️ 命中 ${checklist.summary.hit} · ➖ 不适用 ${checklist.summary.na}（findings ${checklist.summary.findings}）`);
  L.push('');
  if (extra.waived?.length) {
    L.push(`> ➖ 已逐项审核并豁免 **${extra.waived.length}** 条（每条都有理由，逐条可查）。`);
    L.push('');
    L.push('<details><summary>豁免清单</summary>');
    L.push('');
    for (const w of extra.waived.slice(0, 50)) {
      L.push(`- \`${w.rule}\` ${w.file || ''}${w.line ? ':' + w.line : ''} — ${w.waiver?.reason || ''}${w.waiver?.by ? `（${w.waiver.by}）` : ''}`);
    }
    if (extra.waived.length > 50) L.push(`- ...其余 ${extra.waived.length - 50} 条见 \`--json\` 的 \`waived[]\``);
    L.push('');
    L.push('</details>');
    L.push('');
  }
  L.push('| 状态 | 条目 | 检查内容 | 命中 |');
  L.push('|---|---|---|---|');
  let group = null;
  for (const r of checklist.rows) {
    if (r.group !== group) {
      group = r.group;
      L.push(`| | **${group}** | | |`);
    }
    const title = r.reason ? `${r.title} —— ${r.reason}` : r.title;
    L.push(`| ${MD_MARK[r.status]} | \`${r.id}\` | ${title} | ${r.hits || ''} |`);
  }
  const na = checklist.rows.filter((r) => r.status === 'na');
  if (na.length) {
    L.push('');
    L.push(`> ➖ 未检查 ${na.length} 条：${[...new Set(na.map((r) => r.reason))].join('；')}`);
  }
  if (findings.length) {
    L.push('');
    L.push(`<details><summary>⚠️ 命中明细（${findings.length} 条）</summary>`);
    L.push('');
    for (const f of findings.slice(0, 60)) {
      const loc = f.file ? `\`${f.file}${f.line ? ':' + f.line : ''}\`` : '';
      L.push(`- **${ICON[f.severity] || ''} [${f.rule}]** ${loc} — ${f.message}`);
      L.push(`  - 为什么：${f.why}`);
      L.push(`  - 证据：${f.evidence}`);
    }
    if (findings.length > 60) L.push(`- … 另有 ${findings.length - 60} 条（见 --json / SARIF）`);
    L.push('');
    L.push('</details>');
  }
  return L.join('\n');
}


export function renderChecklist({ rows, summary, meta }) {
  const L = [];
  L.push(`\n📋 审核任务书 — ${meta.dir || '.'}`);
  L.push(`   改动文件 ${meta.changedTotal}（PHP ${meta.changedPhp || 0} / 前端 ${meta.changedFront || 0} / 其他 ${meta.changedOther || 0}）`
    + `　索引 ${meta.symbols ?? '?'} 符号　索引新鲜度 ${meta.freshness ?? '?'}`
    + `　后端索引 ${meta.hasBackend ? '已提供' : '未提供'}`);
  L.push(`   规则 ${summary.total} 条：✅ 通过 ${summary.pass}　⚠️ 命中 ${summary.hit}　➖ 不适用 ${summary.na}　（findings ${summary.findings}）`);
  if (meta.stackLine) L.push(`   ${meta.stackLine}`);
  if (meta.stacks?.suggestsBackend && !meta.hasBackend) {
    L.push('   💡 检测到前端仓：加 `--backend <后端仓>` 可做接口边界核对（前端在调、后端有没有这条路由）');
  }
  L.push('');
  L.push('   状态        规则                          检查内容');
  L.push('   ────────────────────────────────────────────────────────────────────────────');
  // Group rows by their first appearance so a group is never split in two blocks.
  const order = [];
  const byGroup = new Map();
  for (const r of rows) {
    if (!byGroup.has(r.group)) { byGroup.set(r.group, []); order.push(r.group); }
    byGroup.get(r.group).push(r);
  }
  for (const g of order) {
    L.push(`   ── ${g} ──`);
    for (const r of byGroup.get(g)) {
      const mark = r.status === 'hit' ? `${STATUS_MARK.hit}(${r.hits})` : STATUS_MARK[r.status];
      const title = r.reason ? `${r.title} —— ${r.reason}` : r.title;
      L.push(`   ${mark.padEnd(13, ' ')}${r.id.padEnd(30, ' ')}${title}`);
    }
  }
  const na = rows.filter((r) => r.status === 'na');
  if (na.length) {
    L.push('');
    L.push(`   ➖ 未检查（${na.length} 条，附原因）：${[...new Set(na.map((r) => r.reason))].join('；')}`);
  }
  return L.join('\n');
}


export function renderFindings(findings, { scope, via } = {}) {
  const L = [];
  const counts = findings.reduce((m, f) => ({ ...m, [f.severity]: (m[f.severity] || 0) + 1 }), {});
  L.push(`\n🔍 review-rules — scope=${scope ?? '?'} via=${via ?? '?'}  error ${counts.error || 0} / warn ${counts.warn || 0} / info ${counts.info || 0}`);
  if (!findings.length) { L.push('   ✅ 没有命中任何已知的 Vue/PHP 坑。'); return L.join('\n'); }
  for (const f of findings) {
    L.push(`\n   ${ICON[f.severity] || ''} [${f.rule}] ${f.file || ''}${f.line ? ':' + f.line : ''}`);
    L.push(`      ${f.message}`);
    L.push(`      为什么：${f.why}`);
    L.push(`      证据：${f.evidence}`);
  }
  return L.join('\n');
}

/**
 * `--waivers <file.json>` — 把「已逐项审核并豁免」的命中项从 findings 里摘出来。
 *
 * 与 `--dup-baseline-from-ref` 的区别：baseline 按「改动是否新引入」过滤，waiver 表达的是
 * 「有人看过这条，写了理由，不认它」——所以它必须带 reason，也必须留痕：
 *   - **没有 reason 的条目不生效**（否则豁免文件就成了无痕静音器，这正是审核里最危险的东西）
 *   - 匹配不到的条目不静默丢弃，作为 `stale` 报出来（规则改了 / 位置漂了 → 该重审）
 *   - 被摘掉的 findings 进 `waived[]`（含理由），进 JSON / markdown / 控制台，不是凭空消失
 *
 * 匹配键：rule 精确 + file 归一化精确 + line（`null` = 该规则该文件全豁免）。
 */
export function applyWaivers(findings, waivers) {
  const list = Array.isArray(waivers) ? waivers : (waivers?.waivers || []);
  const normFile = (s) => String(s ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  const key = (rule, file, line) => `${rule}\u0000${normFile(file)}\u0000${line ?? '*'}`;
  const index = new Map();
  const invalid = [];
  for (const w of list) {
    if (!w || !w.rule || !w.file || !String(w.reason ?? '').trim()) { invalid.push(w); continue; }
    const k = key(w.rule, w.file, w.line);
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(w);
  }
  const used = new Set();
  const kept = [];
  const waived = [];
  for (const f of findings) {
    const hit = (index.get(key(f.rule, f.file, f.line)) || [])[0] || (index.get(key(f.rule, f.file, null)) || [])[0];
    if (!hit) { kept.push(f); continue; }
    used.add(hit);
    waived.push({ ...f, waiver: { reason: String(hit.reason).trim(), by: hit.by ?? null, task: hit.task ?? null } });
  }
  const stale = [];
  for (const ws of index.values()) for (const w of ws) if (!used.has(w)) stale.push(w);
  return { kept, waived, invalid, stale };
}

/** `--waivers` 文件读入 + 形状校验（读不了就明确报错，不静默当“没有豁免”）。 */
export function loadWaivers(file, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const raw = readFile(path.resolve(file));
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed?.waivers;
  if (!Array.isArray(list)) throw new Error(`waivers 文件形状不对（要 {"waivers":[…]} 或数组）: ${file}`);
  return { list, source: file };
}

function parseArgs(argv) {
  const out = {
    dir: '.', scope: 'unstaged', base: null, json: false, gate: false, backend: null, sarif: null, github: false, pairingFloor: 0.2,
    // modes: `brief` (default) = high-signal rules, findings only, compact JSON;
    // `standard` = full task sheet; `deep` = + repo-level deep analysis.
    mode: 'brief', tier: 'core', allRulesFlag: false,
    checklistFlag: null, impactFlag: false, deepFlag: false, duplicationFlag: false, dupKindsFlag: false, compactFlag: null, auditFlag: null,
    checklist: false, duplication: false, impact: false, deep: false, compact: true,
    dupKinds: [], dupMinLines: 10, dupMinTokens: 70, dupMaxNewClones: null, markdown: null,
    waivers: null, harnessOut: null,
    // ANCHOR layer: null = 交给 .archnav/review.config.json 决定，缺省即 off
    anchor: null, anchorConstraints: null, anchorTrajectory: null, anchorMaxFiles: null, anchorMaxLines: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope') out.scope = argv[++i];
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--gate') out.gate = true;
    else if (a === '--mode') out.mode = String(argv[++i]).toLowerCase();
    else if (a === '--brief') out.mode = 'brief';
    else if (a === '--standard') out.mode = 'standard';
    else if (a === '--all-rules') { out.tier = 'all'; out.allRulesFlag = true; }
    else if (a === '--compact') out.compactFlag = true;
    else if (a === '--no-compact') out.compactFlag = false;
    else if (a === '--no-checklist') out.checklistFlag = false;
    else if (a === '--checklist') out.checklistFlag = true;
    else if (a === '--duplication') out.duplicationFlag = true;
    else if (a === '--impact') out.impactFlag = true;
    else if (a === '--deep') out.deepFlag = true;
    else if (a === '--audit') out.auditFlag = true;
    else if (a === '--no-audit') out.auditFlag = false;
    else if (a === '--semgrep') out.semgrep = true;
    else if (a === '--fail-on-cve') { out.failOnCve = String(argv[++i]).toUpperCase(); out.failOnCveSet = true; }
    else if (a === '--deep-cluster-level') { out.deepClusterLevel = argv[++i] === 'symbols' ? 'symbols' : 'files'; out.deepFlag = true; }
    else if (a === '--module-max-risk') { out.moduleMaxRisk = String(argv[++i]).toUpperCase(); out.deepFlag = true; }
    else if (a === '--impact-depth') { out.impactDepth = Number(argv[++i]); out.impactFlag = true; }
    else if (a === '--impact-max-risk') { out.impactMaxRisk = String(argv[++i]).toUpperCase(); out.impactFlag = true; }
    else if (a === '--dup-kinds') { out.dupKinds = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean); out.dupKindsFlag = true; }
    else if (a === '--dup-min-lines') out.dupMinLines = Number(argv[++i]);
    else if (a === '--dup-min-tokens') out.dupMinTokens = Number(argv[++i]);
    else if (a === '--dup-max-new-clones') out.dupMaxNewClones = Number(argv[++i]);
    else if (a === '--dup-baseline-from-ref') { out.dupBaselineFromRef = argv[++i]; out.duplicationFlag = true; }
    else if (a === '--markdown') out.markdown = argv[++i] === undefined ? '-' : argv[i];
    else if (a === '--backend') out.backend = argv[++i];
    else if (a === '--sarif') out.sarif = argv[++i];
    else if (a === '--github') out.github = true;
    else if (a === '--pairing-floor') out.pairingFloor = Number(argv[++i]);
    else if (a === '--waivers') out.waivers = argv[++i];
    else if (a === '--harness-out') out.harnessOut = argv[++i];
    // ── ANCHOR 层开关（可切换核心）：--anchor off|A|B|C|full ─────────────────
    else if (a === '--anchor') out.anchor = String(argv[++i] || '').toLowerCase();
    else if (a === '--anchor-constraints') out.anchorConstraints = argv[++i];
    else if (a === '--anchor-trajectory') out.anchorTrajectory = argv[++i];
    else if (a === '--anchor-max-files') out.anchorMaxFiles = Number(argv[++i]);
    else if (a === '--anchor-max-lines') out.anchorMaxLines = Number(argv[++i]);
    else if (a === '--anchor-init') out.anchorInit = true;
    else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2); }
    else out.dir = a;
  }
  // recorded verbatim in the harness manifest: what the operator asked for, as
  // opposed to what the preset resolved to. A probe needs both halves.
  out.flags = argv.filter((a) => a.startsWith('--'));
  return out;
}

async function main() {
  const opts = applyMode(parseArgs(process.argv.slice(2)));
  const dir = path.resolve(opts.dir);
  // `--anchor-init`: 把两层配置的骨架写出来，人只需要改内容。不覆盖已有文件。
  if (opts.anchorInit) {
    const { configTemplate, constraintTemplate } = await import('./anchor-review.mjs');
    const cfgDir = path.join(dir, '.archnav');
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgPath = path.join(cfgDir, 'review.config.json');
    const conPath = path.join(cfgDir, 'constraints.json');
    let wrote = 0;
    if (!fs.existsSync(cfgPath)) { fs.writeFileSync(cfgPath, JSON.stringify(configTemplate(), null, 2) + '\n'); wrote++; console.error(`✓ ${cfgPath}`); }
    else console.error(`· 已存在，跳过：${cfgPath}`);
    if (!fs.existsSync(conPath)) { fs.writeFileSync(conPath, JSON.stringify(constraintTemplate(), null, 2) + '\n'); wrote++; console.error(`✓ ${conPath}`); }
    else console.error(`· 已存在，跳过：${conPath}`);
    const trajPath = path.join(cfgDir, 'trajectory.jsonl');
    if (!fs.existsSync(trajPath)) {
      fs.writeFileSync(trajPath, [
        JSON.stringify({ type: 'tool_call', tool: 'read_file', args: { path: '<被改的文件>' } }),
        JSON.stringify({ type: 'tool_call', tool: 'bash', args: { command: '<复现命令>' } }),
        JSON.stringify({ type: 'tool_result', ok: false, text: '<失败输出>' }),
      ].join('\n') + '\n');
      wrote++;
      console.error(`✓ ${trajPath}（示例事件，替换成真实轨迹）`);
    }
    console.error(`ANCHOR 层已初始化 ${wrote} 个文件。level 默认 A——改 review.config.json 的 level 切到 B/C。`);
    return;
  }
  const changes = await archNav.changes(dir, { scope: opts.scope, base: opts.base });
  if (changes.error) { console.error(changes.error); process.exit(2); }
  const corpusMode = opts.scope === 'corpus';
  if (corpusMode) {
    console.error(`ℹ️  scope=corpus：扫全仓 ${changes.summary.changed_files} 个已索引代码文件；impact 与 ANCHOR 变更预算不适用（它们相对某次改动）。`);
    if (!opts.anchor) opts.anchor = 'off';
  }
  const index = getIndex(dir);
  if (!index) { console.error('No index — run `archnav analyze ' + dir + '` first'); process.exit(2); }
  const backendDir = opts.backend ? path.resolve(opts.backend) : null;
  const backendIndex = backendDir ? getIndex(backendDir) : null;
  if (backendDir && !backendIndex) {
    console.error(`No backend index in ${backendDir} — run \`archnav analyze ${backendDir}\` first`);
    process.exit(2);
  }
  const findings = reviewFindings({
    changes,
    index,
    backendIndex,
    tier: opts.tier,
    boundary: { pairingFloor: Number.isFinite(opts.pairingFloor) ? opts.pairingFloor : 0.2 },
    readFile: (rel) => {
      try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return null; }
    },
  });
  // ── the task-sheet view: what was checked, not just what was found ──────────
  const changedFiles = (changes.changed_files || []).map((r) => norm(r.file));
  const indexedTests = (index.symbols || []).some((s) => /(^|\/)(__tests__|tests?|spec|e2e)\//i.test(norm(s.file)) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(norm(s.file)));
  const meta = {
    dir,
    changedTotal: changedFiles.length,
    changedPhp: changedFiles.filter((f) => /\.php$/i.test(f)).length,
    changedFront: changedFiles.filter((f) => /\.(js|ts|mjs|cjs|vue)$/i.test(f)).length,
    changedBackend: changedFiles.filter((f) => /\.(php|go)$/i.test(f)).length,
    changedOther: changedFiles.filter((f) => !/\.(php|js|ts|mjs|cjs|vue|py|go)$/i.test(f)).length,
    changedPy: changedFiles.filter((f) => /\.py$/i.test(f)).length,
    changedGo: changedFiles.filter((f) => /\.go$/i.test(f)).length,
    hasChanges: changedFiles.length > 0,
    hasBackend: Boolean(backendIndex),
    hasComposer: fs.existsSync(path.join(dir, 'composer.json')),
    hasPackageJson: fs.existsSync(path.join(dir, 'package.json')),
    hasTests: indexedTests,
    hasIndex: Boolean(index),
    symbols: (index.symbols || []).length,
    freshness: `via=${changes.via}${changes.note ? ' (drift fallback)' : ''}`,
  };
  // language profiles: the relevant analyzers/rules switch on from here
  meta.stacks = detectStacks({ index, dir, changedFiles });
  meta.stackLine = renderStacks(meta.stacks);
  // ── optional: merge the jscpd duplication half into the same task sheet ────
  let dupResult = null;
  if (opts.duplication) {
    const dup = await import('./duplication.mjs');
    const isGit = fs.existsSync(path.join(dir, '.git'));
    const r = dup.runDuplication(dir, {
      minLines: opts.dupMinLines, minTokens: opts.dupMinTokens,
      kinds: opts.dupKinds,
      changed: isGit && !corpusMode && !opts.dupBaselineFromRef,
      baselineFromRef: isGit ? (opts.dupBaselineFromRef || null) : null,
      changedFiles: isGit ? null : changedFiles,        // 非 git 仓退回图谱口径
    });
    if (!r.ok) console.error(`⚠️  duplication skipped: ${r.error}`);
    else {
      dupResult = r;
      const dupChecklist = dup.buildDupChecklist({ summary: r.summary, opts: { kinds: opts.dupKinds, changed: isGit && !opts.dupBaselineFromRef, baselineFromRef: opts.dupBaselineFromRef || null } });
      dupResult.checklist = dupChecklist;
      findings.push(...r.findings.map((f) => ({ ...f, source: 'duplication' })));
    }
  }
  const checklist = buildChecklist({ findings, meta });
  // ── optional: repo-level deep analysis (flows / clusters / module risk) ────
  let deepResult = null;
  if (opts.deep) {
    const d = await import('./deep.mjs');
    const run = d.runDeep({ index, clusterLevel: opts.deepClusterLevel || 'files' });
    const deepChecklist = d.buildDeepChecklist({ flows: run.flows, clusters: run.clusters, risk: run.risk, cycles: run.cycles, clusterLevel: run.clusterLevel });
    deepResult = { ...run, checklist: deepChecklist };
    const worst = run.risk[0];
    if (worst && worst.level !== 'LOW') {
      findings.push({
        // Repo-level risk is a standing condition of the codebase, not a defect this
        // change introduced: reporting it as `error` made every push fail the gate
        // (measured on the first real CI run: HIGH(101) on src/resolver). Blocking on
        // it is opt-in via --module-max-risk.
        rule: 'deep-module-risk', severity: 'warn',
        file: worst.members?.[0] || null, line: null, source: 'deep',
        message: `仓库最高风险模块 ${worst.level}（${worst.score}）：${worst.name}`,
        why: `模块风险是加总出来的：${worst.reasons.map((r) => `${r.label} +${r.points}`).join('，')}。改动落到这个模块时按 HIGH/MEDIUM 对待。`,
        evidence: `module=${worst.name}, files=${worst.files}, externalEdges=${worst.externalEdges}, cycles=${run.cycles.length}`,
      });
    }
  }
  // ── optional: impact analysis (entry points, flows, risk) in the same sheet ─
  let impactResult = null;
  const changedSymbolsRaw = (changes.changed_symbols || []).map((s) => ({ symbol: s.symbol, file: norm(s.file), line_start: s.line_start }));
  if (opts.impact && !corpusMode) {
    const imp = await import('./impact.mjs');
    const seedNodes = [];
    for (const cs of changedSymbolsRaw) {
      seedNodes.push(`sym:${norm(cs.file)}::${cs.symbol}`);
      seedNodes.push(norm(cs.file));
    }
    const emptySummary = { direct: 0, indirect: 0, deepest: 0, routes: [], pages: [], flows: [], commands: [], layers: [], depth: opts.impactDepth || 4 };
    const hasSeeds = seedNodes.length > 0;
    if (!hasSeeds) console.error('⚠️  impact: 本次改动没有落到符号上（只改了无符号文件/行）');
    const run = hasSeeds
      ? imp.runImpact({
        index, seedNodes, depth: opts.impactDepth || 4,
        extras: { errors: findings.filter((f) => f.severity === 'error').length, uncovered: 0, newClones: 0 },
        changedCount: changedSymbolsRaw.length,
      })
      : {
        rows: [], summary: emptySummary, risk: imp.scoreRisk({}),
        available: {
          routes: (index.knowledgeGraph?.nodes || []).some((n) => String(n.id).startsWith('route:')),
          pages: (index.knowledgeGraph?.nodes || []).some((n) => String(n.id).startsWith('page:')),
          flows: (index.knowledgeGraph?.nodes || []).some((n) => String(n.id).startsWith('flow:')),
        },
      };
    impactResult = run;
    const impChecklist = imp.buildImpactChecklist({ summary: run.summary, risk: run.risk, available: run.available, changedCount: changedSymbolsRaw.length });
    impactResult.checklist = impChecklist;
    checklist.rows.push(...impChecklist.rows);
    if (hasSeeds && run.risk.level !== 'LOW') {
      findings.push({
        // Same reasoning as deep-module-risk: the change-level grade is context for the
        // reviewer, and blocking on it is the explicit --impact-max-risk decision.
        rule: 'impact-risk', severity: 'warn',
        file: null, line: null, source: 'impact',
        message: `本次改动风险 ${run.risk.level}（score ${run.risk.score}）`,
        why: `风险是加总出来的：${run.risk.reasons.map((r) => `${r.label} +${r.points}`).join('，')}。先看入口点（路由/页面/命令）再读代码。`,
        evidence: `direct=${run.summary.direct}, indirect=${run.summary.indirect}, routes=${run.summary.routes.length}, pages=${run.summary.pages.length}, flows=${run.summary.flows.length}, deepest=${run.summary.deepest}`,
      });
    }
  }
  // ── optional: dependency vulnerability audit (OSV) and Semgrep taint ──────
  const extraRows = [];
  if (opts.audit) {
    try {
      const a = await import('./audit-deps.mjs');
      const collected = a.collectDependencies(dir);
      let entries = [];
      let err = null;
      try { if (collected.deps.length) entries = await a.queryOsv(collected.deps); } catch (e) { err = e.message; }
      findings.push(...a.osvFindings(entries));
      extraRows.push(...a.buildDepChecklist({ collected, entries, error: err }));
      if (opts.failOnCveSet) {
        const order = { LOW: 0, MODERATE: 1, HIGH: 2, CRITICAL: 3 };
        const worst = Math.max(0, ...entries.map((e) => order[a.osvSeverity(e.vuln).level] ?? 0));
        if (worst >= (order[opts.failOnCve] ?? 9)) findings.push({
          rule: 'dep-vulnerability-gate', severity: 'error', file: null, line: null, source: 'audit',
          message: `依赖漏洞等级达到 ${['LOW', 'MODERATE', 'HIGH', 'CRITICAL'][worst]}，超过 --fail-on-cve ${opts.failOnCve}`,
          why: '显式要求把依赖漏洞当门禁时才会产生 error；默认不带此旗标。',
          evidence: `entries=${entries.length}, worst=${['LOW', 'MODERATE', 'HIGH', 'CRITICAL'][worst]}`,
        });
      }
    } catch (e) { console.error(`audit skipped: ${e.message}`); }
  }
  if (opts.semgrep) {
    // Honest boundary: interprocedural taint needs an engine. If Semgrep is available we
    // use it (it IS the tool for this); if not, the row says exactly that instead of
    // pretending the file-local tracker above is equivalent.
    const resolved = resolveSemgrep({ args: ['--json', '--quiet', '--config', 'auto', dir] });
    const r = resolved?.result || { error: { code: 'ENOENT' } };
    const parsed = r.error ? null : parseSemgrepJson(r.stdout);
    const results = parsed?.results || [];
    if (r.error && r.error.code === 'ENOENT') {
      extraRows.push({
        id: 'taint.semgrep', group: '污点', family: 'any', title: 'Semgrep 跨函数污点分析',
        status: 'na', hits: 0, reason: 'semgrep 不可用（pip install semgrep —— --user 装到非 PATH 的 Scripts 目录也会被找到；或用 SEMGREP_BIN 指定路径）；本次只有文件内污点追踪',
      });
    } else if (!results.length && r.status !== 0) {
      // The binary exists but produced no JSON (missing module, bad config, crash).
      // Reporting `pass` here would read as "no taint found" — say what happened.
      extraRows.push({
        id: 'taint.semgrep', group: '污点', family: 'any', title: 'Semgrep 跨函数污点分析',
        status: 'na', hits: 0, reason: `semgrep 未能产出结果（退出码 ${r.status}）：${firstLine(r.stderr) || '无 stderr'}；本次只有文件内污点追踪`,
      });
    } else {
      for (const res of results.slice(0, 200)) {
        const sev = String(res.extra?.severity || 'INFO').toUpperCase();
        findings.push({
          rule: `semgrep:${res.check_id}`, source: 'semgrep',
          severity: sev === 'ERROR' ? 'error' : sev === 'WARNING' ? 'warn' : 'info',
          file: norm(res.path), line: res.start?.line ?? null,
          message: `${norm(res.path)}:${res.start?.line ?? '?'} ${String(res.extra?.message || res.check_id).slice(0, 120)}`,
          why: 'Semgrep 规则命中（含 taint 模式）；这是外部引擎结论，按需调 --config。',
          evidence: `check_id=${res.check_id}, severity=${sev}`,
        });
      }
      extraRows.push({
        id: 'taint.semgrep', group: '污点', family: 'any', title: 'Semgrep 跨函数污点分析',
        status: results.length ? 'hit' : 'pass', hits: results.length,
        reason: r.status === 0 ? `config=auto，命中 ${results.length} 条` : `semgrep 退出码 ${r.status}（仅参考）`,
      });
    }
  }

  // ── 逐项豁免（--waivers）：从看板上「已确认豁免」的条目回流 ────────────────
  // 放在所有 findings 汇齐之后、任务书汇总之前：摘掉的是「有人给了理由不认」的条目，
  // 剩下的命中照旧进 checklist / SARIF / --gate。
  let waiverResult = { kept: findings, waived: [], invalid: [], stale: [], source: null };
  if (opts.waivers) {
    let loaded;
    try { loaded = loadWaivers(opts.waivers); }
    catch (e) { console.error(`--waivers 读不了: ${e.message}`); process.exit(2); }
    waiverResult = { ...applyWaivers(findings, loaded.list), source: loaded.source };
    if (waiverResult.waived.length) {
      findings.splice(0, findings.length, ...waiverResult.kept);
      // 任务书的行是按 pre-waiver 的 findings 建的：不重建就会出现「规则行写着 命中(1)，
      // 但 findings 里已经一条都没有」的自相矛盾。此刻 checklist.rows 里还只有规则行
      // （dup/impact/deep 的行是在下面那个 merge 块里才追加的），所以整体重建是安全的。
      const rebuilt = buildChecklist({ findings, meta });
      checklist.rows = rebuilt.rows;
      checklist.summary = rebuilt.summary;
    }
    if (waiverResult.waived.length || waiverResult.invalid.length || waiverResult.stale.length) {
      checklist.rows.push({
        id: 'waivers', group: '豁免', family: 'any',
        title: '逐项豁免（有 reason 才生效；匹配不到的按失效报出）',
        hits: waiverResult.waived.length,
        status: waiverResult.waived.length ? 'hit' : 'pass',
        reason: [
          `${waiverResult.waived.length} 条已豁免（${loaded.source}）`,
          waiverResult.invalid.length ? `${waiverResult.invalid.length} 条缺 reason → 未生效` : null,
          waiverResult.stale.length ? `${waiverResult.stale.length} 条失效（找不到对应命中，建议重审）` : null,
        ].filter(Boolean).join('；'),
      });
    }
    checklist.summary = { ...checklist.summary, findings: findings.length };
  }

  if (dupResult?.checklist || impactResult?.checklist || deepResult?.checklist || extraRows.length) {
    if (dupResult?.checklist) checklist.rows.push(...dupResult.checklist.rows);
    if (deepResult?.checklist) checklist.rows.push(...deepResult.checklist.rows);
    checklist.rows.push(...extraRows);
    checklist.summary = {
      total: checklist.rows.length,
      hit: checklist.rows.filter((r) => r.status === 'hit').length,
      pass: checklist.rows.filter((r) => r.status === 'pass').length,
      na: checklist.rows.filter((r) => r.status === 'na').length,
      findings: findings.length,
    };
  }
  // ── ANCHOR 层：A(diff 规则) / B(任务约束+ACR/CCR/FCCR) / C(执行轨迹) ────────
  // 默认 off；开关来自 .archnav/review.config.json 或 --anchor。放在汇总之前，
  // 这样它的 findings / rows / 门禁和 61 条规则走同一条出口。
  let anchorResult = null;
  try {
    const { loadConfig, runAnchorReview } = await import('./anchor-review.mjs');
    const cfg = loadConfig(dir);
    anchorResult = await runAnchorReview({ dir, changes, meta, opts, config: cfg.config });
  } catch (e) {
    // 配置写坏了不能静默当"没开"：那等于把审核关掉还不告诉人
    console.error(`ANCHOR 层未运行：${e.message}`);
  }
  if (anchorResult) {
    findings.push(...anchorResult.findings);
    checklist.rows.push(...anchorResult.checklistRows);
    checklist.summary = {
      total: checklist.rows.length,
      hit: checklist.rows.filter((r) => r.status === 'hit').length,
      pass: checklist.rows.filter((r) => r.status === 'pass').length,
      na: checklist.rows.filter((r) => r.status === 'na').length,
      findings: findings.length,
    };
  }

  findings.sort((a, b) => {
    const sev = { error: 0, warn: 1, info: 2 };
    return (sev[a.severity] - sev[b.severity]) || String(a.file).localeCompare(String(b.file)) || (a.line ?? 0) - (b.line ?? 0);
  });
  const harness = buildHarnessManifest({ opts, changes, dir, flags: opts.flags || [] });
  if (anchorResult) {
    harness.anchor = {
      level: anchorResult.level,
      coveragePct: anchorResult.coverage.atoms.pct,
      leavesReachable: anchorResult.coverage.leaves.reachable,
      metrics: anchorResult.metrics,
      gate: anchorResult.gate,
      constraintsFile: anchorResult.config.constraintsFile,
      trajectoryFile: anchorResult.config.trajectoryFile,
    };
  }
  if (opts.harnessOut) {
    const hp = path.resolve(opts.harnessOut);
    fs.writeFileSync(hp, JSON.stringify(harness, null, 2));
    console.error(`Harness manifest written to ${hp}`);
  }
  if (opts.sarif) {
    const out = opts.sarif === '-' ? null : path.resolve(opts.sarif);
    const sarif = JSON.stringify(toSarif(findings), null, 2);
    if (out) { fs.writeFileSync(out, sarif); console.error(`SARIF written to ${out}`); }
    else console.log(sarif);
  }
  if (opts.markdown) {
    const md = renderMarkdown(checklist, findings, meta, {
      dupPercent: dupResult?.summary?.percent,
      risk: impactResult?.risk,
      impact: impactResult?.summary,
      waived: waiverResult.waived,
    });
    if (opts.markdown === '-') console.log(md);
    else { fs.writeFileSync(path.resolve(opts.markdown), md); console.error(`Markdown written to ${path.resolve(opts.markdown)}`); }
  }
  if (opts.github) console.log(toGithubAnnotations(findings));
  // Machine consumers (CI gates, agents) need to tell payload generations apart: a
  // field added here used to break parsers with no way to detect the change.
  const REVIEW_SCHEMA_VERSION = 1;
  if (opts.json) {
    if (opts.compact) {
      // compact = what a tool (or an agent) actually needs per finding; the long
      // why/evidence text made this payload ~12 KB for a three-file diff.
      console.log(JSON.stringify({
        schemaVersion: REVIEW_SCHEMA_VERSION,
        mode: opts.mode,
        tier: opts.tier,
        harness: { preset: harness.preset, tier: harness.tier, ruleset: harness.rules.ruleset },
        summary: { ...checklist.summary, duplication: dupResult?.summary ?? null, risk: impactResult?.risk?.level ?? null, waived: waiverResult.waived.length },
        anchor: anchorResult ? {
          level: anchorResult.level,
          coveragePct: anchorResult.coverage.atoms.pct,
          metrics: anchorResult.metrics,
          gate: anchorResult.gate,
          trajectory: anchorResult.trajectory?.stats ?? null,
        } : null,
        findings: findings.map((f) => ({ rule: f.rule, severity: f.severity, file: f.file, line: f.line })),
      }));
    } else {
      console.log(JSON.stringify({
        schemaVersion: REVIEW_SCHEMA_VERSION,
        scope: changes.scope, via: changes.via, backend: backendDir,
        harness,
        checklist: { summary: checklist.summary, rows: checklist.rows },
        duplication: dupResult ? { summary: dupResult.summary } : null,
        anchor: anchorResult ? {
          level: anchorResult.level,
          coverage: anchorResult.coverage,
          metrics: anchorResult.metrics,
          gate: anchorResult.gate,
          constraints: anchorResult.constraints ? {
            task: anchorResult.constraints.task,
            file: anchorResult.constraints.file,
            atomics: anchorResult.constraints.atomics,
            relations: anchorResult.constraints.relations,
          } : null,
          trajectory: anchorResult.trajectory ? { file: anchorResult.trajectory.file, stats: anchorResult.trajectory.stats, rows: anchorResult.trajectory.rows } : null,
          llm: anchorResult.llm,
        } : null,
        findings,
        waived: waiverResult.waived,
      }, null, 2));
    }
  } else if (!opts.sarif || opts.sarif !== '-') {
    if (opts.checklist) console.log(renderChecklist(checklist));
    console.log(renderFindings(findings, { scope: changes.scope, via: changes.via }));
    if (anchorResult) {
      const { renderAnchorReport } = await import('./anchor-review.mjs');
      console.log('');
      console.log(renderAnchorReport(anchorResult));
    }
    if (!opts.checklist) console.log('   （--no-checklist：只显示命中项，未展示检查过的条目）');
    if (waiverResult.waived.length) {
      console.log(`\n➖ 已豁免 ${waiverResult.waived.length} 条（--waivers ${waiverResult.source}）—— 每条都带理由，查得到：`);
      for (const w of waiverResult.waived.slice(0, 20)) {
        console.log(`   [${w.rule}] ${w.file || ''}${w.line ? ':' + w.line : ''} — ${w.waiver.reason}${w.waiver.by ? `（${w.waiver.by}${w.waiver.task ? ' / ' + w.waiver.task : ''}）` : ''}`);
      }
      if (waiverResult.waived.length > 20) console.log(`   ...其余 ${waiverResult.waived.length - 20} 条见 --json 的 waived[]`);
    }
    if (waiverResult.invalid.length) console.log(`\n⚠️  ${waiverResult.invalid.length} 条豁免因缺 reason 未生效（豁免必须有理由）`);
    if (waiverResult.stale.length) console.log(`⚠️  ${waiverResult.stale.length} 条豁免已失效：命不中了（规则/位置变了），建议重审`);
  }
  if (opts.gate) {
    if (findings.some((f) => f.severity === 'error')) process.exit(1);
    // ANCHOR 层自带门禁：error 级命中，或 ACR/FCCR 低于 failOn 阈值
    if (anchorResult?.gate?.fail) {
      console.error(`ANCHOR(level=${anchorResult.level}) gate failed: ${anchorResult.gate.reasons.slice(0, 5).join('；')}`);
      process.exit(1);
    }
    if (opts.dupMaxNewClones !== null && dupResult && (dupResult.summary.new_clones || 0) > opts.dupMaxNewClones) process.exit(1);
    const order = { LOW: 0, MEDIUM: 1, HIGH: 2 };
    if (opts.impactMaxRisk && impactResult && order[impactResult.risk.level] >= (order[opts.impactMaxRisk] ?? 2)) {
      console.error(`risk ${impactResult.risk.level} >= --impact-max-risk ${opts.impactMaxRisk} → gate failed`);
      process.exit(1);
    }
    if (opts.moduleMaxRisk && deepResult?.risk?.[0] && order[deepResult.risk[0].level] >= (order[opts.moduleMaxRisk] ?? 2)) {
      console.error(`module risk ${deepResult.risk[0].level} (${deepResult.risk[0].name}) >= --module-max-risk ${opts.moduleMaxRisk} → gate failed`);
      process.exit(1);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
