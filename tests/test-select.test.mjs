/**
 * Unit tests for scripts/test-select.mjs — the change → unit-test selector.
 *
 * These exercise `selectTests()` as a pure function over a change-impact result
 * (no index, no git), which is exactly the shape `archNav.changes()` returns.
 * The end-to-end behaviour (git diff → symbols → tests) is covered by running
 * the script against a repo; here we pin the selection *rules*.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTests, isTestFile } from '../scripts/test-select.mjs';

const changes = {
  scope: 'unstaged',
  via: 'git',
  changed_files: [{ file: 'src/confidence.js', ranges: [[27, 27]], symbols: ['normalizeRel'] }],
  changed_symbols: [
    { symbol: 'normalizeRel', kind: 'function', file: 'src/confidence.js', line_start: 26, line_end: 28, confidence: 0.5 },
  ],
  impacted: [
    { kind: 'symbol', file: 'tests/confidence.test.mjs', line: 30, symbol: 'test', depth: 2, from_changed: 'normalizeRel' },
    { kind: 'symbol', file: 'src/navigation.js', line: 850, symbol: 'changes', depth: 1, from_changed: 'normalizeRel' },
  ],
  unmapped_files: [],
};

test('isTestFile matches test dirs and *.test.* / *.spec.* files only', () => {
  assert.equal(isTestFile('tests/confidence.test.mjs'), true);
  assert.equal(isTestFile('tests/engines/fusion.test.mjs'), true);
  assert.equal(isTestFile('src/__tests__/a.js'), true);
  assert.equal(isTestFile('spec/thing.spec.ts'), true);
  assert.equal(isTestFile('src/confidence.js'), false);
  assert.equal(isTestFile('src/parsers/typescript.js'), false);
  // "test" as a mere substring must not qualify a source file.
  assert.equal(isTestFile('src/latest.js'), false);
});

test('only test files from the impact list are selected, with their depth', () => {
  const sel = selectTests(changes);
  assert.deepEqual(sel.tests, ['tests/confidence.test.mjs']);
  assert.equal(sel.test_depths['tests/confidence.test.mjs'], 2);
  assert.equal(sel.impacted_non_test, 1, 'the src/ navigation.js row is not a test');
});

test('a changed symbol is mapped to the tests that reach it', () => {
  const sel = selectTests(changes);
  assert.deepEqual(sel.changed_symbols[0].tests, ['tests/confidence.test.mjs']);
  assert.deepEqual(sel.uncovered_symbols, []);
});

test('a change nothing reaches is reported as uncovered (the CI gate case)', () => {
  const sel = selectTests({
    ...changes,
    changed_files: [{ file: 'src/parsers/python.js', ranges: [[17, 17]], symbols: ['parsePythonFile'] }],
    changed_symbols: [
      { symbol: 'parsePythonFile', kind: 'function', file: 'src/parsers/python.js', line_start: 16, line_end: 40, confidence: 0.5 },
    ],
    impacted: [],
  });
  assert.deepEqual(sel.tests, []);
  assert.deepEqual(sel.uncovered_symbols.map((s) => s.symbol), ['parsePythonFile']);
});

test('editing a test file itself puts it in the run set (no inbound edge needed)', () => {
  const sel = selectTests({
    ...changes,
    changed_files: [{ file: 'tests/impact.test.mjs', ranges: [[10, 10]], symbols: [] }],
    changed_symbols: [],
    impacted: [],
  });
  assert.deepEqual(sel.tests, ['tests/impact.test.mjs']);
});

test('closest dependents sort first (depth 1 before depth 2)', () => {
  const sel = selectTests({
    ...changes,
    impacted: [
      { kind: 'symbol', file: 'tests/deep.test.mjs', line: 5, symbol: 't', depth: 2, from_changed: 'normalizeRel' },
      { kind: 'symbol', file: 'tests/direct.test.mjs', line: 5, symbol: 't', depth: 1, from_changed: 'normalizeRel' },
    ],
  });
  assert.deepEqual(sel.tests, ['tests/direct.test.mjs', 'tests/deep.test.mjs']);
});

test('the drift fallback note is carried through, never silently dropped', () => {
  const sel = selectTests({ ...changes, via: 'drift', note: 'git diff unavailable (not a repo)' });
  assert.equal(sel.via, 'drift');
  assert.match(sel.note, /git diff unavailable/);
});
