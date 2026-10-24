/**
 * ANCHOR tier A — the diff-only half of the ANCHOR taxonomy.
 *
 * ANCHOR's own finding: a functionally correct patch is not necessarily acceptable,
 * and 41.6% of its atomic constraints (C1 371 + C2 512 + C10 231 + C9's execution/
 * report leaves ≈70 = 1184/2836) are trajectory-only. This file therefore never
 * pretends to be "the ANCHOR check": it covers the leaves that are decidable from a
 * patch, and every leaf it cannot see is reported as `na` with the evidence it would
 * have needed (see scripts/anchor-review.mjs).
 *
 * Deliberate choices:
 *   - Untracked files count as changes. An AI agent's new file is untracked, and a
 *     reviewer that only reads `git diff` misses exactly the file nobody reviewed.
 *   - Rules that fire on prose are excluded (markdown is skipped for command/secret
 *     patterns) — the same false-positive class the 61-rule layer already documents.
 *   - Severity is honest: `error` only where a human would block the PR today
 *     (destructive command, privileged op, secret leaking, lock/CI tampering).
 */

import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const CODE_EXT = /\.(php|js|mjs|cjs|ts|tsx|jsx|vue|py|go|rb|java|sh|bash|zsh|sql|yml|yaml|json|html)$/i;
const DOC_EXT = /\.(md|markdown|rst|txt)$/i;

/**
 * Files the diff collector never treats as agent edits: our own index artifacts and
 * vendored trees. Without this, `.archnav/index.json` (16 MB of absolute paths for a
 * real repo) owns the line budget and every path rule.
 */
const SKIP_UNTRACKED = /(^|\/)(node_modules|vendor|\.archnav|dist|build|\.git)\//;
const MAX_UNTRACKED_BYTES = 512 * 1024;
/** Our own artifacts are never the agent's edit — even when someone commits them. */
const SKIP_TRACKED = /(^|\/)\.archnav\//;

/**
 * Collect the patch ourselves: `archNav.changes()` answers "which symbols moved", not
 * "which lines were added", and the added lines are where ANCHOR's C6–C8 live.
 * Non-git directories fall back to `via: 'none'` — never to an empty diff that would
 * read as "nothing was added".
 */
