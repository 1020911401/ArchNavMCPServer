/**
 * Unit tests for the ANCHOR layer (scripts/anchor-*.mjs + src/anchor-taxonomy.mjs).
 *
 * The three tiers are pure over (diff, constraints, trajectory), so every test builds
 * its evidence by hand instead of relying on a fixture repo. What is pinned here is the
 * thing most likely to rot: that a tier without its evidence reports `na` rather than
 * `pass`, and that the metrics use the paper's definitions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ANCHOR_CATEGORIES, ANCHOR_LEAVES, LEVELS, coverage, normalizeLevel, leavesForLevel } from '../src/anchor-taxonomy.mjs';
import { parsePatch, anchorRuleFindings, collectDiff, ANCHOR_A_RULES } from '../scripts/anchor-rules.mjs';
import { loadConstraints, constraintTemplate, runCheck, evaluateConstraints, evaluateRelations, computeMetrics, matchesAny, renderConstraints } from '../scripts/anchor-constraints.mjs';
import { normalizeEvent, trajectoryChecks, loadTrajectory, summarize, llmJudge, trajectoryCoveredLeaves } from '../scripts/anchor-trajectory.mjs';
import { resolveConfig, loadConfig, runAnchorReview, configTemplate, renderAnchorReport, buildConfigFromLevel } from '../scripts/anchor-review.mjs';

const patch = [
  'diff --git a/src/crypto/types.php b/src/crypto/types.php',
  '--- a/src/crypto/types.php',
  '+++ b/src/crypto/types.php',
  '@@ -10,0 +11,3 @@',
  "+    $tmp = '/Users/zhaopusheng/projects/x';",
  '+    Log::info($request->password);',
  '+    exec("rm -rf /tmp/build");',
  'diff --git a/composer.lock b/composer.lock',
  '--- a/composer.lock',
  '+++ b/composer.lock',
  '@@ -3,0 +4 @@',
  '+    "some/pkg": "^1.2"',
].join('\n');

const fakeDiff = () => {
  const files = parsePatch(patch);
  const added = files.flatMap((f) => f.added.map((a) => ({ file: f.file, ...a })));
  const removed = files.flatMap((f) => f.removed.map((r) => ({ file: f.file, ...r })));
  return { via: 'git', scope: 'unstaged', files, added, removed, stats: { files: files.length, added: added.length, removed: removed.length } };
};

// ── taxonomy ────────────────────────────────────────────────────────────────

test('taxonomy carries 10 categories / 78 leaves / 2836 atoms (paper Table 2)', () => {
  assert.equal(ANCHOR_CATEGORIES.length, 10);
  assert.equal(ANCHOR_LEAVES.length, 78);
  assert.equal(ANCHOR_LEAVES.reduce((n, l) => n + l.atoms, 0), 2836);
  for (const cat of ANCHOR_CATEGORIES) {
    const sum = cat.subcategories.flatMap((s) => s.leaves).reduce((n, l) => n + l.atoms, 0);
    assert.equal(sum, cat.atoms, `${cat.code} 原子数应自洽`);
  }
});

test('level masks are cumulative and coverage grows monotonically', () => {
  assert.equal(normalizeLevel('a'), 'A');
  assert.equal(normalizeLevel('full'), 'full');
  assert.equal(normalizeLevel('nonsense'), null);
  const a = coverage('A');
  const b = coverage('B');
  const c = coverage('C');
  assert.ok(a.atoms.reachable < b.atoms.reachable);
  assert.ok(b.atoms.reachable <= c.atoms.reachable);
  assert.ok(c.atoms.pct < 100, 'trajectory-free tiers cannot cover the whole taxonomy');
  assert.equal(LEVELS.off.A, false);
  assert.equal(leavesForLevel('off').length, 0);
});

// ── tier A: diff rules ──────────────────────────────────────────────────────

test('every tier-A rule names an ANCHOR leaf that exists', () => {
  const ids = new Set(ANCHOR_LEAVES.map((l) => l.id));
  for (const r of ANCHOR_A_RULES) assert.ok(ids.has(r.leaf), `${r.id} 的 leaf ${r.leaf} 不在分类法里`);
});

test('tier A fires on secret logging, destructive command and lock drift', () => {
  const { findings } = anchorRuleFindings({ diff: fakeDiff(), meta: { hasTests: true }, config: {} });
  const rules = new Set(findings.map((f) => f.rule));
  assert.ok(rules.has('anchor-secret-leak'), '凭据打日志应命中');
  assert.ok(rules.has('anchor-destructive-command'), 'rm -rf 应命中');
  assert.ok(rules.has('anchor-lockfile-touched'), 'composer.lock 应命中');
  assert.ok(rules.has('anchor-portable-path'), '/Users/... 硬编码应命中');
  assert.equal(findings.find((f) => f.rule === 'anchor-destructive-command').severity, 'error');
});

test('tier A reports na (never pass) when there is no diff', () => {
  const r = anchorRuleFindings({ diff: { via: 'none', files: [], added: [], removed: [], stats: { files: 0, added: 0, removed: 0 } }, meta: {}, config: {} });
  assert.equal(r.findings.length, 0);
  assert.ok(r.rows.every((x) => x.status === 'na'));
  assert.match(r.rows[0].reason, /不是 git 仓库/);
});

test('tier A budget rule respects config', () => {
  const diff = fakeDiff();
  const tight = anchorRuleFindings({ diff, meta: {}, config: { maxFiles: 1 } }).findings.find((f) => f.rule === 'anchor-budget-files');
  assert.ok(tight, 'maxFiles=1 时应超预算');
  assert.match(tight.evidence, /files=2 > maxFiles=1/);
  const loose = anchorRuleFindings({ diff, meta: {}, config: { maxFiles: 50 } }).findings.find((f) => f.rule === 'anchor-budget-files');
  assert.equal(loose, undefined);
});

// ── tier B: constraints ─────────────────────────────────────────────────────

test('constraint file validation rejects a relation pointing at a missing item', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-c-'));
  const file = path.join(dir, 'c.json');
  fs.writeFileSync(file, JSON.stringify({ constraints: [{ id: 'a', leaf: '3.1.1', check: { type: 'max_files', max: 1 } }], relations: [{ id: 'r', type: 'AND', items: ['a', 'ghost'] }] }));
  assert.throws(() => loadConstraints(file), /不存在的约束/);
});

test('path_scope / max_lines / test_added judge the diff symbolically', () => {
  const diff = fakeDiff();
  const ctx = { diff, files: diff.files.map((f) => f.file), added: diff.added, removed: diff.removed };
  // composer.lock is in the diff, so "only src/**" must fail — that is the point of scope
  assert.equal(runCheck({ type: 'path_scope', allow: ['src/**'] }, ctx).status, 'fail');
  assert.equal(runCheck({ type: 'path_scope', allow: ['src/**', 'composer.lock'] }, ctx).status, 'pass');
  assert.equal(runCheck({ type: 'max_lines', max: 2 }, ctx).status, 'fail');
  assert.equal(runCheck({ type: 'test_added' }, ctx).status, 'fail');
  assert.equal(runCheck({ type: 'lock_untouched' }, ctx).status, 'fail');
});

test('trajectory-backed constraint is na without a trajectory, not pass', () => {
  const diff = fakeDiff();
  const ctx = { diff, files: diff.files.map((f) => f.file), added: diff.added, removed: diff.removed, trajectory: null };
  const r = runCheck({ type: 'order', before: 'test', after: 'edit' }, ctx);
  assert.equal(r.status, 'na');
  assert.match(r.note, /未提供执行轨迹/);
});

test('AND / THEN / PRIORITY relations evaluate as the paper defines them', () => {
  const atomics = [
    { id: 's', status: 'pass' },
    { id: 't', status: 'fail' },
    { id: 'low', status: 'fail' },
  ];
  const [and] = evaluateRelations({ relations: [{ id: 'r1', type: 'AND', items: ['s', 't'] }], atomics });
  assert.equal(and.status, 'fail');
  const [then] = evaluateRelations({ relations: [{ id: 'r2', type: 'THEN', items: ['s', 't'] }], atomics });
  assert.equal(then.status, 'fail');
  // a failed precondition does not "fail" the THEN relation — the atom already did
  const [thenDead] = evaluateRelations({ relations: [{ id: 'r3', type: 'THEN', items: ['t', 's'] }], atomics });
  assert.equal(thenDead.status, 'pass');
  const fresh = [{ id: 'top', status: 'fail' }, { id: 'low', status: 'fail' }];
  const [prio] = evaluateRelations({ relations: [{ id: 'r4', type: 'PRIORITY', items: ['top', 'low'] }], atomics: fresh });
  assert.deepEqual(prio.overridden, ['low']);
  assert.equal(fresh[1].status, 'override', '被高优先项覆盖的低优先项退出 ACR');
});

test('ACR / CCR / IPR / FCCR use the paper definitions and exclude na', () => {
  const atomics = [
    { id: 'a', status: 'pass' }, { id: 'b', status: 'fail' }, { id: 'c', status: 'na' },
  ];
  const relations = [{ id: 'r', status: 'pass' }];
  const m = computeMetrics({ atomics, relations });
  assert.equal(m.ACR, 0.5);
  assert.equal(m.CCR, 1);
  assert.equal(m.IPR, Math.round((2 / 3) * 1000) / 1000);
  assert.equal(m.FCCR, 0);
  assert.equal(m.counts.na, 1);
  const all = computeMetrics({ atomics: [{ id: 'a', status: 'pass' }], relations: [] });
  assert.equal(all.FCCR, 1);
});

test('constraint template is self-consistent (loads and evaluates)', () => {
  const tpl = constraintTemplate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-tpl-'));
  const file = path.join(dir, 'constraints.json');
  fs.writeFileSync(file, JSON.stringify(tpl));
  const bundle = loadConstraints(file);
  assert.ok(bundle.constraints.length >= 5);
  const atomics = evaluateConstraints({ constraints: bundle.constraints, diff: fakeDiff() });
  assert.equal(atomics.length, bundle.constraints.length);
  const relations = evaluateRelations({ relations: bundle.relations, atomics });
  assert.equal(relations.length, bundle.relations.length);
});

// ── tier C: trajectory ──────────────────────────────────────────────────────

test('event normalization accepts the three common shapes', () => {
  assert.equal(normalizeEvent({ type: 'tool_call', name: 'read_file', args: { path: 'a.php' } }).tool, 'read_file');
  assert.equal(normalizeEvent({ tool: 'bash', arguments: { command: 'pytest -q' } }).cmd, 'pytest -q');
  assert.equal(normalizeEvent({ role: 'assistant', content: 'done' }).kind, 'assistant');
});

test('trajectory catches: claim without test run, blind retry, unread edit, missing evidence', () => {
  const raw = [
    { type: 'tool_call', tool: 'edit_file', args: { path: 'app/A.php' } },
    { type: 'tool_result', ok: false, text: 'boom' },
    { type: 'tool_call', tool: 'edit_file', args: { path: 'app/A.php' } },
  ];
  const events = raw.map((e, i) => ({ ...normalizeEvent(e), i }));
  const rows = trajectoryChecks({ events, report: '已修复，测试全部通过。' });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by['traj-claim-truthfulness'].status, 'fail');
  assert.equal(by['traj-read-before-edit'].status, 'fail');
  assert.equal(by['traj-failure-handling'].status, 'fail');
  assert.equal(by['traj-result-verification'].status, 'fail');
  assert.equal(by['traj-code-references'].status, 'fail');
});

test('trajectory passes a disciplined run (read → test → edit → verify → report with refs)', () => {
  const raw = [
    { type: 'tool_call', tool: 'read_file', args: { path: 'app/A.php' } },
    { type: 'tool_call', tool: 'bash', args: { command: 'phpunit --filter ATest' } },
    { type: 'tool_result', ok: true, text: '1 failed' },
    { type: 'tool_call', tool: 'edit_file', args: { path: 'app/A.php' } },
    { type: 'tool_call', tool: 'bash', args: { command: 'phpunit --filter ATest' } },
    { type: 'tool_result', ok: true, text: '1 passed' },
    { type: 'commit', commit: { message: 'fix(app): keep crypto type unique' } },
    { type: 'message', role: 'assistant', content: '修复 app/A.php:42，前后对比：\n```\n1 failed\n```\n→\n```\n1 passed (1 test)\n```' },
  ];
  const events = raw.map((e, i) => ({ ...normalizeEvent(e), i }));
  const rows = trajectoryChecks({ events, report: raw.at(-1).content });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by['traj-result-verification'].status, 'pass');
  assert.equal(by['traj-read-before-edit'].status, 'pass');
  assert.equal(by['traj-task-order'].status, 'pass', '测试先于第一次编辑');
  assert.equal(by['traj-pre-commit'].status, 'pass');
  assert.equal(by['traj-commit-format'].status, 'pass');
  assert.equal(by['traj-code-references'].status, 'pass');
  assert.equal(by['traj-before-after'].status, 'pass');
  const s = summarize(events);
  assert.equal(s.testRuns, 2);
  assert.equal(s.edits, 1);
});

test('loadTrajectory reads JSONL and throws on garbage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-trail-'));
  const ok = path.join(dir, 't.jsonl');
  fs.writeFileSync(ok, [
    JSON.stringify({ type: 'tool_call', tool: 'read_file', args: { path: 'a.php' } }),
    JSON.stringify({ role: 'assistant', content: 'done app/a.php:3' }),
  ].join('\n'));
  const loaded = loadTrajectory(ok);
  assert.equal(loaded.events.length, 2);
  assert.match(loaded.report, /app\/a\.php:3/);
  const bad = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(bad, 'not json\n');
  assert.throws(() => loadTrajectory(bad), /不是 JSON/);
});

// ── orchestrator ────────────────────────────────────────────────────────────

test('level resolution: flag beats config beats default off', () => {
  assert.equal(resolveConfig({ opts: {}, config: {} }).level, 'off');
  assert.equal(resolveConfig({ opts: {}, config: { level: 'B' } }).level, 'B');
  assert.equal(resolveConfig({ opts: { anchor: 'C' }, config: { level: 'B' } }).level, 'C');
  assert.equal(resolveConfig({ opts: { anchor: 'off' }, config: { level: 'C' } }).level, 'off');
});

test('runAnchorReview returns null at level off (existing behaviour untouched)', async () => {
  const r = await runAnchorReview({ dir: process.cwd(), opts: {}, config: {} });
  assert.equal(r, null);
});

test('level A run produces rows + coverage, and level C without trajectory says why', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-run-'));
  fs.mkdirSync(path.join(dir, '.archnav'), { recursive: true });
  const a = await runAnchorReview({
    dir, opts: { anchor: 'A' }, config: {},
    tierImpl: { diff: fakeDiff(), aRules: anchorRuleFindings({ diff: fakeDiff(), meta: {}, config: {} }) },
  });
  assert.equal(a.level, 'A');
  assert.ok(a.checklistRows.length > 0);
  assert.ok(a.coverage.atoms.pct > 0 && a.coverage.atoms.pct < 100);
  assert.match(renderAnchorReport(a), /ANCHOR 层 level=A/);

  const c = await runAnchorReview({
    dir, opts: { anchor: 'C' }, config: { trajectory: '.archnav/missing.jsonl', constraints: '.archnav/missing.json' },
    tierImpl: { diff: fakeDiff(), aRules: anchorRuleFindings({ diff: fakeDiff(), meta: {}, config: {} }) },
  });
  const traj = c.checklistRows.find((r) => r.id === 'anchor-trajectory');
  assert.equal(traj.status, 'na');
  assert.match(traj.reason, /轨迹文件不存在|未提供执行轨迹/);
  assert.equal(c.metrics, null, '没有约束文件就没有 ACR 可算');
});

test('gate fails on an error-severity ANCHOR finding', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-gate-'));
  const r = await runAnchorReview({
    dir, opts: { anchor: 'A' }, config: {},
    tierImpl: { diff: fakeDiff(), aRules: anchorRuleFindings({ diff: fakeDiff(), meta: {}, config: {} }) },
  });
  assert.equal(r.gate.fail, true);
  assert.ok(r.gate.reasons.some((x) => /anchor-destructive-command|anchor-secret-leak|anchor-sys-isolation/.test(x)));
});

test('config file: missing is empty, broken is an error, bad level is an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-cfg-'));
  assert.deepEqual(loadConfig(dir).config, {});
  fs.mkdirSync(path.join(dir, '.archnav'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.archnav/review.config.json'), '{oops');
  assert.throws(() => loadConfig(dir), /解析失败/);
  fs.writeFileSync(path.join(dir, '.archnav/review.config.json'), JSON.stringify({ level: 'Z' }));
  assert.throws(() => loadConfig(dir), /level 非法/);
  fs.writeFileSync(path.join(dir, '.archnav/review.config.json'), JSON.stringify({ level: 'b', maxFiles: 3 }));
  assert.equal(loadConfig(dir).config.level, 'b');
  assert.equal(configTemplate().level, 'A');
});

// ── 自审补上的覆盖（archnav 自己的 no-test-coverage 命中这 6 个导出符号） ──────

test('collectDiff reads a real git worktree, counts untracked, skips own artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-diff-'));
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, '.archnav'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/a.php'), '<?php\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(dir, 'src/a.php'), '<?php\n$x = 1;\n');   // tracked change
  fs.writeFileSync(path.join(dir, 'src/new.php'), '<?php\n$y = 2;\n'); // untracked = agent's new file
  fs.writeFileSync(path.join(dir, '.archnav/index.json'), '{"big":"index"}');
  const d = collectDiff(dir, { scope: 'all' });
  assert.equal(d.via, 'git');
  const files = d.files.map((f) => f.file);
  assert.ok(files.includes('src/a.php'), 'tracked change must appear');
  assert.ok(files.includes('src/new.php'), 'untracked file must appear — that is the whole point');
  assert.ok(!files.some((f) => f.startsWith('.archnav/')), 'own artifacts never count as edits');
  assert.ok(d.stats.added >= 2);
});

test('matchesAny handles bare directories, globs and ** prefixes', () => {
  assert.equal(matchesAny('src/crypto/a.php', ['src']), true);
  assert.equal(matchesAny('src/crypto/a.php', ['src/**']), true);
  assert.equal(matchesAny('app/Http/A.php', ['**/Http/**']), true);
  assert.equal(matchesAny('app/A.php', ['src/**']), false);
  assert.equal(matchesAny('a.php', []), false);
});

test('llmJudge is na without a runner and parses a verdict with one', () => {
  const items = [{ id: 'x', leaf: '10.2.1', title: '报告模板' }];
  const none = llmJudge({ items, trajectory: { report: 'r' }, runner: null });
  assert.equal(none[0].status, 'na');
  assert.match(none[0].note, /未配置 LLM 判官/);
  const fake = llmJudge({
    items, trajectory: { report: 'r' },
    runner: 'node -e "console.log(\'FAIL:no-evidence\')"',
  });
  assert.equal(fake[0].status, 'fail');
  assert.match(fake[0].evidence, /FAIL/);
});

test('renderConstraints prints all four metrics and per-item marks', () => {
  const atomics = [{ id: 'a', leaf: '3.1.1', text: '只改 src', status: 'pass', evidence: 'ok' }, { id: 'b', text: '加测试', status: 'fail', evidence: 'no test' }];
  const relations = [{ id: 'r', type: 'AND', items: ['a', 'b'], status: 'fail', evidence: 'b 未满足' }];
  const out = renderConstraints({ atomics, relations });
  assert.match(out, /ACR 50\.0%/);
  assert.match(out, /CCR 0\.0%/);
  assert.match(out, /⛔ \[b\]/);
  assert.match(out, /⛔ \[AND r\]/);
});

test('buildConfigFromLevel pins a level and keeps the rest of the template', () => {
  const cfg = buildConfigFromLevel('C');
  assert.equal(cfg.level, 'C');
  assert.equal(cfg.constraints, '.archnav/constraints.json');
  assert.equal(cfg.failOn.severity, 'error');
});

test('trajectoryCoveredLeaves only names leaves that exist in the taxonomy', () => {
  const ids = new Set(ANCHOR_LEAVES.map((l) => l.id));
  const covered = trajectoryCoveredLeaves();
  assert.ok(covered.length >= 10);
  for (const id of covered) assert.ok(ids.has(id), `${id} 不在分类法里`);
});

test('rules do not fire on their own fixtures: test files are exempt for C8 rules', () => {
  // a test file that *contains* a destructive command as a string must not be an error
  const files = [{ file: 'tests/anchor.test.mjs', status: 'modified', added: [{ line: 1, text: '+    exec("rm -rf /tmp/build");' }], removed: [] }];
  const added = files[0].added.map((a) => ({ file: files[0].file, ...a }));
  const diff = { via: 'git', files, added, removed: [], stats: { files: 1, added: 1, removed: 0 } };
  const { findings } = anchorRuleFindings({ diff, meta: {}, config: {} });
  assert.equal(findings.filter((f) => f.rule === 'anchor-destructive-command').length, 0, '测试夹具不该当生产代码的 error');
});
