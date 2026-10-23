/**
 * tests/probe.test.mjs — the harness probe's identity + diffing contract.
 *
 * What is pinned here:
 *   1. a finding keeps its identity when the reviewed file is edited around it
 *      (line drift must not look like a new finding — that is the failure this
 *      script exists to prevent, and I hit it live while building the probe);
 *   2. a flag that never reaches the resolver is called a dead knob, which needs
 *      the manifest to be identical *except* for `explicitFlags`;
 *   3. a genuine behavioral change is never swallowed by (1) or (2).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeMessage, stableKey, exactKey, diffFindings, countByRule, ruleDelta,
  resolvedHarness, runProbe, renderMarkdown, parseArgs,
  planLedgerWrite, readLedger, appendLedger, ledgerFreshness, renderLedger,
} from '../scripts/probe.mjs';

const f = (over = {}) => ({ rule: 'arity-mismatch', severity: 'warn', file: 'scripts/a.mjs', line: 10, message: 'call runs/views: 3 args vs definition 2', why: 'x', evidence: 'y', ...over });

test('normalizeMessage drops line references but keeps counts', () => {
  assert.equal(normalizeMessage('改到 src/a.js:12:3'), normalizeMessage('改到 src/a.js:99'));
  assert.equal(normalizeMessage('第 12 行的定义'), normalizeMessage('第 77 行的定义'));
  assert.equal(normalizeMessage('line 41 has no binding'), normalizeMessage('line 9 has no binding'));
  assert.notEqual(normalizeMessage('18 处调用 / 0 绑定'), normalizeMessage('19 处调用 / 0 绑定'), 'a changing count is a real difference');
});

test('stableKey survives line drift, exactKey does not', () => {
  const a = f({ line: 10 });
  const b = f({ line: 240 });
  assert.equal(stableKey(a), stableKey(b));
  assert.notEqual(exactKey(a), exactKey(b));
  assert.notEqual(stableKey(a), stableKey(f({ file: 'scripts/b.mjs' })));
  assert.notEqual(stableKey(a), stableKey(f({ rule: 'empty-catch' })));
});

test('diffFindings separates added / removed / line drift', () => {
  const base = [f({ line: 10 }), f({ rule: 'empty-catch', line: 5 })];
  const variant = [
    f({ line: 240 }),                                  // same defect, moved -> drift
    f({ rule: 'empty-catch', line: 5 }),               // unchanged
    f({ rule: 'js-loose-equality', message: '== instead of ===', line: 7 }), // new
  ];
  const d = diffFindings(base, variant);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].rule, 'js-loose-equality');
  assert.equal(d.removed.length, 0);
  assert.equal(d.lineDrift.length, 1);
  assert.equal(d.lineDrift[0].finding.line, 240);
  assert.deepEqual(d.lineDrift[0].baseLines, [10]);

  const gone = diffFindings(base, [f({ line: 10 })]);
  assert.equal(gone.removed.length, 1);
  assert.equal(gone.removed[0].rule, 'empty-catch');
});

test('ruleDelta reports only rules whose count moved', () => {
  const base = [f(), f({ rule: 'empty-catch' })];
  const variant = [f(), f(), f({ rule: 'empty-catch' })];
  assert.deepEqual(countByRule(variant), { 'arity-mismatch': 2, 'empty-catch': 1 });
  assert.deepEqual(ruleDelta(base, variant), { 'arity-mismatch': 1 });
  assert.deepEqual(ruleDelta(base, base), {});
});

test('resolvedHarness drops explicitFlags and nothing else', () => {
  const m = { preset: 'brief', tier: 'core', rules: { ruleset: 'aa' }, knobs: { duplication: false }, explicitFlags: ['--json'], z: 1 };
  const r = resolvedHarness(m);
  assert.equal(r.explicitFlags, undefined);
  assert.equal(r.preset, 'brief');
  assert.equal(r.z, 1);
  assert.equal(JSON.stringify(resolvedHarness({ ...m, explicitFlags: ['--all-rules'] })), JSON.stringify(r));
});

// ── the probe loop, with the review run injected (no child processes) ───────
const harnessFor = (preset, tier, ruleset) => ({ tool: 'archnav/review-rules', preset, tier, rules: { enabled: 54, registry: 61, extended: 7, ruleset }, knobs: { duplication: false }, explicitFlags: [], scope: { mode: 'unstaged', via: 'git', files: 3 }, index: { commit: 'abc1234', dir: '/x' }, model: null });

test('probe flags a dead knob and keeps a real difference distinct', () => {
  const findings = [f(), f({ rule: 'empty-catch', line: 5 })];
  const calls = [];
  const runner = ({ args }) => {
    calls.push(args.join(' '));
    // `--all-rules` is the dead-knob fixture: same manifest, same findings.
    // `--standard` is the real change: manifest and findings both differ.
    const real = args.includes('--standard');
    return {
      ok: true, error: null, ms: 10, bytes: real ? 2000 : 1000,
      json: {
        harness: { ...harnessFor(real ? 'standard' : 'brief', real ? 'all' : 'core', real ? 'bb' : 'aa'), explicitFlags: args },
        findings: real ? [...findings, f({ rule: 'duplication-clone', line: 9 })] : findings,
        checklist: { summary: {}, rows: [] },
      },
    };
  };
  const result = runProbe({
    dir: '.', scope: 'unstaged',
    variants: [{ name: 'brief', args: [] }, { name: 'all-rules', args: ['--all-rules'] }, { name: 'standard', args: ['--standard'] }],
    runner,
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(result.deadKnobs, ['all-rules'], 'manifest identical except explicitFlags + no behavioral change = not wired');
  assert.equal(result.diffs['all-rules'].deadKnob, true);
  assert.equal(result.diffs['all-rules'].resolvedIdentical, true);
  assert.equal(result.diffs['standard'].deadKnob, false);
  assert.equal(result.diffs['standard'].added, 1);
  assert.equal(result.diffs['standard'].addedByRule['duplication-clone'], 1);
  assert.equal(result.diffs['standard'].deltaBytes, 1000);
});

test('probe marks "manifest changed but behavior did not" as an honest no-op, not a dead knob', () => {
  const findings = [f()];
  const runner = ({ args }) => {
    const on = args.includes('--duplication');
    return {
      ok: true, error: null, ms: 5, bytes: 900,
      json: {
        harness: { ...harnessFor('brief', 'core', 'aa'), explicitFlags: args, knobs: { duplication: on } },
        findings, checklist: { summary: {}, rows: [] },
      },
    };
  };
  const result = runProbe({ dir: '.', variants: [{ name: 'off', args: [] }, { name: 'dup', args: ['--duplication'] }], runner });
  assert.deepEqual(result.deadKnobs, [], 'the knob did resolve (knobs.duplication changed)');
  assert.equal(result.diffs.dup.behaviorIdentical, true);
  assert.equal(result.diffs.dup.resolvedIdentical, false);
});

test('a failed variant is reported, not thrown', () => {
  const runner = ({ args }) => (args.includes('--bogus')
    ? { ok: false, error: 'unknown option --bogus', ms: 3, bytes: 0, json: null }
    : { ok: true, error: null, ms: 3, bytes: 100, json: { harness: harnessFor('brief', 'core', 'aa'), findings: [], checklist: { rows: [] } } });
  const result = runProbe({ dir: '.', variants: [{ name: 'base', args: [] }, { name: 'bad', args: ['--bogus'] }], runner });
  assert.equal(result.diffs.bad.error, 'unknown option --bogus');
  assert.deepEqual(result.deadKnobs, []);
  const md = renderMarkdown(result);
  assert.match(md, /❌ unknown option --bogus/);
});

test('markdown carries the task, the table, and the dead-knob verdict', () => {
  const findings = [f()];
  const runner = ({ args }) => ({
    ok: true, error: null, ms: 8, bytes: 1200,
    json: { harness: { ...harnessFor('brief', 'core', 'aa'), explicitFlags: args }, findings, checklist: { rows: [] } },
  });
  const md = renderMarkdown(runProbe({ dir: '/repo', variants: [{ name: 'brief', args: [] }, { name: 'all-rules', args: ['--all-rules'] }], runner }));
  assert.match(md, /# Harness probe — /);
  assert.match(md, /repo/);
  assert.match(md, /\| 变体 \| preset\/tier \| findings/);
  assert.match(md, /死旋钮/);
  assert.match(md, /model=none/);
});

test('parseArgs reads repeated --variant specs without a shell', () => {
  const opts = parseArgs(['.', '--scope', 'staged', '--variant', 'brief=', '--variant', 'standard=--standard --no-compact', '--fail-on-noop']);
  assert.equal(opts.scope, 'staged');
  assert.deepEqual(opts.variants, [
    { name: 'brief', args: [] },
    { name: 'standard', args: ['--standard', '--no-compact'] },
  ]);
  assert.equal(opts.failOnNoop, true);
});

// ── adoption ledger (③) ─────────────────────────────────────────────────────
const mkResult = ({ deadKnob = false, behaviorIdentical = false } = {}) => ({
  task: { dir: 'C:\\repo', scope: 'unstaged', base: null, at: '2026-10-21T00:00:00.000Z' },
  baseline: 'brief',
  variants: [
    { name: 'brief', args: [], ok: true, ms: 100, bytes: 1000, findings: 2, harness: { ...harnessFor('brief', 'core', 'aa'), explicitFlags: [] } },
    { name: 'standard', args: ['--standard'], ok: true, ms: 200, bytes: 2000, findings: 4, harness: { ...harnessFor('standard', 'all', 'bb'), explicitFlags: ['--standard'] } },
  ],
  diffs: {
    standard: {
      added: 2, removed: 0, lineDrift: 0, addedByRule: { 'duplication-clone': 2 }, removedByRule: {},
      ruleDelta: { 'duplication-clone': 2 }, resolvedIdentical: false, behaviorIdentical, deadKnob,
      deltaBytes: 1000, deltaMs: 100,
    },
  },
  deadKnobs: deadKnob ? ['standard'] : [],
});

test('ledger refuses an adoption without a reason, a real variant, or real behavior change', () => {
  const r = mkResult();
  assert.equal(planLedgerWrite({ result: r, kind: 'adopt', variant: 'standard', lesson: '' }).ok, false);
  assert.match(planLedgerWrite({ result: r, kind: 'adopt', variant: 'standard', lesson: 'x' }).reason, /lesson/);
  assert.match(planLedgerWrite({ result: r, kind: 'adopt', variant: 'brief', lesson: '采纳基线' }).reason, /基线/);
  assert.match(planLedgerWrite({ result: r, kind: 'adopt', variant: 'nope', lesson: '随便写写' }).reason, /不在本次 probe/);
  assert.match(planLedgerWrite({ result: mkResult({ deadKnob: true }), kind: 'adopt', variant: 'standard', lesson: '加点规则' }).reason, /死旋钮/);
  assert.match(planLedgerWrite({ result: mkResult({ behaviorIdentical: true }), kind: 'adopt', variant: 'standard', lesson: '加点规则' }).reason, /零差异/);
});

test('a real adoption records the harness pair, the evidence, and the reason', () => {
  const plan = planLedgerWrite({
    result: mkResult(), kind: 'adopt', variant: 'standard',
    lesson: '遗留 PHP 仓：standard 多出的克隆命中是真问题，值得每轮跑',
    by: 'z', probeOut: 'runs/probe.json', ts: '2026-10-21T01:02:03.000Z',
  });
  assert.equal(plan.ok, true);
  const rec = plan.record;
  assert.equal(rec.kind, 'adopt');
  assert.equal(rec.harness.baseline.ruleset, 'aa');
  assert.equal(rec.harness.variant.ruleset, 'bb');
  assert.equal(rec.harness.variant.tier, 'all');
  assert.deepEqual([rec.evidence.added, rec.evidence.removed], [2, 0]);
  assert.equal(rec.evidence.ruleDelta['duplication-clone'], 2);
  assert.equal(rec.probe_out, 'runs/probe.json');
  assert.equal(rec.by, 'z');
  assert.equal(rec.ts, '2026-10-21T01:02:03.000Z');
  assert.match(rec.lesson, /standard/);
});

test('a dead knob can be rejected (that is the bug report) but never adopted', () => {
  const plan = planLedgerWrite({ result: mkResult({ deadKnob: true }), kind: 'reject', variant: 'standard', lesson: 'flag 没接线，先修 applyMode' });
  assert.equal(plan.ok, true);
  assert.equal(plan.record.kind, 'reject');
});

test('ledger is append-only JSONL and survives a corrupt line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-ledger-'));
  const file = path.join(dir, 'nested', 'harness-ledger.jsonl');
  const plan = planLedgerWrite({ result: mkResult(), kind: 'adopt', variant: 'standard', lesson: '实证有效' });
  appendLedger(file, plan.record);
  appendLedger(file, planLedgerWrite({ result: mkResult({ deadKnob: true }), kind: 'reject', variant: 'standard', lesson: '死旋钮' }).record);
  fs.appendFileSync(file, '{not json\n');
  const rows = readLedger(file);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, 'adopt');
  assert.equal(rows[1].kind, 'reject');
  assert.ok(rows[2].bad, 'corrupt line is surfaced, not silently dropped');
  assert.deepEqual(readLedger(path.join(dir, 'missing.jsonl')), []);
});

test('ledger marks records stale once the rule set they were adopted against is gone', () => {
  const rec = { ts: '2026-10-21T00:00:00Z', kind: 'adopt', variant: 'standard', lesson: '旧的采纳', harness: { variant: { preset: 'standard', tier: 'all', ruleset: 'aa' } }, evidence: { added: 3, removed: 0, deltaBytes: 100, deltaMs: 5 } };
  assert.equal(ledgerFreshness(rec, ['aa', 'bb']), 'current');
  assert.equal(ledgerFreshness(rec, ['bb', 'cc']), 'stale');
  const md = renderLedger([rec, { bad: 'oops' }], { file: '.archnav/harness-ledger.jsonl', knownRulesets: ['bb', 'cc'] });
  assert.match(md, /需复核/);
  assert.match(md, /unreadable/);
  assert.match(md, /本机 \+ 本仓/);
  assert.match(renderLedger([], {}), /空/);
});
