/**
 * `analyze --ignore` — the gap that a self-review exposed: ArchNav's own bench/
 * fixtures (customer code, gitignored) were indexed as if they were our code, so a
 * self-review reported 5 836 symbols and 5 069 findings instead of 448 / 21.
 * The exclusions must also be honoured by staleness, or `status` would keep
 * reporting the ignored files as newly added.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, globToRegExp, makeIgnoreFilter, normalizeIgnore, pruneIgnored, getIndex, saveIndex } from '../src/analyzer.js';
import { checkStaleness } from '../src/confidence.js';

test('globToRegExp: bare names, **, * and ? behave like people expect', () => {
  const m = (glob, p) => globToRegExp(glob).test(p);
  // bare name → any path segment
  assert.equal(m('bench', 'bench/x.js'), true);
  assert.equal(m('bench', 'a/bench/x.js'), true);
  assert.equal(m('bench', 'benchmark/x.js'), false, 'no prefix match');
  // dir/** → everything below
  assert.equal(m('bench/**', 'bench/a/b/c.js'), true);
  assert.equal(m('bench/**', 'other/bench.js'), false);
  // **/name/** → anywhere
  assert.equal(m('**/vendor/**', 'a/vendor/x.js'), true);
  assert.equal(m('**/vendor/**', 'src/vendor.js'), false);
  // single * does not cross a slash
  assert.equal(m('src/*.js', 'src/a.js'), true);
  assert.equal(m('src/*.js', 'src/a/b.js'), false);
  assert.equal(m('src/?.js', 'src/a.js'), true);
  assert.equal(globToRegExp(''), null);
});

test('normalizeIgnore accepts an array or a comma-separated string', () => {
  assert.deepEqual(normalizeIgnore('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(normalizeIgnore(['a', ' b ']), ['a', 'b']);
  assert.deepEqual(normalizeIgnore(undefined), []);
  assert.deepEqual(normalizeIgnore([]), []);
});

test('analyze --ignore skips the tree and records the patterns in the index', async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-ignore-'));
  fs.mkdirSync(path.join(T, 'src'), { recursive: true });
  fs.mkdirSync(path.join(T, 'bench', 'app'), { recursive: true });
  fs.writeFileSync(path.join(T, 'src', 'a.js'), 'export function keepMe() { return 1; }\n');
  fs.writeFileSync(path.join(T, 'bench', 'app', 'b.js'), 'export function dropMe() { return 2; }\n');

  const without = await analyze(T, {});
  assert.deepEqual(without.symbols.map((s) => s.name).sort(), ['dropMe', 'keepMe']);

  const withIgnore = await analyze(T, { ignore: 'bench/**,**/node_modules/**' });
  assert.deepEqual(withIgnore.symbols.map((s) => s.name), ['keepMe'], 'ignored tree contributes nothing');
  assert.deepEqual(withIgnore.files.map((f) => f.replace(/\\/g, '/')), ['src/a.js']);
  assert.deepEqual(withIgnore.ignore, ['bench/**', '**/node_modules/**']);
  const keptIds = withIgnore.knowledgeGraph.nodes.filter((n) => String(n.id).includes('dropMe'));
  assert.equal(keptIds.length, 0, 'no graph node for an ignored file');

  // the ignored files must not read as freshly "added" afterwards
  saveIndex(T, withIgnore._raw || withIgnore);
  const freshness = await checkStaleness(T);
  assert.equal(freshness.changedDetails.some((d) => d.file.includes('bench/')), false, 'staleness honours index.ignore');

  // index round-trip: the patterns survive saveIndex
  const idx = getIndex(T);
  assert.deepEqual(idx.ignore, ['bench/**', '**/node_modules/**']);
  fs.rmSync(T, { recursive: true, force: true });
});

test('pruneIgnored drops nodes and their edges but keeps non-file nodes', () => {
  const kg = {
    nodes: [
      { id: 'file:src/a.js', type: 'file', file: 'src/a.js' },
      { id: 'file:bench/x.js', type: 'file', file: 'bench/x.js' },
      { id: 'sym:bench/x.js::gone', type: 'symbol', file: 'bench/x.js' },
      { id: 'layer:Utilities', type: 'layer' },
    ],
    edges: [
      { from: 'file:src/a.js', to: 'layer:Utilities', type: 'BELONGS_TO' },
      { from: 'file:bench/x.js', to: 'layer:Utilities', type: 'BELONGS_TO' },
      { from: 'sym:bench/x.js::gone', to: 'file:src/a.js', type: 'DEPENDS_ON' },
    ],
  };
  const pruned = pruneIgnored(kg, makeIgnoreFilter('bench/**'));
  assert.deepEqual(pruned.nodes.map((n) => n.id).sort(), ['file:src/a.js', 'layer:Utilities']);
  assert.equal(pruned.edges.length, 1);
  assert.equal(pruned.edges[0].from, 'file:src/a.js');
  assert.equal(pruned.prunedIgnored, 2);
});
