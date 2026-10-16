/**
 * Unit tests for scripts/impact.mjs — our own impact analysis (entry points,
 * execution flows, risk grade). The graph here is synthetic on purpose: the
 * traversal rules are what is being pinned, not any particular repo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNode, classifyFile, scoreRisk, buildImpact, summarizeImpact, fileLayerMap } from '../scripts/impact.mjs';

const index = {
  symbols: [
    { id: 'foo', name: 'foo', file: 'app/A.php', line_start: 10 },
    { id: 'bar', name: 'bar', file: 'app/B.php', line_start: 5 },
    { id: 'baz', name: 'baz', file: 'app/C.php', line_start: 7 },
  ],
  layerMap: { foo: 'API (Controller)', bar: 'Business (Service)' },
  knowledgeGraph: {
    nodes: [
      { id: 'sym:app/A.php::foo', type: 'symbol', file: 'app/A.php', line: 10 },
      { id: 'sym:app/B.php::bar', type: 'symbol', file: 'app/B.php', line: 5 },
      { id: 'sym:app/C.php::baz', type: 'symbol', file: 'app/C.php', line: 7 },
      { id: 'route:GET /x', type: 'route', uri: '/x', file: 'routes/web.php', line: 3 },
      { id: 'flow:checkout', type: 'flow' },
      { id: 'file:app/B.php', type: 'file', file: 'app/B.php' },
    ],
    edges: [
      { from: 'sym:app/B.php::bar', to: 'sym:app/A.php::foo', type: 'DEPENDS_ON' },
      { from: 'sym:app/C.php::baz', to: 'sym:app/B.php::bar', type: 'DEPENDS_ON' },
      { from: 'route:GET /x', to: 'sym:app/C.php::baz', type: 'DEPENDS_ON', source_kind: 'route' },
      { from: 'flow:checkout', to: 'sym:app/B.php::bar', type: 'HAS_STEP' },
    ],
  },
};

test('classifyNode / classifyFile recognise entry kinds', () => {
  assert.equal(classifyNode('route:GET /x'), 'route');
  assert.equal(classifyNode('page:pages/a/index'), 'page');
  assert.equal(classifyNode('flow:checkout'), 'flow');
  assert.equal(classifyNode('sym:app/A.php::foo'), null);
  assert.equal(classifyFile('app/Console/Commands/Sync.php'), 'command');
  assert.equal(classifyFile('app/Jobs/Send.php'), 'job');
  assert.equal(classifyFile('app/Listeners/Ping.php'), 'event');
  assert.equal(classifyFile('routes/web.php'), 'routes-file');
  assert.equal(classifyFile('app/Models/A.php'), null);
});

test('buildImpact walks reverse edges to the requested depth and keeps the path', () => {
  const seeds = ['sym:app/A.php::foo'];
  const d2 = buildImpact({ index, seedNodes: seeds, depth: 2 });
  assert.deepEqual(d2.filter((r) => r.depth === 1).map((r) => r.node), ['sym:app/B.php::bar']);
  assert.deepEqual(d2.filter((r) => r.depth === 2).map((r) => r.node).sort(), ['flow:checkout', 'sym:app/C.php::baz']);
  assert.equal(d2.some((r) => r.entry === 'route'), false, 'route sits at depth 3, so depth 2 must not claim it');

  const d4 = buildImpact({ index, seedNodes: seeds, depth: 4 });
  const route = d4.find((r) => r.entry === 'route');
  assert.ok(route, 'depth 4 reaches the HTTP entry point');
  assert.equal(route.node, 'route:GET /x');
  assert.equal(route.depth, 3);
  assert.equal(route.via, 'sym:app/C.php::baz', 'every row says which node led to it');
  assert.equal(route.entryFile, 'routes/web.php');
  assert.equal(route.entryLine, 3);
});

test('summarizeImpact groups entry points and reports the layers touched', () => {
  const rows = buildImpact({ index, seedNodes: ['sym:app/A.php::foo'], depth: 4 });
  const s = summarizeImpact({ rows, changedSymbols: [index.symbols[0]], fileLayers: fileLayerMap(index), depth: 4 });
  assert.equal(s.direct, 1);
  assert.equal(s.indirect, 1);
  assert.deepEqual(s.routes.map((r) => r.node), ['route:GET /x']);
  assert.deepEqual(s.flows.map((r) => r.node), ['flow:checkout']);
  // only *affected* files contribute layers: the changed seed (app/A.php → API)
  // is not in the rows, its caller (app/B.php → Business) is.
  assert.deepEqual(s.layers, ['Business (Service)'], 'layer map is keyed by symbol id → resolved via file');
  assert.equal(s.deepest, 3);
});

test('scoreRisk is explainable and bands LOW / MEDIUM / HIGH', () => {
  const low = scoreRisk({ direct: 1 });
  assert.equal(low.level, 'LOW');
  assert.deepEqual(low.reasons.map((r) => r.label), ['直接影响面']);

  const medium = scoreRisk({ direct: 2, indirect: 2, routes: 3, errors: 1 });
  assert.equal(medium.level, 'MEDIUM');
  assert.equal(medium.score, 4 + 1 + 9 + 5);
  assert.ok(medium.reasons.every((r) => r.points > 0 && r.detail));

  const high = scoreRisk({ direct: 10, indirect: 20, routes: 5, pages: 5, flows: 2, errors: 2, uncovered: 3 });
  assert.equal(high.level, 'HIGH');
  assert.ok(high.score >= 40);

  // nothing measured → no phantom points
  assert.deepEqual(scoreRisk({}), { score: 0, level: 'LOW', reasons: [], maxDepth: 0 });
});

test('a seed with no incoming edges produces an empty, honest impact', () => {
  const rows = buildImpact({ index, seedNodes: ['sym:app/C.php::baz'], depth: 1 });
  assert.deepEqual(rows.map((r) => r.node), ['route:GET /x'], 'only the route points at baz');
  const s = summarizeImpact({ rows, changedSymbols: [], fileLayers: new Map(), depth: 1 });
  assert.equal(s.direct, 0);
  assert.equal(s.routes.length, 1);
});
