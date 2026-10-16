/**
 * Unit tests for scripts/impact.mjs — our own impact analysis (entry points,
 * execution flows, risk grade). The graph here is synthetic on purpose: the
 * traversal rules are what is being pinned, not any particular repo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNode, classifyFile, scoreRisk, buildImpact, summarizeImpact, fileLayerMap, buildImpactChecklist, runImpact } from '../scripts/impact.mjs';

test('impact checklist rows mark 通过 / 命中 / 不适用 with reasons', () => {
  const summary = {
    direct: 6, indirect: 2, deepest: 3,
    routes: [{ node: 'route:GET /x', entryFile: 'routes/web.php', entryLine: 3 }],
    pages: [], flows: [], commands: [{ node: 'file:app/Console/Commands/Sync.php', kind: 'command', file: 'app/Console/Commands/Sync.php' }],
    layers: ['API (Controller)'],
  };
  const risk = scoreRisk({ direct: 6, indirect: 2, routes: 1, commands: 1, layers: 1 });
  const { rows, summary: sum } = buildImpactChecklist({ summary, risk, available: { routes: true, pages: true, flows: true }, changedCount: 1 });

  assert.deepEqual(rows.map((r) => r.id), ['impact.blast', 'impact.routes', 'impact.pages', 'impact.flows', 'impact.commands', 'impact.risk', 'impact.layers']);
  assert.equal(rows.find((r) => r.id === 'impact.blast').status, 'hit');
  assert.equal(rows.find((r) => r.id === 'impact.blast').hits, 8);
  assert.match(rows.find((r) => r.id === 'impact.blast').reason, /直接 6 · 间接 2 · 最深 3 跳/);
  assert.equal(rows.find((r) => r.id === 'impact.pages').status, 'pass', 'pages exist in this index but none affected');
  assert.equal(rows.find((r) => r.id === 'impact.layers').status, 'hit');
  assert.equal(rows.find((r) => r.id === 'impact.risk').status, 'hit', 'MEDIUM risk is a 命中 row');
  assert.match(rows.find((r) => r.id === 'impact.risk').reason, /^MEDIUM（直接影响面 \+12/);
  assert.equal(sum.hit, 5, 'blast + routes + commands + risk + layers');
  assert.equal(sum.na, 0);

  // a Laravel index has no page nodes → that row is 不适用, not a silent pass
  const noAvailability = buildImpactChecklist({ summary, risk, available: { routes: true, pages: false, flows: false }, changedCount: 1 });
  assert.match(noAvailability.rows.find((r) => r.id === 'impact.pages').reason, /没有页面节点/);
  assert.match(noAvailability.rows.find((r) => r.id === 'impact.flows').reason, /detectFlows/);
  assert.equal(noAvailability.summary.na, 2);
});

test('runImpact derives availability from the index and grades the change', () => {
  const run = runImpact({ index, seedNodes: ['sym:app/A.php::foo'], depth: 4, changedCount: 1 });
  assert.equal(run.available.routes, true);
  assert.equal(run.available.pages, false);
  assert.equal(run.available.flows, true);
  assert.deepEqual(run.summary.routes.map((r) => r.node), ['route:GET /x']);
  assert.equal(run.risk.level, 'LOW');
  const cl = buildImpactChecklist({ summary: run.summary, risk: run.risk, available: run.available, changedCount: 1 });
  assert.equal(cl.rows.find((r) => r.id === 'impact.routes').status, 'hit');
  assert.equal(cl.rows.find((r) => r.id === 'impact.pages').status, 'na');

  // no changed symbols → no blast radius, and the row says why
  const empty = buildImpactChecklist({
    summary: { direct: 0, indirect: 0, deepest: 0, routes: [], pages: [], flows: [], commands: [], layers: [] },
    risk: scoreRisk({}), available: run.available, changedCount: 0,
  });
  assert.equal(empty.rows.find((r) => r.id === 'impact.blast').status, 'na');
  assert.match(empty.rows.find((r) => r.id === 'impact.blast').reason, /没有改动符号/);
});

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
