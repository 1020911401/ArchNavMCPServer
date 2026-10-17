/**
 * Unit tests for scripts/duplication.mjs — jscpd report normalisation + gate.
 *
 * The report shape is taken from a real jscpd 5.4.1 run (see the fixture numbers
 * in references/pitfall-coverage.md): duplicates[].{firstFile,secondFile,lines,tokens}
 * and statistics.total.percentage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJscpd, exceedsThreshold, buildJscpdFlags, buildDupChecklist, stripFormatSuffix, analyzeProvenance } from '../scripts/duplication.mjs';

test('jscpd format suffixes are stripped from SARIF paths but kept as evidence', () => {
  // code scanning rejects `README.md:text` outright ("URI scheme readme.md did not
  // match the checkout URI scheme file"), so the finding path must be the file.
  assert.equal(stripFormatSuffix('README.md:text'), 'README.md');
  assert.equal(stripFormatSuffix('pages/x/index.vue:javascript'), 'pages/x/index.vue');
  assert.equal(stripFormatSuffix('a/b.js'), 'a/b.js');
  assert.equal(stripFormatSuffix('C:/repo/src/a.js'), 'C:/repo/src/a.js', 'Windows drive letters stay intact');

  const rep = {
    duplicates: [{ lines: 30, tokens: 200, kind: 'exact', firstFile: { name: 'README.md:text', start: 5 }, secondFile: { name: 'docs/x.md:text', start: 9 } }],
    statistics: { total: { lines: 100, duplicatedLines: 30, percentage: 30 } },
  };
  const { findings } = normalizeJscpd(rep);
  assert.equal(findings[0].file, 'README.md');
  assert.equal(findings[0].line, 5);
  assert.match(findings[0].evidence, /format=text/);
  assert.equal(findings[0].message.includes(':text'), false, 'message 里不出现伪 scheme');
});

test('buildJscpdFlags maps our kinds onto jscpd flags (no home-grown similarity)', () => {
  assert.deepEqual(buildJscpdFlags({}), []);
  assert.deepEqual(buildJscpdFlags({ kinds: ['renamed'] }), ['--ignore-identifiers', '--ignore-literals']);
  assert.deepEqual(buildJscpdFlags({ kinds: ['similar'], similarity: 0.75 }), ['--similarity', '0.75']);
  assert.deepEqual(buildJscpdFlags({ kinds: ['gap'], maxGapLines: 6 }), ['--max-gap-lines', '6']);
  assert.deepEqual(buildJscpdFlags({ kinds: ['semantic'] }), ['--semantic']);
  assert.deepEqual(buildJscpdFlags({ kinds: ['ALL'] }).length, 6, 'all = renamed + similar + gap flags');
  assert.deepEqual(buildJscpdFlags({ changed: true, baselineFromRef: 'origin/main', blame: true }),
    ['--changed', '--baseline-from-ref', 'origin/main', '--blame']);
  assert.deepEqual(buildJscpdFlags({ changedOnly: true }).includes('--changed-only'), true);
  assert.deepEqual(buildJscpdFlags({ mode: 'weak' }), ['--mode', 'weak']);
});

const report = {
  duplicates: [
    {
      lines: 3076, tokens: 28651,
      firstFile: { name: 'pages/annex/components/verify/utils/crypto-js.js', start: 2 },
      secondFile: { name: 'pages/users/components/verify/utils/crypto-js.js', start: 2 },
    },
    {
      lines: 106, tokens: 706,
      firstFile: { name: 'views/home/index.blade.20211102.php', start: 1 },
      secondFile: { name: 'views/home/index.blade.php', start: 1 },
    },
    {
      lines: 4, tokens: 30,
      firstFile: { name: 'a.js', start: 1 },
      secondFile: { name: 'b.js', start: 9 },
    },
  ],
  statistics: {
    total: { lines: 259637, duplicatedLines: 23911, percentage: 9.209396195457504, sources: 1082 },
    formats: { javascript: { duplicatedLines: 12525, percentage: 16.98 }, sql: { duplicatedLines: 2287, percentage: 71.87 } },
  },
};

test('jscpd report → findings keeps both sides, line counts and the summary', () => {
  const { findings, summary } = normalizeJscpd(report);
  assert.equal(summary.clones, 3);
  assert.equal(summary.duplicated_lines, 23911);
  assert.equal(summary.total_lines, 259637);
  assert.equal(summary.percent, 9.209396195457504);
  assert.equal(summary.by_format.javascript.duplicatedLines, 12525);
  const big = findings.find((f) => f.message.includes('crypto-js.js:2'));
  assert.ok(big);
  assert.equal(big.rule, 'duplication-clone');
  assert.equal(big.line, 2);
  assert.match(big.message, /3076 行 \/ 28651 tokens/);
  assert.match(big.evidence, /second=pages\/users\/components\/verify\/utils\/crypto-js\.js:2/);
});

test('minLines filters tiny clones out of the report', () => {
  const { findings } = normalizeJscpd(report, { minLines: 50 });
  assert.equal(findings.length, 2);
  assert.ok(!findings.some((f) => f.message.includes('a.js:1')));
});

test('changed-only drops clones that touch nothing in the change set', () => {
  const changedFiles = ['views/home/index.blade.php', 'components/cart/index.vue'];
  const { findings } = normalizeJscpd(report, { changedFiles });
  // crypto-js clone: neither side changed → dropped
  assert.equal(findings.some((f) => f.message.includes('crypto-js.js')), false);
  // blade clone: one side is in the change set → warn
  const blade = findings.find((f) => f.message.includes('index.blade.20211102.php:1'));
  assert.ok(blade, 'the blade clone should survive');
  assert.equal(blade.severity, 'warn');
  // a.js/b.js pair is on neither list → dropped too
  assert.equal(findings.length, 1);
  // without changedFiles everything is reported, at info level
  assert.equal(normalizeJscpd(report).findings.every((f) => f.severity === 'info'), true);
});

test('changed-only never hides a clone that touches a changed file', () => {
  const { findings } = normalizeJscpd(report, { changedFiles: ['pages/users/components/verify/utils/crypto-js.js'] });
  assert.ok(findings.some((f) => f.severity === 'warn' && f.message.includes('crypto-js.js')));
});

test('provenance: how much of the diff is copied from existing lines (vs moved)', () => {
  const corpus = new Set(['const total = items.reduce((a, b) => a + b, 0);', 'function helper() { return 42; }']);
  const added = [
    'const total = items.reduce((a, b) => a + b, 0);',   // copied verbatim
    'function helper() { return 42; }',                   // copied verbatim
    'const brandNew = computeSomethingElse(1);',          // new
    '// short',                                            // too short / comment
  ];
  const r = analyzeProvenance({ addedLines: added, corpus, summary: ' rename app/a.php => app/b.php (95%)\n' });
  assert.equal(r.added_lines, 4);
  assert.equal(r.meaningful_added_lines, 3, 'comments and <12 char lines are not counted');
  assert.equal(r.copied_lines, 2);
  assert.ok(Math.abs(r.ratio - 2 / 3) < 1e-9);
  assert.equal(r.renames.length, 1, 'git rename summary means moved, not copied');

  // the checklist gets a row once provenance data exists
  const summary = { clones: 0, reported: 0, by_kind: {}, percent: 1, provenance: r };
  const cl = buildDupChecklist({ summary, opts: {} });
  const row = cl.rows.find((x) => x.id === 'dup.provenance');
  assert.equal(row.status, 'hit');
  assert.match(row.reason, /复制/);
});

test('the percentage gate is a pure function of the summary', () => {
  const { summary } = normalizeJscpd(report);
  assert.equal(exceedsThreshold(summary, 10), false);   // 9.21% < 10
  assert.equal(exceedsThreshold(summary, 9), true);     // 9.21% > 9
  assert.equal(exceedsThreshold(summary, null), false, 'no threshold = no gate');
  assert.equal(exceedsThreshold({ percent: null }, 5), false, 'unknown percentage must not fail the build');
});

test('clone kind and baseline novelty are carried into the finding', () => {
  const kinded = {
    duplicates: [
      { lines: 100, tokens: 800, kind: 'renamed', firstFile: { name: 'a.php', start: 1 }, secondFile: { name: 'b.php', start: 2 } },
      { lines: 120, tokens: 900, kind: 'similar', isNew: true, firstFile: { name: 'c.vue', start: 10 }, secondFile: { name: 'd.vue', start: 20 } },
    ],
    statistics: { total: { lines: 1000, duplicatedLines: 220, percentage: 22 } },
  };
  const { findings, summary } = normalizeJscpd(kinded);
  assert.deepEqual(summary.by_kind, { renamed: 1, similar: 1 });
  assert.equal(summary.new_clones, 1);
  const renamed = findings.find((f) => f.kind === 'renamed');
  assert.equal(renamed.severity, 'info', 'pre-existing clones are context, not a gate');
  assert.match(renamed.why, /Type-2/);
  const fresh = findings.find((f) => f.kind === 'similar');
  assert.equal(fresh.is_new, true);
  assert.equal(fresh.severity, 'warn', 'a clone the baseline never saw is this change’s duplication');
  assert.match(fresh.message, /\[similar\/new\]/);
  assert.match(fresh.why, /本次改动新引入/);
  assert.equal(normalizeJscpd(kinded).summary.new_by_kind.similar, 1, 'new clones are also counted per kind');
});

test('with a baseline gate the checklist counts only new clones; pre-existing ones become context', () => {
  const summary = {
    by_kind: { renamed: 103, exact: 1, similar: 1 }, new_by_kind: { renamed: 2 }, new_clones: 2,
    percent: 14.27, duplicated_lines: 2674, total_lines: 18734, clones: 105, reported: 105,
  };
  const gated = buildDupChecklist({ summary, opts: { kinds: ['renamed'], baselineFromRef: 'origin/main' } });
  const renamed = gated.rows.find((r) => r.id === 'dup.renamed');
  assert.equal(renamed.hits, 2, 'must not report 103 pre-existing clones as this change’s hits');
  assert.equal(renamed.status, 'hit');
  assert.match(renamed.reason, /另有 101 个存量克隆/);
  assert.equal(gated.rows.find((r) => r.id === 'dup.new').status, 'hit');
  assert.equal(gated.rows.find((r) => r.id === 'dup.similar').status, 'na', 'similar not enabled → 不适用');

  const ungated = buildDupChecklist({ summary, opts: { kinds: ['renamed'] } });
  assert.equal(ungated.rows.find((r) => r.id === 'dup.renamed').hits, 103, 'without a baseline the whole repo count is shown');
  assert.equal(ungated.rows.find((r) => r.id === 'dup.new').status, 'na');
  assert.match(ungated.rows.find((r) => r.id === 'dup.new').reason, /--changed\/--baseline/);
  assert.equal(ungated.rows.find((r) => r.id === 'dup.semantic').status, 'na');
});
