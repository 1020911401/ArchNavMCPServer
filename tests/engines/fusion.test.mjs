/**
 * Fusion layer unit tests — pure functions, no processes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCalls, mergeImpact, confidenceOf, SOURCE_BASE } from '../../src/fusion.js';

test('SOURCE_BASE matches the documented provenance table', () => {
  assert.deepEqual(SOURCE_BASE, { ast: 1.0, template: 0.9, import: 0.85, heuristic: 0.6 });
});

test('confidenceOf: bases and the two-engine agreement bonus', () => {
  assert.equal(confidenceOf({ source_kind: 'ast' }), 1.0);
  assert.equal(confidenceOf({ source_kind: 'template' }), 0.9);
  assert.equal(confidenceOf({ source_kind: 'import' }), 0.85);
  assert.equal(confidenceOf({ source_kind: 'heuristic' }), 0.6);
  // agreement bonus
  assert.equal(confidenceOf({ source_kind: 'import', engines: ['codegraph', 'gitnexus'] }), 0.95);
  assert.equal(confidenceOf({ source_kind: 'heuristic', engines: ['a', 'b'] }), 0.7);
  // capped at 1.0
  assert.equal(confidenceOf({ source_kinds: ['ast'], engines: ['a', 'b'] }), 1.0);
  // legacy singular engine field
  assert.equal(confidenceOf({ source_kind: 'import', engine: 'codegraph' }), 0.85);
  // unknown provenance degrades to the conservative base
  assert.equal(confidenceOf({}), 0.6);
});

test('mergeCalls: identical call site from two engines collapses to one edge', () => {
  const fused = mergeCalls([
    { engine: 'codegraph', symbol: 'foo', callers: [{ file: 'src/a.js', line: 10, enclosing: 'bar', engine: 'codegraph', source_kind: 'ast' }] },
    { engine: 'gitnexus', symbol: 'foo', callers: [{ file: 'src/a.js', line: 10, enclosing: 'bar', engine: 'gitnexus', source_kind: 'ast' }] },
  ]);
  assert.equal(fused.symbol, 'foo');
  assert.equal(fused.callers.length, 1);
  assert.deepEqual(fused.callers[0].engines, ['codegraph', 'gitnexus']);
  assert.equal(fused.callers[0].confidence, 1.0);
  assert.equal(fused.callers[0].file, 'src/a.js');
  assert.equal(fused.callers[0].line, 10);
});

test('mergeCalls: keeps distinct call sites in one file apart', () => {
  const fused = mergeCalls([
    { engine: 'codegraph', symbol: 'foo', callers: [
      { file: 'src/a.js', line: 5, enclosing: 'x', engine: 'codegraph', source_kind: 'ast' },
      { file: 'src/a.js', line: 42, enclosing: 'y', engine: 'codegraph', source_kind: 'ast' },
    ] },
  ]);
  assert.equal(fused.callers.length, 2);
  assert.deepEqual(fused.callers.map((c) => c.line), [5, 42]);
});

test('mergeCalls: null lines dedupe on enclosing so distinct callers survive', () => {
  const fused = mergeCalls([
    { engine: 'gitnexus', symbol: 'foo', callers: [
      { file: 'src/a.vue', line: null, enclosing: 'alpha', engine: 'gitnexus', source_kind: 'ast' },
      { file: 'src/a.vue', line: null, enclosing: 'beta', engine: 'gitnexus', source_kind: 'ast' },
      { file: 'src/a.vue', line: null, enclosing: 'beta', engine: 'gitnexus', source_kind: 'ast' },
    ] },
  ]);
  assert.equal(fused.callers.length, 2);
  assert.deepEqual(fused.callers.map((c) => c.enclosing), ['alpha', 'beta']);
});

test('mergeCalls: stable sort by file then line, missing lines last', () => {
  const fused = mergeCalls([
    { engine: 'codegraph', symbol: 'foo', callers: [
      { file: 'b.js', line: 1, engine: 'codegraph', source_kind: 'ast' },
      { file: 'a.js', line: 9, engine: 'codegraph', source_kind: 'ast' },
      { file: 'a.js', line: 2, engine: 'codegraph', source_kind: 'ast' },
      { file: 'a.js', line: null, enclosing: 'z', engine: 'gitnexus', source_kind: 'ast' },
    ] },
  ]);
  assert.deepEqual(
    fused.callers.map((c) => `${c.file}:${c.line}`),
    ['a.js:2', 'a.js:9', 'a.js:null', 'b.js:1'],
  );
});

test('mergeCalls: mixes import + ast provenance and reports sources/errors', () => {
  const fused = mergeCalls([
    { engine: 'codegraph', symbol: 'foo', callers: [
      { file: 'a.vue', line: 1, enclosing: null, engine: 'codegraph', source_kind: 'import' },
    ] },
    { engine: 'gitnexus', symbol: 'foo', callers: [], error: 'ambiguous_symbol' },
  ]);
  assert.equal(fused.callers.length, 1);
  assert.equal(fused.callers[0].source_kind, 'import');
  assert.equal(fused.callers[0].confidence, 0.85);
  assert.deepEqual(fused.engines, ['codegraph']);
  assert.deepEqual(fused.sources, [
    { engine: 'codegraph', count: 1, error: null },
    { engine: 'gitnexus', count: 0, error: 'ambiguous_symbol' },
  ]);
  assert.deepEqual(fused.errors, [{ engine: 'gitnexus', error: 'ambiguous_symbol' }]);
});

test('mergeCalls: accepts a single result object and an {engine: result} map', () => {
  const one = mergeCalls({ engine: 'codegraph', symbol: 'foo', callers: [{ file: 'a.js', line: 1, engine: 'codegraph', source_kind: 'ast' }] });
  assert.equal(one.callers.length, 1);
  const map = mergeCalls({
    codegraph: { symbol: 'foo', callers: [{ file: 'a.js', line: 1, engine: 'codegraph', source_kind: 'ast' }] },
    gitnexus: { symbol: 'foo', callers: [{ file: 'a.js', line: 1, engine: 'gitnexus', source_kind: 'ast' }] },
  });
  assert.equal(map.callers.length, 1);
  assert.deepEqual(map.callers[0].engines, ['codegraph', 'gitnexus']);
});

test('mergeImpact: merges direct/indirect regions and keeps the worst risk', () => {
  const merged = mergeImpact([
    { engine: 'archnav', symbol: 'foo', direct_impact: [{ symbol: 'a', file: 'a.js', line: 1 }] },
    { engine: 'gitnexus', symbol: 'foo', risk: 'high', direct: [{ symbol: 'a', file: 'a.js', line: 1 }], indirect: [{ symbol: 'b', file: 'b.js', line: 2 }] },
  ]);
  assert.equal(merged.symbol, 'foo');
  assert.equal(merged.risk, 'high');
  assert.equal(merged.direct.length, 1);
  assert.deepEqual(merged.direct[0].engines, ['archnav', 'gitnexus']);
  assert.equal(merged.indirect.length, 1);
  assert.equal(merged.indirect[0].engines.join(), 'gitnexus');
});
