#!/usr/bin/env node
/**
 * duplication — block-level copy/paste detection for the review pipeline.
 *
 * Why this exists: the "duplicate lines" metric is the one AI-quality signal the
 * local graph rules cannot produce (our `backup-file-changed` only catches whole
 * copied files). GitClear popularised the metric, but GitClear is a hosted SaaS
 * whose numbers are computed server-side after importing the repo; the callable,
 * offline equivalent is jscpd (npm, 224 languages, JSON + SARIF reporters).
 *
 * Scope: this script wraps jscpd, normalises its report into the same finding
 * shape as scripts/review-rules.mjs, and can restrict output to clones that touch
 * this change set. It does NOT talk to GitClear — see references/pitfall-coverage.md
 * for what GitClear's REST API can and cannot give us.
 *
 * Usage:
 *   node scripts/duplication.mjs [dir] [--min-lines 10] [--min-tokens 70]
 *                                [--scope unstaged|staged|all|compare] [--changed-only]
 *                                [--max-percent 10] [--json] [--sarif out.sarif] [--gate]
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { archNav } from '../src/navigation.js';
import { toSarif, toGithubAnnotations } from './review-rules.mjs';

const norm = (p) => String(p ?? '').replace(/\\/g, '/');

/**
 * jscpd names a fragment `README.md:text` / `x.vue:javascript` (file + format).
 * That suffix cannot go into a SARIF artifact URI: GitHub parses `README.md:text`
 * as URI scheme `readme.md` and rejects the whole upload ("SARIF URI scheme
 * "readme.md" did not match the checkout URI scheme "file""). The Windows guard
 * (tail must be a bare word) keeps `C:/x/y.js` intact.
 */
