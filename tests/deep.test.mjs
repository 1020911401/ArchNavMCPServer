/**
 * Unit tests for scripts/deep.mjs — repo-level deep analysis:
 * execution flows, clusters, cycles, module risk, cross-repo wiring.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { entryPoints, extractFlows, clusterFiles, findCycles, scoreModules, crossRepoEdges } from '../scripts/deep.mjs';

const index = {
  symbols: [
    { id: 'index', name: 'index', file: 'app/Http/Controllers/A.php', line_start: 10 },
    { id: 'svc', name: 'svc', file: 'app/Services/B.php', line_start: 5 },
    { id: 'repo', name: 'repo', file: 'app/Repositories/C.php', line_start: 7 },
    { id: 'helper', name: 'helper', file: 'app/Services/D.php', line_start: 3 },
  ],
  layerMap: { index: 'API (Controller)', svc: 'Business (Service)', repo: 'Data (Repository)' },
  knowledgeGraph: {
    nodes: [
      { id: 'route:GET /a', type: 'route', uri: '/a', file: 'routes/web.php', line: 3, controller: 'A', action: 'index' },
      { id: 'file:routes/web.php', type: 'file', file: 'routes/web.php' },
      { id: 'sym:app/Http/Controllers/A.php::index', type: 'symbol', file: 'app/Http/Controllers/A.php', line: 10 },
      { id: 'sym:app/Services/B.php::svc', type: 'symbol', file: 'app/Services/B.php', line: 5 },
      { id: 'sym:app/Repositories/C.php::repo', type: 'symbol', file: 'app/Repositories/C.php', line: 7 },
      { id: 'sym:app/Services/D.php::helper', type: 'symbol', file: 'app/Services/D.php', line: 3 },
      { id: 'sym:app/Services/B.php::builtin', type: 'symbol', file: 'app/Services/B.php' },
      { id: 'file:app/Console/Commands/Sync.php', type: 'file', file: 'app/Console/Commands/Sync.php' },
      { id: 'page:pages/x/index', type: 'page', file: 'pages.json' },
      { id: 'file:pages/x/index.vue', type: 'file', file: 'pages/x/index.vue' },
      { id: 'file:components/c.vue', type: 'file', file: 'components/c.vue' },
    ],
    edges: [
      { from: 'route:GET /a', to: 'sym:app/Http/Controllers/A.php::index', type: 'DEPENDS_ON', source_kind: 'route', confidence: 1 },
      { from: 'sym:app/Http/Controllers/A.php::index', to: 'sym:app/Services/B.php::svc', type: 'DEPENDS_ON', source_kind: 'ast', confidence: 0.85 },
      { from: 'sym:app/Services/B.php::svc', to: 'sym:app/Repositories/C.php::repo', type: 'DEPENDS_ON', source_kind: 'ast', confidence: 0.85 },
      { from: 'sym:app/Services/B.php::svc', to: 'sym:app/Services/B.php::builtin', type: 'DEPENDS_ON', source_kind: 'ast' },
      { from: 'sym:app/Services/B.php::svc', to: 'sym:app/Services/D.php::helper', type: 'DEPENDS_ON', source_kind: 'heuristic', confidence: 0.4 },
      { from: 'page:pages/x/index', to: 'file:pages/x/index.vue', type: 'CONTAINS', source_kind: 'pages.json' },
      { from: 'file:pages/x/index.vue', to: 'file:components/c.vue', type: 'DEPENDS_ON', source_kind: 'component' },
    ],
  },
};

test('entryPoints finds routes, pages and command files', () => {
  const e = entryPoints(index);
  assert.deepEqual(e.map((x) => x.kind).sort(), ['command', 'page', 'route']);
  assert.equal(e.find((x) => x.kind === 'route').name, 'GET /a');
  assert.equal(e.find((x) => x.kind === 'page').name, 'pages/x/index');
});

test('flows walk evidenced edges only, and skip unresolved placeholders', () => {
  const flows = extractFlows(index);
  const route = flows.find((f) => f.entryKind === 'route');
  assert.ok(route);
  // 3 real steps: index → svc → repo; the heuristic edge and the line-less
  // placeholder (`builtin`) are not steps
  assert.deepEqual(route.steps.map((s) => s.node), [
    'sym:app/Http/Controllers/A.php::index',
    'sym:app/Services/B.php::svc',
    'sym:app/Repositories/C.php::repo',
  ]);
  assert.deepEqual(route.steps.map((s) => s.depth), [1, 2, 3]);
  assert.equal(route.depth, 3);

  const withNoise = extractFlows(index, { includeHeuristic: true, includeUnresolved: true });
  const noisyRoute = withNoise.find((f) => f.entryKind === 'route');
  assert.equal(noisyRoute.steps.length, 5, 'heuristic + unresolved included on request');
});

test('uni-app flows are page → component chains (file steps count)', () => {
  const flows = extractFlows(index);
  const page = flows.find((f) => f.entryKind === 'page');
  assert.ok(page, 'the page entry produces a flow');
  assert.deepEqual(page.steps.map((s) => s.node), ['file:pages/x/index.vue', 'file:components/c.vue']);
  assert.deepEqual(page.steps.map((s) => s.kind), ['file', 'file']);
  assert.equal(page.steps[1].sourceKind, 'component');
});

test('clusters separate two weakly-linked groups and get distinct names', () => {
  // two disconnected pairs → modularity clustering must not merge them
  const twoGroups = {
    symbols: [
      { id: 'a1', name: 'a1', file: 'g1/x/a1.js' }, { id: 'a2', name: 'a2', file: 'g1/x/a2.js' },
      { id: 'b1', name: 'b1', file: 'g2/x/b1.js' }, { id: 'b2', name: 'b2', file: 'g2/x/b2.js' },
    ],
    layerMap: {},
    knowledgeGraph: {
      nodes: [],
      edges: [
        { from: 'file:g1/x/a1.js', to: 'file:g1/x/a2.js', type: 'DEPENDS_ON' },
        { from: 'file:g2/x/b1.js', to: 'file:g2/x/b2.js', type: 'DEPENDS_ON' },
      ],
    },
  };
  const two = clusterFiles(twoGroups);
  assert.equal(two.length, 2, 'disconnected groups stay separate');
  assert.deepEqual(two.map((c) => c.files).sort(), [2, 2]);
  assert.deepEqual(two.map((c) => c.dir).sort(), ['g1/x', 'g2/x']);
  assert.equal(two.every((c) => c.cohesion === 1), true, 'each group is fully internal');

  const clusters = clusterFiles(index);
  const names = clusters.map((c) => c.name);
  assert.ok(clusters.length >= 1);
  assert.equal(new Set(names).size, names.length, 'cluster names must be unique');
  assert.ok(clusters.every((c) => c.files > 0 && c.cohesion >= 0 && c.cohesion <= 1));
});

test('findCycles reports strongly connected components only', () => {
  const cyclical = JSON.parse(JSON.stringify(index));
  cyclical.knowledgeGraph.edges.push({ from: 'sym:app/Repositories/C.php::repo', to: 'sym:app/Services/B.php::svc', type: 'DEPENDS_ON', source_kind: 'ast' });
  const cycles = findCycles(cyclical);
  assert.equal(cycles.length, 1);
  assert.deepEqual([...cycles[0]].sort(), ['app/Repositories/C.php', 'app/Services/B.php']);
  assert.deepEqual(findCycles(index), [], 'a DAG has no cycles');
});

test('scoreModules bands LOW/MEDIUM/HIGH and lists every factor', () => {
  const clusters = [
    { name: 'big', files: 30, symbols: 100, externalEdges: 40, members: ['a.php', 'b.php', 'c.php'] },
    { name: 'small', files: 2, symbols: 5, externalEdges: 1, members: ['z.php'] },
  ];
  const cycles = [['a.php', 'b.php']];
  const findings = [
    { rule: 'x', severity: 'error', file: 'a.php' },
    { rule: 'y', severity: 'error', file: 'b.php' },
  ];
  const rows = scoreModules({ clusters, cycles, testFiles: new Set(), findings, duplicates: [{ file: 'a.php' }] });
  assert.equal(rows[0].name, 'big', 'highest score first');
  assert.equal(rows[0].level, 'HIGH');
  assert.ok(rows[0].reasons.some((r) => r.label === '循环依赖'));
  assert.ok(rows[0].reasons.some((r) => r.label === '规则阻断项'));
  assert.equal(rows.find((r) => r.name === 'small').level, 'LOW');
  assert.ok(rows.every((r) => r.reasons.every((x) => x.points > 0 && x.detail)));
});

test('crossRepoEdges matches front calls to backend routes and flags method drift', () => {
  const routes = [
    { method: 'GET', uri: 'order/list', file: 'routes/api.php', line: 1, controller: 'OrderController', action: 'index' },
    { method: 'GET', uri: 'order/pay', file: 'routes/api.php', line: 2, controller: 'OrderController', action: 'pay' },
    { method: 'GET', uri: 'patient/{id}', file: 'routes/api.php', line: 3 },
  ];
  const calls = [
    { file: 'api/order.js', line: 4, method: 'GET', path: 'order/list' },
    { file: 'api/order.js', line: 9, method: 'POST', path: 'order/pay' },
    { file: 'api/patient.js', line: 2, method: 'GET', path: 'patient/42' },
    { file: 'api/ghost.js', line: 1, method: 'GET', path: 'nothing/here' },
  ];
  const edges = crossRepoEdges({ frontPaths: calls, routes });
  assert.equal(edges.length, 3, 'the ghost path matches nothing');
  assert.equal(edges.find((e) => e.frontPath === 'order/list').sameMethod, true);
  assert.equal(edges.find((e) => e.frontPath === 'order/pay').sameMethod, false, 'POST vs GET is drift');
  assert.equal(edges.find((e) => e.frontPath === 'patient/42').controller, undefined);
  assert.equal(edges.find((e) => e.frontPath === 'patient/42').backRoute, 'GET patient/{id}');
});