export function collectDiff(dir, { scope = 'unstaged', base = null, spawn = spawnSync } = {}) {
  const git = (args) => spawn('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const head = git(['rev-parse', '--git-dir']);
  if (head.error || head.status !== 0) return { via: 'none', reason: 'not a git repository', files: [], added: [], removed: [], stats: { files: 0, added: 0, removed: 0 } };

  let diffArgs;
  if (scope === 'staged') diffArgs = ['diff', '--cached', '--unified=0', '--no-color'];
  else if (scope === 'compare') diffArgs = ['diff', `${base || 'HEAD~1'}...HEAD`, '--unified=0', '--no-color'];
  else if (scope === 'all') diffArgs = ['diff', 'HEAD', '--unified=0', '--no-color'];
  else diffArgs = ['diff', '--unified=0', '--no-color'];

  const res = git(diffArgs);
  const files = parsePatch(String(res.stdout || '')).filter((f) => !SKIP_TRACKED.test(f.file));
  const byFile = new Map(files.map((f) => [f.file, f]));

  // untracked files: the agent's brand-new file is invisible to `git diff`
  if (scope === 'all' || scope === 'unstaged') {
    const others = git(['ls-files', '--others', '--exclude-standard']);
    for (const rel of String(others.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)) {
      const file = norm(rel);
      if (byFile.has(file)) continue;
      if (SKIP_UNTRACKED.test(file)) continue;
      let text = '';
      try {
        const abs = path.join(dir, file);
        if (fs.statSync(abs).size > MAX_UNTRACKED_BYTES) continue;   // don't read vendored blobs
        text = fs.readFileSync(abs, 'utf8');
      } catch { continue; }
      const lines = text.split(/\r?\n/);
      const added = lines.map((t, i) => ({ line: i + 1, text: t }));
      const entry = { file, status: 'added', added, removed: [] };
      files.push(entry);
      byFile.set(file, entry);
    }
  }

  const added = [];
  const removed = [];
  for (const f of files) {
    for (const a of f.added) added.push({ file: f.file, ...a });
    for (const r of f.removed) removed.push({ file: f.file, ...r });
  }
  return {
    via: 'git', scope,
    files: files.sort((a, b) => a.file.localeCompare(b.file)),
    added, removed,
    stats: { files: files.length, added: added.length, removed: removed.length },
  };
}

/** Parse `git diff --unified=0` into per-file added/removed line records. */
export function parsePatch(patch) {
  const files = [];
  let cur = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of String(patch || '').split('\n')) {
    if (raw.startsWith('diff --git ')) { cur = null; continue; }
    if (raw.startsWith('--- ')) continue;
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      const file = norm(p === '/dev/null' ? (cur?.file || '') : p.replace(/^[ab]\//, ''));
      cur = cur || { file, status: 'modified', added: [], removed: [] };
      cur.file = file;
      files.push(cur);
      continue;
    }
    if (raw.startsWith('new file mode')) { if (cur) cur.status = 'added'; continue; }
    if (raw.startsWith('deleted file mode')) { if (cur) cur.status = 'deleted'; continue; }
    if (raw.startsWith('rename from ')) { if (cur) cur.renamedFrom = norm(raw.slice(12)); continue; }
    const m = HUNK_RE.exec(raw);
    if (m) {
      oldLine = Number(m[1]);
      newLine = Number(m[2]);
      if (!cur) { cur = { file: '?', status: 'modified', added: [], removed: [] }; files.push(cur); }
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) { cur.added.push({ line: newLine++, text: raw.slice(1) }); continue; }
    if (raw.startsWith('-') && !raw.startsWith('---')) { cur.removed.push({ line: oldLine++, text: raw.slice(1) }); continue; }
    oldLine++; newLine++;   // context line (only present without --unified=0)
  }
  return files.filter((f) => f.added.length || f.removed.length || f.status !== 'modified');
}

const LOCK_RE = /(^|\/)(composer\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|go\.sum|Cargo\.lock|Gemfile\.lock)$/i;
const MANIFEST_RE = /(^|\/)(composer\.json|package\.json|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile)$/i;
const CI_RE = /(^|\/)(\.github\/workflows\/|\.gitlab-ci\.yml$|Jenkinsfile$|\.circleci\/|azure-pipelines\.yml$)/i;
const BUILD_OUT_RE = /(^|\/)(dist|build|out|\.next|\.nuxt|public\/build)\/.+\.(js|css|map|html)$/i;
const TEST_FILE_RE = /(^|\/)(tests?|__tests__|spec|e2e)\/.+|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|Test\.php$/i;
const SRC_EXT_RE = /\.(php|js|mjs|cjs|ts|tsx|jsx|vue|py|go|rb|java)$/i;

const fromCode = (file) => CODE_EXT.test(file) && !DOC_EXT.test(file);

/**
 * Rule table. Every entry names the ANCHOR leaf it operationalises (`leaf`), so a
 * finding can be traced back to the taxonomy instead of floating as a house rule.
 */
export const ANCHOR_A_RULES = [
  {
    id: 'anchor-budget-files', leaf: '3.2.1', severity: 'warn', title: '改动文件数超出变更预算',
    run: ({ diff, config }) => {
      const max = config.maxFiles ?? 20;
      if (!diff || diff.stats.files <= max) return [];
      return [{
        rule: 'anchor-budget-files', severity: 'warn', file: null, line: null,
        message: `本次改动 ${diff.stats.files} 个文件，超过预算 ${max}`,
        why: 'ANCHOR C3.2.1：文件数预算约束的是"改动可被审阅"这件事本身。跨 20+ 文件的补丁，评审者实际只会看前几个。',
        evidence: `files=${diff.stats.files} > maxFiles=${max}`,
      }];
    },
  },
  {
    id: 'anchor-budget-lines', leaf: '3.2.2', severity: 'warn', title: 'diff 行数超出变更预算',
    run: ({ diff, config }) => {
      const max = config.maxLines ?? 400;
      const total = (diff?.stats.added || 0) + (diff?.stats.removed || 0);
      if (!diff || total <= max) return [];
      return [{
        rule: 'anchor-budget-lines', severity: 'warn', file: null, line: null,
        message: `diff ${total} 行（+${diff.stats.added}/-${diff.stats.removed}），超过预算 ${max}`,
        why: 'ANCHOR C3.2.2：行数预算是"这是修 bug 还是顺手重写"的可测代理。超预算时先问任务边界，别先看代码。',
        evidence: `added=${diff.stats.added}, removed=${diff.stats.removed}, maxLines=${max}`,
      }];
    },
  },
  {
    id: 'anchor-lockfile-touched', leaf: '7.2.1', severity: 'info', title: 'lock 文件被改动',
    run: ({ diff }) => diff.files.filter((f) => LOCK_RE.test(f.file)).map((f) => {
      const manifestAlso = diff.files.some((o) => MANIFEST_RE.test(o.file));
      return {
        rule: 'anchor-lockfile-touched', file: f.file, line: null,
        severity: manifestAlso ? 'info' : 'warn',
        message: manifestAlso ? `${f.file} 随依赖声明一起变` : `${f.file} 被改但依赖声明没动（lock 漂移）`,
        why: 'ANCHOR C7.2.1：lock 文件是构建可复现的真源。只改 lock 不改 manifest，等于悄悄换了别人的依赖树。',
        evidence: `lock=${f.file}, manifestChanged=${manifestAlso}, status=${f.status}`,
      };
    }),
  },
  {
    id: 'anchor-ci-touched', leaf: '7.3.1', severity: 'warn', title: 'CI 配置被改动',
    run: ({ diff }) => diff.files.filter((f) => CI_RE.test(f.file)).map((f) => ({
      rule: 'anchor-ci-touched', file: f.file, line: null, severity: 'warn',
      message: `CI 配置被修改：${f.file}`,
      why: 'ANCHOR C7.3.1：CI 是门禁本身。改 CI 与改代码必须分开评审，否则"测试通过"这句话不再可信。',
      evidence: `file=${f.file}, status=${f.status}`,
    })),
  },
  {
    id: 'anchor-build-artifact', leaf: '7.3.2', severity: 'warn', title: '提交了构建产物',
    run: ({ diff }) => diff.files.filter((f) => BUILD_OUT_RE.test(f.file)).map((f) => ({
      rule: 'anchor-build-artifact', file: f.file, line: null, severity: 'warn',
      message: `构建产物进入改动：${f.file}`,
      why: 'ANCHOR C7.3.2：产物路径/文件名是发布契约的一部分，而且压缩产物无法评审——改它的原因必须写在别处。',
      evidence: `file=${f.file}, status=${f.status}`,
    })),
  },
  {
    id: 'anchor-new-dependency', leaf: '7.1.1', severity: 'info', title: '新增第三方依赖',
    run: ({ diff, config }) => {
      const sev = config.forbidNewDeps ? 'error' : 'info';
      const hits = [];
      for (const f of diff.files.filter((x) => MANIFEST_RE.test(x.file))) {
        for (const a of f.added) {
          const t = a.text.trim();
          if (/^"?[@\w./-]+"?\s*:\s*"?[\^~>=<*\d]/.test(t) && !/"(name|version|private|type|main|license|description|scripts)"/.test(t)) {
            hits.push({ rule: 'anchor-new-dependency', file: f.file, line: a.line, severity: sev, message: `依赖声明新增：${t.slice(0, 80)}`, why: 'ANCHOR C7.1.1：新增依赖是不可逆的供应链决策。', evidence: `${f.file}:${a.line} ${t.slice(0, 120)}` });
          } else if (/^[\w.-]+\s*[=<>~!]+\s*[\d*]/.test(t) && /requirements|pyproject/i.test(f.file)) {
            hits.push({ rule: 'anchor-new-dependency', file: f.file, line: a.line, severity: sev, message: `依赖声明新增：${t.slice(0, 80)}`, why: 'ANCHOR C7.1.1：新增依赖不可逆。', evidence: `${f.file}:${a.line} ${t.slice(0, 120)}` });
          }
        }
      }
      return hits;
    },
  },
  {
    id: 'anchor-test-missing', leaf: '9.1.1', severity: 'warn', title: '改了源码但没有对应测试',
    run: ({ diff, meta }) => {
      if (meta && meta.hasTests === false) return [];
      const src = diff.files.filter((f) => SRC_EXT_RE.test(f.file) && !TEST_FILE_RE.test(f.file) && !LOCK_RE.test(f.file));
      if (!src.length) return [];
      const touchedTest = diff.files.some((f) => TEST_FILE_RE.test(f.file) && f.status !== 'deleted');
      if (touchedTest) return [];
      return [{
        rule: 'anchor-test-missing', severity: 'warn', file: src[0].file, line: null,
        message: `${src.length} 个源码文件改动，但没有测试文件改动`,
        why: 'ANCHOR C9.1.1（530 个原子约束里最大的一类）：回归测试是"修好了"的唯一可验证证据。没有它，功能正确的补丁与碰巧正确的补丁不可区分。',
        evidence: `srcChanged=${src.map((f) => f.file).slice(0, 6).join(',')}${src.length > 6 ? ` …+${src.length - 6}` : ''}`,
      }];
    },
  },
  {
    id: 'anchor-test-tampered', leaf: '9.1.2', severity: 'error', title: '删除了测试/测试断言',
    run: ({ diff }) => {
      const out = [];
      for (const f of diff.files.filter((x) => TEST_FILE_RE.test(x.file))) {
        if (f.status === 'deleted') {
          out.push({ rule: 'anchor-test-tampered', file: f.file, line: null, severity: 'error', message: `测试文件被删除：${f.file}`, why: 'ANCHOR C9.1.2：删测试让门禁变绿是最常见的作弊路径。', evidence: `status=deleted, removed=${f.removed.length}` });
          continue;
        }
        const removedAsserts = f.removed.filter((r) => /\b(assert|expect|should|TestCase|assertEquals|assertSame)\b/.test(r.text));
        const addedAsserts = f.added.filter((a) => /\b(assert|expect|should|TestCase|assertEquals|assertSame)\b/.test(a.text));
        if (removedAsserts.length > addedAsserts.length) {
          out.push({ rule: 'anchor-test-tampered', file: f.file, line: removedAsserts[0].line, severity: 'error', message: `测试断言净减少 ${removedAsserts.length - addedAsserts.length} 条（-${removedAsserts.length}/+${addedAsserts.length}）`, why: 'ANCHOR C9.1.2：断言变少通常不是测试改好了，而是让失败消失。', evidence: `${f.file} -${removedAsserts.length}/+${addedAsserts.length}` });
        }
      }
      return out;
    },
  },
  {
    id: 'anchor-portable-path', leaf: '6.2.1', severity: 'warn', title: '写死了本机绝对路径',
    run: ({ diff }) => diff.added
      .filter((a) => fromCode(a.file))
      .filter((a) => /(['"`])\/(Users|home)\/[A-Za-z0-9._-]+\//.test(a.text) || /(['"`])[A-Za-z]:\\\\/.test(a.text))
      .map((a) => ({
        rule: 'anchor-portable-path', file: a.file, line: a.line, severity: 'warn',
        message: `绝对路径硬编码：${a.text.trim().slice(0, 80)}`,
        why: 'ANCHOR C6.2.1：本机路径在 CI/别人的机器上不存在。用项目相对路径或临时目录 API。',
        evidence: `${a.file}:${a.line}`,
      })),
  },
  {
    id: 'anchor-fs-isolation', leaf: '6.3.1', severity: 'warn', title: '写到仓库工作区之外',
    run: ({ diff }) => diff.added
      .filter((a) => fromCode(a.file))
      .filter((a) => /\b(fs\.writeFileSync|file_put_contents|open\s*\(\s*['"]\/|File\.WriteAllText|os\.WriteFile)\b/.test(a.text) && /['"]\/(tmp|var|etc|usr|opt)\//.test(a.text))
      .map((a) => ({
        rule: 'anchor-fs-isolation', file: a.file, line: a.line, severity: 'warn',
        message: `写入仓库外的绝对路径：${a.text.trim().slice(0, 80)}`,
        why: 'ANCHOR C6.3.1：写工作区外会污染宿主，也让"干净检出可复现"失效。',
        evidence: `${a.file}:${a.line}`,
      })),
  },
  {
    id: 'anchor-sys-isolation', leaf: '6.3.2', severity: 'error', title: '改动全局/系统级配置',
    run: ({ diff }) => diff.files
      .filter((f) => /(^|\/)(\.npmrc|\.yarnrc|\.gitconfig|\.docker\/config\.json|\.ssh\/|\.aws\/credentials)$/i.test(f.file))
      .map((f) => ({
        rule: 'anchor-sys-isolation', file: f.file, line: null, severity: 'error',
        message: `仓库内出现全局配置改动：${f.file}`,
        why: 'ANCHOR C6.3.2：全局配置属于宿主环境，任何"顺手改一下"都会影响同机其他项目与密钥。',
        evidence: `file=${f.file}, status=${f.status}`,
      })),
  },
  {
    id: 'anchor-destructive-command', leaf: '8.1.1', severity: 'error', title: '破坏性命令进入代码/脚本',
    run: ({ diff }) => diff.added
      .filter((a) => fromCode(a.file))
      .filter((a) => /\b(rm\s+-rf\s+[\/~]|git\s+reset\s+--hard\b|git\s+clean\s+-[a-z]*f|git\s+push\s+(--force|-f)\b|mkfs\.|dd\s+if=|DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE|:\(\)\{)/i.test(a.text))
      .map((a) => ({
        rule: 'anchor-destructive-command', file: a.file, line: a.line, severity: 'error',
        message: `破坏性操作：${a.text.trim().slice(0, 90)}`,
        why: 'ANCHOR C8.1.1：这类命令不可撤销，且 AI 常在"清理"时顺手写进脚本。出现即拦，不是风格问题。',
        evidence: `${a.file}:${a.line}`,
      })),
  },
  {
    id: 'anchor-privilege-ops', leaf: '8.1.2', severity: 'error', title: '提权/系统级操作',
    run: ({ diff }) => diff.added
      .filter((a) => fromCode(a.file))
      .filter((a) => /(\bsudo\s+[\w-]|chmod\s+777\b|chown\s+root|iptables\s+-F|ufw\s+disable|setenforce\s+0)/i.test(a.text))
      .map((a) => ({
        rule: 'anchor-privilege-ops', file: a.file, line: a.line, severity: 'error',
        message: `提权/系统操作：${a.text.trim().slice(0, 90)}`,
        why: 'ANCHOR C8.1.2：提权代码一旦进仓库，任何人跑测试都会执行它。',
        evidence: `${a.file}:${a.line}`,
      })),
  },
  {
    id: 'anchor-secret-leak', leaf: '8.2.1', severity: 'error', title: '把凭据写进日志/输出',
    run: ({ diff }) => diff.added
      .filter((a) => fromCode(a.file))
      .filter((a) => /\b(console\.(log|info|debug)|Log::(info|debug|error)|print|System\.out|logger\.\w+|var_dump|dd)\s*\([^)]*\b(password|passwd|token|secret|api[_-]?key|authorization)\b/i.test(a.text))
      .map((a) => ({
        rule: 'anchor-secret-leak', file: a.file, line: a.line, severity: 'error',
        message: `凭据可能被打印：${a.text.trim().slice(0, 90)}`,
        why: 'ANCHOR C8.2.1：凭据进日志就等于进持久存储、进日志平台、进别人的终端。',
        evidence: `${a.file}:${a.line}`,
      })),
  },
  {
    id: 'anchor-internal-path-leak', leaf: '8.2.3', severity: 'warn', title: '错误输出暴露内部路径/地址',
    run: ({ diff }) => diff.added
      .filter((a) => fromCode(a.file))
      .filter((a) => /(\/var\/www|\/srv\/|\/opt\/app|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)/.test(a.text) && /(echo|print|return|response|message|throw|error)/i.test(a.text))
      .map((a) => ({
        rule: 'anchor-internal-path-leak', file: a.file, line: a.line, severity: 'warn',
        message: `内部地址可能出现在对外输出：${a.text.trim().slice(0, 80)}`,
        why: 'ANCHOR C8.2.3：内部拓扑是攻击者的地图。',
        evidence: `${a.file}:${a.line}`,
      })),
  },
  {
    id: 'anchor-weak-crypto', leaf: '8.3.3', severity: 'warn', title: '弱加密/弱随机',
    run: ({ diff }) => diff.added
      .filter((a) => fromCode(a.file))
      // 只认「真实调用形态」：= md5(、createHash('md5')、Math.random()。
      // 裸词匹配会把规则定义行/文档串当成漏洞——自审连着抓到三次同类假阳性。
      .filter((a) => {
        const weak = /(=\s*(md5|sha1)\s*\(|createHash\(\s*['"](md5|sha1)['"]|getInstance\(\s*['"](DES|AES\/ECB)|Math\.random\s*\(\s*\))/i.test(a.text);
        const cred = /(token|secret|password|salt|nonce|otp|api[_-]?key)/i.test(a.text);
        return weak && cred;
      })
      .map((a) => ({
        rule: 'anchor-weak-crypto', file: a.file, line: a.line, severity: 'warn',
        message: `弱加密/弱随机用于安全用途：${a.text.trim().slice(0, 80)}`,
        why: 'ANCHOR C8.3.3：md5/sha1/ECB/Math.random 在凭据场景等于没有防护。',
        evidence: `${a.file}:${a.line}`,
      })),
  },
  {
    id: 'anchor-ts-any', leaf: '4.3.2', severity: 'warn', title: 'TS 新增 any',
    run: ({ diff }) => diff.added
      .filter((a) => /\.(ts|tsx)$/i.test(a.file))
      .filter((a) => /(:\s*any\b|as\s+any\b|<any>)/.test(a.text))
      .map((a) => ({
        rule: 'anchor-ts-any', file: a.file, line: a.line, severity: 'warn',
        message: `新增 any：${a.text.trim().slice(0, 80)}`,
        why: 'ANCHOR C4.3.2：any 把类型检查变成装饰；新增的 any 通常是"编不过先糊过去"。',
        evidence: `${a.file}:${a.line}`,
      })),
  },
  {
    id: 'anchor-naming-quality', leaf: '4.2.2', severity: 'info', title: '命名不可读（tmp/data/foo）',
    run: ({ diff }) => diff.added
      .filter((a) => fromCode(a.file) && !TEST_FILE_RE.test(a.file))
      .filter((a) => /\b(const|let|var|function|def|private|public|protected)\s+(tmp|temp|data|foo|bar|baz|x1|res1|abc)\b/.test(a.text))
      .map((a) => ({
        rule: 'anchor-naming-quality', file: a.file, line: a.line, severity: 'info',
        message: `命名不可读：${a.text.trim().slice(0, 80)}`,
        why: 'ANCHOR C4.2.2：名字是唯一不花运行时成本的文档。',
        evidence: `${a.file}:${a.line}`,
      })),
  },
  {
    id: 'anchor-docs-sync', leaf: '4.4.3', severity: 'info', title: '新增对外接口但文档没动',
    run: ({ diff }) => {
      const apiAdded = diff.added.filter((a) => /(Route::(get|post|put|patch|delete)|router\.(get|post|put|patch|delete)|app\.(get|post|put|patch|delete))\s*\(/.test(a.text));
      if (!apiAdded.length) return [];
      const docTouched = diff.files.some((f) => /(README|docs?\/|CHANGELOG)/i.test(f.file));
      if (docTouched) return [];
      return [{
        rule: 'anchor-docs-sync', file: apiAdded[0].file, line: apiAdded[0].line, severity: 'info',
        message: `新增 ${apiAdded.length} 个路由，但 README/docs 未更新`,
        why: 'ANCHOR C4.4.3：对外接口的文档与代码同一次提交才有意义；分开写就等于不写。',
        evidence: `routes=${apiAdded.map((a) => `${a.file}:${a.line}`).slice(0, 4).join(', ')}`,
      }];
    },
  },
  {
    id: 'anchor-python-encoding', leaf: '6.2.2', severity: 'info', title: 'Python 打开文件未显式编码',
    run: ({ diff }) => diff.added
      .filter((a) => /\.py$/i.test(a.file))
      .filter((a) => /\bopen\s*\(/.test(a.text) && !/encoding\s*=/.test(a.text) && /['"]r['"]?\s*\)?\s*$|['"]w['"]?\s*\)?\s*$/.test(a.text.trim()))
      .map((a) => ({
        rule: 'anchor-python-encoding', file: a.file, line: a.line, severity: 'info',
        message: `open() 未显式 encoding：${a.text.trim().slice(0, 80)}`,
        why: 'ANCHOR C6.2.2：默认编码依赖系统 locale，CI 与开发机行为会分叉。',
        evidence: `${a.file}:${a.line}`,
      })),
  },
];

/**
 * Rules that legitimately fire on *string content*. Our own test fixtures carry
 * `exec("rm -rf /tmp/build")`, `Log::info($request->password)` and `/Users/…` paths on
 * purpose, so a self-review reported 5 phantom errors — the exact false-positive class
 * ANCHOR's C8 is not about (C8 governs shipped code, not test payloads). Test files are
 * therefore excluded for these rules only; every other rule keeps judging them.
 */
const FIXTURE_PRONE = new Set([
  'anchor-destructive-command', 'anchor-privilege-ops', 'anchor-secret-leak',
  'anchor-internal-path-leak', 'anchor-portable-path', 'anchor-fs-isolation', 'anchor-weak-crypto',
]);

/**
 * Comment lines are prose, not code. Proven by self-review: the docstring explaining why
 * `exec("rm -rf …")` is banned was itself reported as a destructive command (twice, as a
 * secret leak too). Every tier-A rule judges code, so comments are dropped once, here,
 * instead of patching each rule's regex.
 */
const isCommentLine = (text) => /^\s*(\/\/|\/\*|\*|#|<!--|"""|''')/.test(String(text ?? ''));

/**
 * Run the tier-A rules over a collected diff.
 * @returns {{findings: Array, rows: Array}} rows carry per-leaf status for the checklist.
 */
export function anchorRuleFindings({ diff, meta = {}, config = {} }) {
  if (!diff || diff.via !== 'git') {
    return {
      findings: [],
      rows: ANCHOR_A_RULES.map((r) => ({ id: r.id, leaf: r.leaf, title: r.title, status: 'na', hits: 0, reason: '不是 git 仓库，取不到 diff（不能当通过）' })),
    };
  }
  const findings = [];
  const rows = [];
  // comments dropped once, for every rule (see isCommentLine above)
  const codeDiff = { ...diff, added: (diff.added || []).filter((a) => !isCommentLine(a.text)) };
  for (const rule of ANCHOR_A_RULES) {
    let produced = [];
    try {
      produced = rule.run({ diff: codeDiff, meta, config }) || [];
      if (FIXTURE_PRONE.has(rule.id)) {
        produced = produced.filter((f) => !TEST_FILE_RE.test(String(f.file || '')));
      }
    } catch (e) {
      rows.push({ id: rule.id, leaf: rule.leaf, title: rule.title, status: 'na', hits: 0, reason: `规则执行失败：${e.message}` });
      continue;
    }
    for (const f of produced) findings.push({ ...f, leaf: rule.leaf, source: 'anchor-a' });
    rows.push({
      id: rule.id, leaf: rule.leaf, title: rule.title,
      status: produced.length ? 'hit' : 'pass', hits: produced.length,
      reason: produced.length ? `${produced.length} 处命中` : null,
    });
  }
  return { findings, rows };
}