export function stripFormatSuffix(name) {
  const s = norm(name);
  const i = s.lastIndexOf(':');
  if (i === -1) return s;
  const tail = s.slice(i + 1);
  return /^[A-Za-z0-9+#_-]+$/.test(tail) ? s.slice(0, i) : s;
}

const formatOf = (name) => {
  const s = norm(name);
  const i = s.lastIndexOf(':');
  if (i === -1) return null;
  const tail = s.slice(i + 1);
  return /^[A-Za-z0-9+#_-]+$/.test(tail) ? tail : null;
};

/** Normalise a jscpd JSON report into review findings. Pure — unit tested. */
export function normalizeJscpd(report, { changedFiles = null, minLines = 0 } = {}) {
  const dup = (report?.duplicates || []).filter((c) => (c.lines || 0) >= minLines);
  const changed = changedFiles ? new Set(changedFiles.map(norm)) : null;
  const touched = (f) => !changed || changed.has(norm(f));
  const out = [];
  for (const c of dup) {
    const a = { file: stripFormatSuffix(c.firstFile?.name), line: c.firstFile?.start ?? null, format: formatOf(c.firstFile?.name) };
    const b = { file: stripFormatSuffix(c.secondFile?.name), line: c.secondFile?.start ?? null, format: formatOf(c.secondFile?.name) };
    // `--changed-only` means exactly that: clones where neither side is in the
    // change set are dropped, not downgraded (and the flag documents itself).
    if (changed && !touched(a.file) && !touched(b.file)) continue;
    const kind = c.kind || 'exact';
    // A clone the baseline never saw is *this change's* duplication — the only
    // severity that should ever gate a PR; pre-existing clones are context.
    const isNew = Boolean(c.isNew);
    const why = {
      exact: '字节级复制：几乎总是应该抽函数/组件，或直接 import 已有实现。',
      renamed: '改名/改字面量的复制（Type-2）：看起来像"另一套实现"，改 bug 时要记得两边都改。',
      similar: '函数级 AST 结构相似（Type-3）：逻辑相同写法不同，最容易演变成两套行为不一致的实现。',
      gap: '隔了几行的复制（Type-3 gap）：注释/空行掩盖的重复，评审时肉眼极难发现。',
      semantic: '语义克隆（Type-4）：写法完全不同但做同一件事，通常是 AI 生成的新实现没有复用既有函数。',
    }[kind] || '重复代码。';
    out.push({
      rule: 'duplication-clone',
      severity: changed ? 'warn' : (isNew ? 'warn' : 'info'),
      file: a.file,
      line: a.line,
      kind,
      is_new: isNew,
      message: `[${kind}${isNew ? '/new' : ''}] ${a.file}:${a.line} ↔ ${b.file}:${b.line} 重复 ${c.lines} 行 / ${c.tokens} tokens`,
      why: `${why}${isNew ? ' 基线里没有这块克隆 → 是本次改动新引入的重复。' : ''}`,
      evidence: `kind=${kind}, isNew=${isNew}, lines=${c.lines}, tokens=${c.tokens}, second=${b.file}:${b.line}${b.format ? `, format=${b.format}` : ''}`,
    });
  }
  const total = report?.statistics?.total || {};
  const byKind = {};
  const newByKind = {};
  for (const c of dup) {
    byKind[c.kind || 'exact'] = (byKind[c.kind || 'exact'] || 0) + 1;
    if (c.isNew) newByKind[c.kind || 'exact'] = (newByKind[c.kind || 'exact'] || 0) + 1;
  }
  return {
    findings: out,
    summary: {
      clones: dup.length,
      reported: out.length,
      new_clones: dup.filter((c) => c.isNew).length,
      by_kind: byKind,
      new_by_kind: newByKind,
      duplicated_lines: total.duplicatedLines ?? null,
      total_lines: total.lines ?? null,
      percent: total.percentage ?? null,
      by_format: report?.statistics?.formats || null,
    },
  };
}

/** Pure threshold decision, so the gate is testable without spawning jscpd. */
export function exceedsThreshold(summary, maxPercent) {
  if (maxPercent === null || maxPercent === undefined) return false;
  return typeof summary?.percent === 'number' && summary.percent > maxPercent;
}

/**
 * Clone-kind flags. jscpd already implements the whole clone taxonomy — the
 * wrapper only maps our flag names onto its flags instead of re-implementing
 * similarity (measured on bench/php-app: exact 24.8% → renamed 59.9% duplicated).
 */
export function buildJscpdFlags(opts = {}) {
  const flags = [];
  const kinds = (opts.kinds || []).map((k) => String(k).toLowerCase());
  if (kinds.includes('renamed') || kinds.includes('all')) flags.push('--ignore-identifiers', '--ignore-literals');
  if (kinds.includes('similar') || kinds.includes('all')) flags.push('--similarity', String(opts.similarity ?? 0.8));
  if (kinds.includes('gap') || kinds.includes('all')) flags.push('--max-gap-lines', String(opts.maxGapLines ?? 4));
  if (kinds.includes('semantic')) flags.push('--semantic'); // needs a local model download or --semantic-url
  if (opts.skipComments) flags.push('--skip-comments');
  if (opts.mode) flags.push('--mode', String(opts.mode));
  if (opts.changedOnly) flags.push('--changed-only');
  else if (opts.changed) flags.push('--changed');
  if (opts.baseline) flags.push('--baseline', String(opts.baseline));
  if (opts.baselineFromRef) flags.push('--baseline-from-ref', String(opts.baselineFromRef));
  if (opts.blame) flags.push('--blame');
  return flags;
}

/**
 * The duplication half of the review task sheet — same row shape as
 * review-rules' RULE_REGISTRY so the two can be printed as one checklist.
 */
export function buildDupChecklist({ summary = {}, opts = {} } = {}) {
  const kinds = new Set((opts.kinds || []).map((k) => String(k).toLowerCase()));
  const baselineGate = Boolean(opts.changed || opts.baseline || opts.baselineFromRef);
  // With a baseline gate the number that matters is what *this change* introduced;
  // pre-existing clones stay as context in the reason, not as a 命中 count.
  const counts = baselineGate ? (summary.new_by_kind || {}) : (summary.by_kind || {});
  const allKinds = summary.by_kind || {};
  const hits = (k) => counts[k] || 0;
  const kindRow = (id, kind, title, flag, naReason) => {
    if (!flag) return { id, group: '重复代码', family: 'dup', title, status: 'na', hits: 0, reason: naReason };
    const stale = baselineGate ? (allKinds[kind] || 0) - hits(kind) : 0;
    return {
      id, group: '重复代码', family: 'dup', title,
      status: hits(kind) ? 'hit' : 'pass',
      hits: hits(kind),
      reason: stale > 0 ? `另有 ${stale} 个存量克隆（非本次引入）` : null,
    };
  };
  const rows = [
    kindRow('dup.exact', 'exact', '字节级复制（Type-1）', true),
    kindRow('dup.renamed', 'renamed', '改名/改字面量的克隆（Type-2）', kinds.has('renamed') || kinds.has('all'),
      '未启用 --kind renamed（只跑 exact 会低估约 2/3：实测 24.8% vs 59.9%）'),
    kindRow('dup.similar', 'similar', '函数级结构相似（Type-3）', kinds.has('similar') || kinds.has('all'),
      '未启用 --kind similar（AST 归一，能抓 exact 看不到的对）'),
    kindRow('dup.gap', 'gap', '隔几行的复制（Type-3 gap）', kinds.has('gap') || kinds.has('all'),
      '未启用 --kind gap（注释/空行掩盖的重复）'),
    kindRow('dup.semantic', 'semantic', '语义克隆（Type-4）', kinds.has('semantic') || kinds.has('all'),
      '未启用 --semantic（需本地 CodeRankEmbed 约 548MB 或 --semantic-url 指 embeddings API）'),
    {
      id: 'dup.new', group: '重复代码', family: 'dup', title: '本次改动新引入的克隆（基线判定）',
      status: baselineGate ? (summary.new_clones ? 'hit' : 'pass') : 'na',
      hits: summary.new_clones || 0,
      reason: baselineGate ? null : '未用 --changed/--baseline：跑的是全仓存量，不归本次改动',
    },
    ...(summary.provenance ? [{
      id: 'dup.provenance', group: '重复代码', family: 'dup', title: '改动出处：新增行里有多少是复制来的',
      status: summary.provenance.copied_lines ? 'hit' : 'pass',
      hits: summary.provenance.copied_lines,
      reason: `新增 ${summary.provenance.added_lines} 行，其中 ${summary.provenance.meaningful_added_lines} 行有意义、${summary.provenance.copied_lines} 行与仓库既有行逐字相同（${(summary.provenance.ratio * 100).toFixed(1)}%）${summary.provenance.renames.length ? `；git 识别到 ${summary.provenance.renames.length} 处改名/复制` : ''}`,
    }] : []),
    {
      id: 'dup.percent', group: '重复代码', family: 'dup', title: '仓库级重复率',
      status: opts.maxPercent !== null && opts.maxPercent !== undefined && exceedsThreshold(summary, opts.maxPercent) ? 'hit' : 'pass',
      hits: 0,
      reason: `${summary.percent ?? '?'}%（${summary.duplicated_lines ?? '?'}/${summary.total_lines ?? '?'} 行；clones ${summary.clones ?? '?'}）`,
    },
  ];
  const summaryOut = {
    total: rows.length,
    hit: rows.filter((r) => r.status === 'hit').length,
    pass: rows.filter((r) => r.status === 'pass').length,
    na: rows.filter((r) => r.status === 'na').length,
    findings: summary.reported || 0,
  };
  return { rows, summary: summaryOut, meta: { percent: summary.percent, new_clones: summary.new_clones, by_kind: allKinds, new_by_kind: summary.new_by_kind || {} } };
}

/**
 * Provenance — the GitClear-style question "how much of this change is copied
 * from elsewhere rather than written or moved?". jscpd answers "do these blocks
 * look alike"; this answers "did these added lines already exist in the repo",
 * which is a property of the diff, not of the text. Both are reported separately
 * because they disagree (a moved block is a clone jscpd sees and provenance does
 * not count as copy).
 *
 * Pure: give it the added lines, a corpus of existing lines, and git's rename
 * summary; it returns counts. `--provenance` on the CLI builds those inputs.
 */
export function analyzeProvenance({ addedLines = [], corpus = new Set(), summary = '' } = {}) {
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const meaningful = addedLines.map(norm).filter((l) => l.length >= 12 && !/^(\/\/|#|\*|<!--|\/\*)/.test(l));
  const copied = meaningful.filter((l) => corpus.has(l));
  const renames = [...String(summary).matchAll(/^\s*(rename|copy)\s+([^\n]+)$/gm)].map((m) => m[0].trim());
  return {
    added_lines: addedLines.length,
    meaningful_added_lines: meaningful.length,
    copied_lines: copied.length,
    ratio: meaningful.length ? copied.length / meaningful.length : 0,
    samples: [...new Set(copied)].slice(0, 5),
    renames,
  };
}

/** Build the inputs for analyzeProvenance from git (added lines + existing corpus). */
export function provenanceFromGit(dir, { scope = 'unstaged', base = null } = {}) {
  const isWin = process.platform === 'win32';
  const runGit = (args) => {
    const full = ['-c', 'core.quotepath=false', ...args];
    return isWin
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', ['git', ...full].join(' ')], { cwd: dir, encoding: 'utf8', windowsHide: true })
      : spawnSync('git', full, { cwd: dir, encoding: 'utf8', windowsHide: true });
  };
  const diffArgs = ['diff', '--unified=0', '--no-color'];
  if (scope === 'staged') diffArgs.push('--cached');
  else if (scope === 'all') diffArgs.push('HEAD');
  else if (scope === 'compare') { if (!base) return { error: 'scope compare needs --base' }; diffArgs.push(`${base}...HEAD`); }
  const diff = runGit(diffArgs);
  if (diff.status !== 0) return { error: (diff.stderr || 'git diff failed').split('\n')[0] };
  const addedLines = [];
  const touched = new Set();
  for (const line of String(diff.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('+++ ')) { const p = line.slice(4).trim(); if (p !== '/dev/null') touched.add(p.replace(/^[ab]\//, '')); continue; }
    if (line.startsWith('+') && !line.startsWith('+++')) addedLines.push(line.slice(1));
  }
  const ls = runGit(['ls-files']);
  const corpus = new Set();
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  for (const rel of String(ls.stdout || '').split(/\r?\n/)) {
    if (!rel.trim() || touched.has(rel)) continue;
    if (!/\.(php|js|ts|tsx|mjs|cjs|vue|py|go|rs|java|rb|sh)$/i.test(rel)) continue;
    let txt = '';
    try { txt = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { continue; }
    for (const l of txt.split(/\r?\n/)) { const n = norm(l); if (n.length >= 12) corpus.add(n); }
  }
  const summary = runGit(['diff', '-M', '-C', '--find-copies-harder', '--summary', ...(scope === 'staged' ? ['--cached'] : scope === 'all' ? ['HEAD'] : [])]);
  return { ...analyzeProvenance({ addedLines, corpus, summary: String(summary.stdout || '') }), corpus_lines: corpus.size, files_compared: touched.size };
}

/** Run jscpd + normalise, so other scripts can reuse this without spawning twice. */
export function runDuplication(dir, opts = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jscpd-'));
  const run = runJscpd(dir, opts, outDir);
  if (!run.ok) return { ok: false, error: run.error };
  const { findings, summary } = normalizeJscpd(run.report, { changedFiles: opts.changedFiles || null, minLines: 0 });
  return { ok: true, findings, summary, opts };
}

function parseArgs(argv) {
  const out = {
    dir: '.', minLines: 10, minTokens: 70, scope: null, changedOnly: false,
    maxPercent: null, json: false, sarif: null, github: false, gate: false, includeVendored: false, provenance: false,
    kinds: [], similarity: 0.8, maxGapLines: 4, mode: null, skipComments: false,
    changed: false, baseline: null, baselineFromRef: null, blame: false, maxNewClones: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-lines') out.minLines = Number(argv[++i]);
    else if (a === '--min-tokens') out.minTokens = Number(argv[++i]);
    else if (a === '--scope') out.scope = argv[++i];
    else if (a === '--changed-only') out.changedOnly = true;
    else if (a === '--changed') out.changed = true;
    else if (a === '--provenance') out.provenance = true;
    else if (a === '--kind') out.kinds = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--similarity') { out.similarity = Number(argv[++i]); if (!out.kinds.includes('similar')) out.kinds.push('similar'); }
    else if (a === '--max-gap-lines') { out.maxGapLines = Number(argv[++i]); if (!out.kinds.includes('gap')) out.kinds.push('gap'); }
    else if (a === '--semantic') out.kinds.push('semantic');
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--skip-comments') out.skipComments = true;
    else if (a === '--baseline') out.baseline = argv[++i];
    else if (a === '--baseline-from-ref') out.baselineFromRef = argv[++i];
    else if (a === '--blame') out.blame = true;
    else if (a === '--max-new-clones') out.maxNewClones = Number(argv[++i]);
    else if (a === '--include-vendored') out.includeVendored = true;
    else if (a === '--max-percent') out.maxPercent = Number(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--sarif') out.sarif = argv[++i];
    else if (a === '--github') out.github = true;
    else if (a === '--gate') out.gate = true;
    else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2); }
    else out.dir = a;
  }
  return out;
}

/** Vendored / generated trees: not the team's code, and they skew the numbers. */
const VENDOR_IGNORES = ['**/plugin/**', '**/vendor/**', '**/uni_modules/**', '**/dist/**', '**/static/**'];

function runJscpd(dir, opts, outDir) {
  const ignores = ['**/node_modules/**', '**/.archnav/**', '**/.git/**', ...(opts.includeVendored ? [] : VENDOR_IGNORES)];
  // `--changed` compares against a baseline; without an explicit one jscpd writes
  // `.jscpd-baseline.json` into the repo root. Default to a temp file so a review
  // run never mutates the working tree; pass --baseline to keep it in the repo (CI).
  let baseline = opts.baseline;
  if (opts.changed && !baseline && !opts.baselineFromRef) {
    baseline = path.join(outDir, 'baseline.json');
  }
  const args = ['jscpd', '.',
    '--min-lines', String(opts.minLines), '--min-tokens', String(opts.minTokens),
    '--reporters', 'json', '--output', outDir,
    '--ignore', ignores.join(','),
    ...buildJscpdFlags({ ...opts, baseline })];

  // Windows: `npx` is a .cmd shim, so a shell is required — but cmd.exe must get
  // the args *unquoted*: measured, a quoted path reaches jscpd verbatim
  // (`path does not exist: "C:/..."`). We therefore scan `.` with cwd=dir and
  // refuse paths that would need quoting rather than fail silently.
  const spaced = [dir, outDir, baseline].filter((p) => p && /\s/.test(String(p)));
  if (spaced.length) {
    return { ok: false, error: `path contains a space, which cmd.exe cannot pass to jscpd unquoted: ${spaced[0]}` };
  }
  const isWin = process.platform === 'win32';
  const res = isWin
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', ['npx', '--yes', ...args].join(' ')], {
      cwd: dir, encoding: 'utf8', timeout: 15 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    : spawnSync('npx', ['--yes', ...args], {
      cwd: dir, encoding: 'utf8', timeout: 15 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  if (res.error) return { ok: false, error: res.error.message };
  const reportPath = path.join(outDir, 'jscpd-report.json');
  if (!fs.existsSync(reportPath)) {
    return { ok: false, error: (res.stderr || res.stdout || 'jscpd produced no report').split('\n').slice(-3).join(' ').trim() };
  }
  return { ok: true, report: JSON.parse(fs.readFileSync(reportPath, 'utf8')) };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = path.resolve(opts.dir);
  let changedFiles = null;
  // Two ways to scope to a change set:
  //   native  --changed / --changed-only / --baseline[-from-ref]  → jscpd + git (preferred)
  //   fallback --scope <unstaged|staged|all|compare>              → ArchNav drift, works without git
  if (opts.scope) {
    const changes = await archNav.changes(dir, { scope: opts.scope });
    if (changes.error) { console.error(changes.error); process.exit(2); }
    changedFiles = (changes.changed_files || []).map((r) => norm(r.file));
    if (!changedFiles.length) console.error(`no changed files in scope=${opts.scope}; report will be empty`);
  }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jscpd-'));
  const nativeScope = { ...opts, changed: opts.changed && !opts.scope, changedOnly: opts.changedOnly && !opts.scope };
  const run = runJscpd(dir, nativeScope, outDir);
  if (!run.ok) {
    console.error(`jscpd unavailable/failed: ${run.error}\nInstall it (npm i -D jscpd) or run: npx --yes jscpd --version`);
    process.exit(3);
  }
  const { findings, summary } = normalizeJscpd(run.report, { changedFiles, minLines: 0 });
  // provenance is diff-based, not clone-based: it answers how much of the change
  // already existed in the repo (copied) vs was moved (git rename/copy summary)
  if (opts.provenance) {
    const scope = opts.scope || (opts.changed ? 'unstaged' : 'all');
    const prov = provenanceFromGit(dir, { scope, base: opts.base });
    if (prov.error) console.error(`provenance skipped: ${prov.error}`);
    else {
      summary.provenance = prov;
      if (prov.copied_lines) {
        findings.push({
          rule: 'duplication-provenance', severity: 'info', source: 'provenance',
          file: null, line: null,
          message: `新增行里 ${prov.copied_lines}/${prov.meaningful_added_lines} 行与仓库既有行逐字相同（${(prov.ratio * 100).toFixed(1)}%）。`,
          why: 'GitClear 的招牌口径（复制行 vs 搬移行）：复制行越多，维护债与"同一 bug 修一处漏一处"的风险越高；git 识别到的改名/复制是搬移，不算复制。',
          evidence: `copied=${prov.copied_lines}, new=${prov.meaningful_added_lines - prov.copied_lines}, renames=${prov.renames.length}, corpus=${prov.corpus_lines} 行`,
        });
      }
    }
  }
  const checklist = buildDupChecklist({ summary, opts });
  const out = { dir, scope: opts.scope, changed_only: Boolean(changedFiles), native_changed: nativeScope.changed || nativeScope.changedOnly, summary, checklist: { summary: checklist.summary, rows: checklist.rows }, findings };
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`\n🧬 审核任务书·重复代码 — ${dir}`);
    const MARK = { pass: '✅ 通过', hit: '⚠️  命中', na: '➖ 不适用' };
    console.log(`   克隆 ${summary.clones} 个：${JSON.stringify(summary.by_kind)}　新引入 ${summary.new_clones}　重复率 ${summary.percent}%（${summary.duplicated_lines}/${summary.total_lines} 行）`);
    console.log('   状态        条目                             检查内容');
    console.log('   ────────────────────────────────────────────────────────────────────────────');
    for (const r of checklist.rows) {
      const mark = r.status === 'hit' ? `⚠️  命中(${r.hits})` : MARK[r.status];
      console.log(`   ${mark.padEnd(13, ' ')}${r.id.padEnd(32, ' ')}${r.title}${r.reason ? ` —— ${r.reason}` : ''}`);
    }
    if (summary.by_format) {
      const rows = Object.entries(summary.by_format).sort((a, b) => (b[1].duplicatedLines || 0) - (a[1].duplicatedLines || 0)).slice(0, 6);
      if (rows.length) console.log(`   按格式：${rows.map(([f, v]) => `${f} ${v.duplicatedLines} 行(${v.percentage}%)`).join('　')}`);
    }
  }
  if (opts.sarif) {
    const sarif = JSON.stringify(toSarif(findings, { toolName: 'archnav-duplication' }), null, 2);
    if (opts.sarif === '-') console.log(sarif);
    else { fs.writeFileSync(path.resolve(opts.sarif), sarif); console.error(`SARIF written to ${path.resolve(opts.sarif)}`); }
  }
  if (opts.github) console.log(toGithubAnnotations(findings));
  if (opts.gate) {
    if (opts.maxNewClones !== null && summary.new_clones > opts.maxNewClones) process.exit(1);
    if (opts.maxPercent !== null && exceedsThreshold(summary, opts.maxPercent)) process.exit(1);
    if (opts.maxNewClones === null && opts.maxPercent === null && findings.some((f) => f.severity === 'warn')) process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
