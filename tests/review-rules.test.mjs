/**
 * Unit tests for scripts/review-rules.mjs — the Vue/PHP review-rule layer.
 *
 * `reviewFindings()` is pure over (changes, index, readFile), so each rule is
 * pinned here against a hand-built index instead of a fixture repo. The
 * end-to-end behaviour (git diff → findings) is verified by running the script
 * against bench/php-app and bench/vue-app.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewFindings, renderFindings, extractFrontCalls, backendRoutes, compareBoundary, pathMatches, toSarif, toGithubAnnotations, scanContent, vforMissingKeys, hallucinationFindings, blankLiterals, joinPosix, buildChecklist, renderChecklist, RULE_REGISTRY } from '../scripts/review-rules.mjs';

test('checklist marks every registry rule as 通过 / 命中 / 不适用(带原因)', () => {
  const metaFull = {
    dir: '.', changedTotal: 3, changedPhp: 2, changedFront: 1, changedOther: 0, hasChanges: true,
    hasBackend: false, hasComposer: true, hasPackageJson: true, hasTests: true, hasIndex: true,
    symbols: 100, freshness: 'via=git',
  };
  const findings = [
    { rule: 'php-debug-left-on', severity: 'warn', file: 'a.php', line: 3, message: 'm', why: 'w', evidence: 'e' },
    { rule: 'php-debug-left-on', severity: 'warn', file: 'b.php', line: 9, message: 'm', why: 'w', evidence: 'e' },
    { rule: 'vue-v-html', severity: 'warn', file: 'c.vue', line: 1, message: 'm', why: 'w', evidence: 'e' },
  ];
  const { rows, summary } = buildChecklist({ findings, meta: metaFull });
  assert.equal(rows.length, RULE_REGISTRY.length, 'every known rule is listed');

  const dd = rows.find((r) => r.id === 'php-debug-left-on');
  assert.equal(dd.status, 'hit');
  assert.equal(dd.hits, 2);
  const clean = rows.find((r) => r.id === 'php-unbounded-query');
  assert.equal(clean.status, 'pass', 'a rule that ran and found nothing is 通过');
  assert.equal(clean.hits, 0);
  const boundary = rows.find((r) => r.id === 'fe-be-path-not-found');
  assert.equal(boundary.status, 'na');
  assert.match(boundary.reason, /--backend/);
  assert.equal(summary.hit, 2);
  assert.equal(summary.na, 5, 'the five boundary rules are 不适用 without a backend index');

  const out = renderChecklist(buildChecklist({ findings, meta: metaFull }));
  assert.match(out, /审核任务书/);
  assert.match(out, /✅ 通过/);
  assert.match(out, /⚠️\s+命中\(2\)/);
  assert.match(out, /➖ 不适用/);
  assert.match(out, /未检查（5 条，附原因）/);
});

test('checklist explains language and repo-shape skips instead of silently passing', () => {
  const meta = {
    dir: '.', changedTotal: 1, changedPhp: 0, changedFront: 1, changedOther: 0, hasChanges: true,
    hasBackend: false, hasComposer: false, hasPackageJson: false, hasTests: false, hasIndex: true,
    symbols: 10, freshness: 'via=git',
  };
  const { rows } = buildChecklist({ findings: [], meta });
  const php = rows.filter((r) => r.family === 'php');
  assert.ok(php.length > 5);
  assert.ok(php.every((r) => r.status === 'na' && r.reason === '本次没有 PHP 改动'), 'no PHP change → PHP rules are N/A, not 通过');
  const depRule = rows.find((r) => r.id === 'hallucinated-dependency');
  assert.match(depRule.reason, /package\.json/);
  const covRule = rows.find((r) => r.id === 'no-test-coverage');
  assert.match(covRule.reason, /没有测试文件/);

  // no changes at all → everything is N/A with that reason
  const empty = buildChecklist({ findings: [], meta: { ...meta, hasChanges: false, changedTotal: 0 } });
  assert.equal(empty.rows.every((r) => r.status === 'na'), true);
  assert.equal(empty.rows[0].reason, '本次没有改动');
});

const ids = (fs) => fs.map((f) => f.rule).sort();

function makeIndex(over = {}) {
  return {
    symbols: [
      { id: 'departments', name: 'departments', kind: 'function', file: 'app/Http/Controllers/Controller.php', line_start: 56, line_end: 66 },
      { id: 'VisitsController', name: 'VisitsController', kind: 'class', file: 'app/Http/Controllers/VisitsController.php', line_start: 11, line_end: 80 },
      { id: 'store', name: 'store', kind: 'function', file: 'app/Http/Controllers/PatientsController.php', line_start: 300, line_end: 340 },
      { id: 'store2', name: 'store', kind: 'function', file: 'app/Http/Controllers/VisitsController.php', line_start: 20, line_end: 60 },
      { id: '__construct', name: '__construct', kind: 'function', file: 'app/Http/Controllers/VisitsController.php', line_start: 12, line_end: 15 },
      { id: 'orderTake', name: 'orderTake', kind: 'function', file: 'api/order.js', line_start: 171, line_end: 200 },
      { id: 'orderTake2', name: 'orderTake', kind: 'function', file: 'api/activity.js', line_start: 293, line_end: 320 },
      ...(over.symbols || []),
    ],
    layerMap: over.layerMap ?? { departments: 'API (Controller)' },
    unresolvedRoutes: over.unresolvedRoutes ?? [],
    unresolvedPages: over.unresolvedPages ?? [],
    knowledgeGraph: { edges: over.edges ?? [] },
  };
}

function makeChanges(over = {}) {
  return {
    scope: 'unstaged', via: 'git',
    changed_files: [], changed_symbols: [], impacted: [], unmapped_files: [],
    ...over,
  };
}

test('Laravel: a changed controller whose route points at a missing action is an error', () => {
  const index = makeIndex({
    unresolvedRoutes: [{ method: 'GET', uri: 'visit/create', controller: 'VisitsController', action: 'create', file: 'routes/web.php', line: 85, reason: 'unknown-action' }],
  });
  const changes = makeChanges({
    changed_files: [{ file: 'app/Http/Controllers/VisitsController.php' }],
    changed_symbols: [{ symbol: 'VisitsController', file: 'app/Http/Controllers/VisitsController.php', line_start: 11, confidence: 0.5 }],
  });
  const f = reviewFindings({ changes, index, readFile: () => null });
  const route = f.find((x) => x.rule === 'php-route-unknown-action');
  assert.ok(route, 'expected php-route-unknown-action');
  assert.equal(route.severity, 'error');
  assert.match(route.message, /GET visit\/create/);
  assert.match(route.evidence, /VisitsController::create/);
});

test('Laravel: an unrelated unresolved route does not fire for an unrelated change', () => {
  const index = makeIndex({
    unresolvedRoutes: [{ method: 'GET', uri: 'visit/create', controller: 'VisitsController', action: 'create', file: 'routes/web.php', line: 85, reason: 'unknown-action' }],
  });
  const changes = makeChanges({ changed_files: [{ file: 'app/Models/Goal.php' }] });
  const f = reviewFindings({ changes, index, readFile: () => null });
  assert.deepEqual(ids(f).filter((r) => r === 'php-route-unknown-action'), []);
});

test('Laravel: changing routes/web.php surfaces the unresolved routes in that file', () => {
  const index = makeIndex({
    unresolvedRoutes: [{ method: 'GET', uri: 'visit/create', controller: 'VisitsController', action: 'create', file: 'routes/web.php', line: 85, reason: 'unknown-action' }],
  });
  const f = reviewFindings({ changes: makeChanges({ changed_files: [{ file: 'routes/web.php' }] }), index, readFile: () => null });
  assert.equal(ids(f).filter((r) => r === 'php-route-unknown-action').length, 1);
});

test('Laravel: a Model without $fillable/$guarded is flagged (content read from disk)', () => {
  const index = makeIndex();
  const changes = makeChanges({
    changed_files: [{ file: 'app/Models/Goal.php' }],
    changed_symbols: [{ symbol: 'Goal', file: 'app/Models/Goal.php', line_start: 9, confidence: 0.5 }],
  });
  const readFile = (rel) => (rel === 'app/Models/Goal.php' ? '<?php\nclass Goal extends Model {\n  protected $table = "goals";\n}\n' : null);
  const f = reviewFindings({ changes, index, readFile });
  assert.ok(ids(f).includes('php-mass-assignment'));
  // …and not when $fillable is present.
  const readFile2 = (rel) => (rel === 'app/Models/Goal.php' ? '<?php\nclass Goal extends Model {\n  protected $fillable = ["name"];\n}\n' : null);
  assert.ok(!ids(reviewFindings({ changes, index, readFile: readFile2 })).includes('php-mass-assignment'));
});

test('Laravel: Blade calls that the graph cannot bind are reported with counts', () => {
  const index = makeIndex({
    edges: [{ from: 'file:views/patients/create.blade.php', to: 'sym:app/Presenters/DepartmentPresenter.php::showSelectOptions', type: 'DEPENDS_ON', source_kind: 'template' }],
  });
  const changes = makeChanges({ changed_files: [{ file: 'views/patients/create.blade.php' }] });
  const readFile = () => '$a->one() $b->two() $c->three()';
  const f = reviewFindings({ changes, index, readFile });
  const blade = f.find((x) => x.rule === 'php-blade-unverified-calls');
  assert.ok(blade, 'expected php-blade-unverified-calls');
  assert.match(blade.evidence, /template calls=3, bound edges=1/);
});

test('backup / 副本 files are called out (the Chinese-filename trap)', () => {
  const f = reviewFindings({
    changes: makeChanges({ changed_files: [{ file: 'app/Http/Controllers/HomeController - 副本.php' }] }),
    index: makeIndex(), readFile: () => null,
  });
  assert.ok(ids(f).includes('backup-file-changed'));
  const f2 = reviewFindings({
    changes: makeChanges({ changed_files: [{ file: 'views/home/index.blade.20211102.php' }] }),
    index: makeIndex(), readFile: () => null,
  });
  assert.ok(ids(f2).includes('backup-file-changed'));
});

test('same-name methods are flagged, but lifecycle names are not', () => {
  const changes = makeChanges({
    changed_files: [{ file: 'app/Http/Controllers/PatientsController.php' }, { file: 'app/Http/Controllers/VisitsController.php' }],
    changed_symbols: [
      { symbol: 'store', file: 'app/Http/Controllers/PatientsController.php', line_start: 300, confidence: 0.5 },
      { symbol: '__construct', file: 'app/Http/Controllers/VisitsController.php', line_start: 12, confidence: 0.5 },
    ],
  });
  const f = reviewFindings({ changes, index: makeIndex(), readFile: () => null });
  const hits = f.filter((x) => x.rule.endsWith('same-name-method'));
  assert.equal(hits.length, 1, 'only the real trap should fire');
  assert.equal(hits[0].message.includes('store'), true);
  assert.equal(hits.some((x) => x.message.includes('__construct')), false);
});

test('uni-app: an unregistered page under pages/ is an error, a component under pages/*/components is not', () => {
  const index = makeIndex({
    symbols: [
      { id: 'p1', name: 'index', kind: 'function', file: 'pages/goods/list/index.vue', line_start: 1, line_end: 9 },
      { id: 'c1', name: 'index', kind: 'function', file: 'pages/admin/components/customForm/index.vue', line_start: 1, line_end: 9 },
    ],
    edges: [{ from: 'page:pages/goods/list/index', to: 'file:pages/goods/list/index.vue', type: 'CONTAINS' }],
  });
  const f = reviewFindings({
    changes: makeChanges({
      changed_files: [{ file: 'pages/activity/presell_details/index.vue' }, { file: 'pages/admin/components/customForm/index.vue' }],
    }),
    index, readFile: () => null,
  });
  const pages = f.filter((x) => x.rule === 'vue-page-not-registered');
  assert.equal(pages.length, 1);
  assert.equal(pages[0].file, 'pages/activity/presell_details/index.vue');
  assert.equal(pages[0].severity, 'error');
  // the registered page is fine
  const f2 = reviewFindings({
    changes: makeChanges({ changed_files: [{ file: 'pages/goods/list/index.vue' }] }),
    index, readFile: () => null,
  });
  assert.equal(f2.filter((x) => x.rule === 'vue-page-not-registered').length, 0);
});

test('uni-app: navigation problems are split by reason (unknown page vs dynamic url)', () => {
  const index = makeIndex({
    unresolvedPages: [
      { kind: 'navigation', file: 'mixins/skuSelect.js', line: 336, target: 'pages/activity/goods_details/index', via: 'uni.navigateTo', reason: 'unknown-page' },
      { kind: 'navigation', file: 'mixins/skuSelect.js', line: 342, target: null, via: 'uni.navigateTo', reason: 'dynamic-url' },
    ],
  });
  const f = reviewFindings({
    changes: makeChanges({ changed_files: [{ file: 'mixins/skuSelect.js' }] }),
    index, readFile: () => null,
  });
  assert.ok(ids(f).includes('vue-nav-unknown-page'));
  assert.ok(ids(f).includes('vue-nav-dynamic-url'));
  assert.ok(ids(f).includes('vue-global-blast'), 'mixins/ is a global blast radius');
  assert.equal(f.find((x) => x.rule === 'vue-nav-unknown-page').severity, 'error');
  assert.equal(f.find((x) => x.rule === 'vue-nav-dynamic-url').severity, 'info');
});

test('uni-app: a component nothing imports is flagged as an orphan', () => {
  const index = makeIndex({
    edges: [{ from: 'file:pages/index/index.vue', to: 'file:components/payment/index.vue', type: 'DEPENDS_ON' }],
  });
  const f = reviewFindings({
    changes: makeChanges({ changed_files: [{ file: 'components/indexGoods/index.vue' }, { file: 'components/payment/index.vue' }] }),
    index, readFile: () => null,
  });
  const orph = f.filter((x) => x.rule === 'vue-component-orphan');
  assert.deepEqual(orph.map((x) => x.file), ['components/indexGoods/index.vue']);
});

test('a repo with no test files reports that once instead of per-file coverage warnings', () => {
  const index = makeIndex();
  const changes = makeChanges({
    changed_files: [{ file: 'app/Http/Controllers/VisitsController.php' }],
    changed_symbols: [{ symbol: 'VisitsController', file: 'app/Http/Controllers/VisitsController.php', line_start: 11, confidence: 0.5 }],
  });
  const f = reviewFindings({ changes, index, readFile: () => null });
  assert.ok(ids(f).includes('repo-has-no-tests'));
  assert.equal(f.filter((x) => x.rule === 'no-test-coverage').length, 0);
});

test('an empty layerMap is reported as "the layer rules cannot judge this repo"', () => {
  const f = reviewFindings({ changes: makeChanges({ changed_files: [] }), index: makeIndex({ layerMap: {} }), readFile: () => null });
  assert.ok(ids(f).includes('layer-model-missing'));
  const f2 = reviewFindings({ changes: makeChanges({ changed_files: [] }), index: makeIndex(), readFile: () => null });
  assert.ok(!ids(f2).includes('layer-model-missing'));
});

test('front-end calls are extracted, dynamic concatenations marked separately', () => {
  const src = `
  export function orderList(data) { return request.get('order/list', data); }
  export function pay(data) { return request.post("order/pay", data); }
  export function refund(uni) { return request.get('order/refund/del/' + uni, {}); }
  export function other(data) { return uni.request({ url: '/x/y', method: 'POST' }); }
  `;
  const calls = extractFrontCalls(['api/order.js'], () => src);
  assert.deepEqual(calls.filter((c) => !c.dynamic).map((c) => `${c.method} ${c.path}`), ['GET order/list', 'POST order/pay']);
  assert.deepEqual(calls.filter((c) => c.dynamic).map((c) => `${c.method} ${c.path}`), ['GET order/refund/del/']);
});

test('backend routes come from the index route nodes', () => {
  const routes = backendRoutes({
    knowledgeGraph: {
      nodes: [
        { id: 'route:GET /', type: 'route', method: 'GET', uri: '/', file: 'routes/web.php', line: 20, controller: 'HomeController', action: 'index' },
        { id: 'file:routes/web.php', type: 'file' },
        { id: 'route:POST order/pay', type: 'route', method: 'POST', uri: 'order/pay', file: 'routes/api.php', line: 7 },
      ],
    },
  });
  assert.equal(routes.length, 2);
  assert.deepEqual(routes[1], { method: 'POST', uri: 'order/pay', file: 'routes/api.php', line: 7, controller: null, action: null });
});

test('path matching normalises slashes/query and treats :param / {param} as wildcards', () => {
  assert.equal(pathMatches('/customer/{customer}', 'customer/5'), true);
  assert.equal(pathMatches('order/pay/', '/order/pay?x=1'), true);
  assert.equal(pathMatches('order/pay', 'order/pay/extra'), false);
  assert.equal(pathMatches('order/pay', 'order/pay'), true);
  assert.equal(pathMatches('order/list', 'orders/list'), false);
});

test('boundary: matching endpoints pass, missing paths and method mismatches are errors', () => {
  const calls = [
    { file: 'api/order.js', method: 'GET', path: 'order/list', dynamic: false },
    { file: 'api/order.js', method: 'POST', path: 'order/pay', dynamic: false },
    { file: 'api/order.js', method: 'GET', path: 'order/gone', dynamic: false },
    { file: 'api/goods.js', method: 'GET', path: 'goods/detail/{id}', dynamic: false },
  ];
  const routes = [
    { method: 'GET', uri: 'order/list', file: 'routes/api.php', line: 1 },
    { method: 'GET', uri: 'order/pay', file: 'routes/api.php', line: 2 },
    { method: 'GET', uri: 'goods/detail/{id}', file: 'routes/api.php', line: 3 },
  ];
  const cmp = compareBoundary(calls, routes);
  assert.equal(cmp.pairSuspect, false, `matchRate=${cmp.matchRate}`);
  assert.deepEqual(cmp.missing.map((c) => c.path), ['order/gone']);
  assert.deepEqual(cmp.methodMismatch.map((m) => `${m.call.method} ${m.call.path}`), ['POST order/pay']);
  assert.ok(cmp.matched.some((m) => m.call.path === 'goods/detail/{id}'));
  assert.deepEqual(cmp.unused.map((r) => r.uri), ['order/pay']);
});

test('boundary: two indexes that are not a pair are reported once instead of per endpoint', () => {
  const calls = Array.from({ length: 30 }, (_, i) => ({ file: 'api/x.js', method: 'GET', path: `shop/thing${i}`, dynamic: false }));
  const routes = [{ method: 'GET', uri: 'admin/patient/list', file: 'routes/web.php', line: 1 }];
  const cmp = compareBoundary(calls, routes);
  assert.equal(cmp.pairSuspect, true);
  assert.match(String(cmp.matchRate), /^0(\.0*)?$/);
  const f = reviewFindings({
    changes: makeChanges({ changed_files: [{ file: 'api/x.js' }] }),
    index: makeIndex(), readFile: () => 'request.get("shop/thing1")',
    backendIndex: { knowledgeGraph: { nodes: [{ id: 'route:GET admin/patient/list', type: 'route', method: 'GET', uri: 'admin/patient/list', file: 'routes/web.php', line: 1 }] }, symbols: [] },
  });
  assert.deepEqual(ids(f).filter((r) => r === 'fe-be-pairing-suspect'), ['fe-be-pairing-suspect']);
  assert.equal(f.filter((x) => x.rule === 'fe-be-path-not-found').length, 0, 'no flood of fake 404s');
});

test('boundary: a real pair produces path-not-found / method-mismatch findings via reviewFindings', () => {
  const backendIndex = {
    symbols: [],
    knowledgeGraph: { nodes: [
      { id: 'route:GET order/list', type: 'route', method: 'GET', uri: 'order/list', file: 'routes/api.php', line: 1 },
      { id: 'route:GET order/pay', type: 'route', method: 'GET', uri: 'order/pay', file: 'routes/api.php', line: 2 },
    ] },
  };
  const readFile = () => "request.get('order/list', {}); request.post('order/pay', {}); request.get('order/gone', {});";
  const f = reviewFindings({
    changes: makeChanges({ changed_files: [{ file: 'api/order.js' }] }),
    index: makeIndex(), readFile, backendIndex,
  });
  assert.equal(f.filter((x) => x.rule === 'fe-be-path-not-found').length, 1);
  assert.equal(f.filter((x) => x.rule === 'fe-be-method-mismatch').length, 1);
  assert.equal(f.find((x) => x.rule === 'fe-be-path-not-found').severity, 'error');
});

test('boundary: dynamic concatenated request paths are flagged as a blind spot', () => {
  const backendIndex = { symbols: [], knowledgeGraph: { nodes: [{ id: 'route:GET order/list', type: 'route', method: 'GET', uri: 'order/list', file: 'routes/api.php', line: 1 }] } };
  const f = reviewFindings({
    changes: makeChanges({ changed_files: [{ file: 'api/order.js' }] }),
    index: makeIndex(),
    readFile: () => "request.get('order/refund/del/' + uni, {}); request.get('order/list', {});",
    backendIndex,
  });
  const dyn = f.find((x) => x.rule === 'fe-dynamic-request-path');
  assert.ok(dyn);
  assert.equal(dyn.severity, 'info');
});

test('SARIF output is 2.1.0 with rules, levels and physical locations', () => {
  const findings = [
    { rule: 'php-route-unknown-action', severity: 'error', file: 'routes/web.php', line: 85, message: 'm', why: 'w', evidence: 'e' },
    { rule: 'vue-nav-dynamic-url', severity: 'info', file: 'mixins/skuSelect.js', line: null, message: 'm2', why: 'w2', evidence: 'e2' },
    { rule: 'fe-be-pairing-suspect', severity: 'warn', file: null, line: null, message: 'm3', why: 'w3', evidence: 'e3' },
  ];
  const sarif = toSarif(findings);
  assert.equal(sarif.version, '2.1.0');
  const run = sarif.runs[0];
  assert.deepEqual(run.tool.driver.rules.map((r) => r.id), ['php-route-unknown-action', 'vue-nav-dynamic-url']);
  assert.equal(run.results.length, 2);
  assert.deepEqual(run.results.map((r) => r.level), ['error', 'note']);
  assert.equal(run.results[0].locations[0].physicalLocation.artifactLocation.uri, 'routes/web.php');
  assert.equal(run.results[0].locations[0].physicalLocation.region.startLine, 85);
  assert.equal(run.results[1].locations[0].physicalLocation.region, undefined);
  assert.match(run.results[0].message.text, /why: w \| evidence: e/);
  // code scanning refuses a result with zero locations (measured on a real run:
  // "locationFromSarifResult: expected at least one location"), so a finding that
  // has no file must not become a result — it is counted instead.
  assert.equal(run.results.every((r) => r.locations.length >= 1), true, 'every result must carry a location');
  assert.equal(run.properties.droppedWithoutLocation, 1);
  assert.equal(run.results.some((r) => r.ruleId === 'fe-be-pairing-suspect'), false);
  // must survive a JSON round-trip (it is written to a file for code scanning)
  assert.deepEqual(JSON.parse(JSON.stringify(sarif)), sarif);
});

test('GitHub annotations carry file/line/title and map severity to workflow levels', () => {
  const out = toGithubAnnotations([
    { rule: 'php-route-unknown-action', severity: 'error', file: 'routes/web.php', line: 85, message: 'GET visit/create 404\nmore' },
    { rule: 'no-test-coverage', severity: 'warn', file: null, line: null, message: 'x' },
  ]);
  const [l1, l2] = out.split('\n');
  assert.equal(l1, '::error file=routes/web.php,line=85,title=php-route-unknown-action::GET visit/create 404 more');
  assert.equal(l2, '::warning title=no-test-coverage::x');
});

test('security: raw-SQL interpolation and dangerous functions are errors with line numbers', () => {
  const src = [
    '<?php',
    'class XController {',
    '  public function index($q) {',
    '    return DB::table("t")->whereRaw("name = \'$q\'")->get();',
    '  }',
    '}',
  ].join('\n');
  const f = scanContent('app/Http/Controllers/XController.php', src);
  const sql = f.find((x) => x.rule === 'php-raw-sql-interpolation');
  assert.ok(sql);
  assert.equal(sql.severity, 'error');
  assert.equal(sql.line, 4);
  // bound parameters are fine
  const ok = scanContent('app/Http/Controllers/XController.php', "->whereRaw('name = ?', [$q])");
  assert.deepEqual(ok.filter((x) => x.rule === 'php-raw-sql-interpolation'), []);

  const danger = scanContent('app/Services/Y.php', 'shell_exec($cmd); unserialize($blob);');
  assert.deepEqual(danger.filter((x) => x.rule === 'php-dangerous-function').map((x) => x.severity), ['error']);
});

test('security: debug output left in a changed file', () => {
  const f = scanContent('app/Http/Controllers/XController.php', '<?php\n$a = 1;\ndd($a);\n');
  const dbg = f.find((x) => x.rule === 'php-debug-left-on');
  assert.ok(dbg);
  assert.equal(dbg.line, 3);
  // `->dump()` on a collection is not dd(); the lookbehind keeps it out
  assert.equal(scanContent('app/X.php', '$q->dump();').length, 0);
});

test('security: hardcoded secret fires on assignment, NOT on a validation rule', () => {
  const secret = scanContent('config/services.php', "<?php\n$api_key = 'sk_live_1234567890';\n");
  assert.ok(secret.some((x) => x.rule === 'php-hardcoded-secret' && x.severity === 'error'));

  // the real false-positive source in bench/php-app: Laravel validation strings
  const validation = scanContent('app/Http/Controllers/Auth/RegisterController.php', "<?php\n$rules = ['password' => 'required|min:6|confirmed'];\n");
  assert.deepEqual(validation.filter((x) => x.rule === 'php-hardcoded-secret'), []);
  const validator = scanContent('app/Validators/UserValidator.php', "<?php\n['password' => 'required|max:60'];\n");
  assert.deepEqual(validator.filter((x) => x.rule === 'php-hardcoded-secret'), []);
});

test('security: $request->all() without validation in a controller, but not when validated', () => {
  const bad = scanContent('app/Http/Controllers/PatientsController.php', '<?php\npublic function store(Request $r) { Patient::create($r->all()); }');
  assert.ok(bad.some((x) => x.rule === 'php-unvalidated-mass-input'));
  const good = scanContent('app/Http/Controllers/PatientsController.php', '<?php\npublic function store(Request $r) { $d = $r->validate(["name" => "required"]); Patient::create($r->all()); }');
  assert.deepEqual(good.filter((x) => x.rule === 'php-unvalidated-mass-input'), []);
  // criteria classes also use ->all() but are not controllers (fixture: 27 files / 89 hits)
  const criteria = scanContent('app/Criteria/GrabCriteria.php', '<?php\n$params = $request->all();');
  assert.deepEqual(criteria.filter((x) => x.rule === 'php-unvalidated-mass-input'), []);
});

test('performance: query inside a loop is flagged, a loop without queries is not', () => {
  const src = '<?php\nforeach ($ids as $id) {\n  $rows[] = Patient::where("id", $id)->first();\n}\n';
  const f = scanContent('app/Http/Controllers/PatientsController.php', src);
  const n1 = f.find((x) => x.rule === 'php-n-plus-one');
  assert.ok(n1);
  assert.equal(n1.line, 2);
  assert.match(n1.why, /启发式/);
  const clean = scanContent('app/Http/Controllers/PatientsController.php', '<?php\nforeach ($rows as $r) { $sum += $r["x"]; }\n');
  assert.deepEqual(clean.filter((x) => x.rule === 'php-n-plus-one'), []);
});

test('performance: unbounded get()/all() in a controller without pagination', () => {
  const f = scanContent('app/Http/Controllers/CustomersController.php', '<?php\n$list = Customer::all();');
  const u = f.find((x) => x.rule === 'php-unbounded-query');
  assert.ok(u);
  assert.equal(u.severity, 'info');
  const paged = scanContent('app/Http/Controllers/CustomersController.php', '<?php\n$list = Customer::paginate(20);');
  assert.deepEqual(paged.filter((x) => x.rule === 'php-unbounded-query'), []);
});

test('front-end: v-for without :key is judged on the attribute window, not the line', () => {
  const multilineKey = `<view\n  v-for="(item, index) in list"\n  :key="index"\n  class="item"\n>{{ item.name }}</view>`;
  assert.deepEqual(vforMissingKeys(multilineKey), [], 'key on a later line must count');
  const missing = `<view v-for="item in list" class="item">{{ item.name }}</view>`;
  assert.deepEqual(vforMissingKeys(missing).map((r) => r.tag), ['view']);
  const withKeyInline = `<view v-for="item in list" :key="item.id">x</view>`;
  assert.deepEqual(vforMissingKeys(withKeyInline), []);
  const f = scanContent('components/tabNav.vue', missing);
  assert.equal(f.find((x) => x.rule === 'vue-vfor-missing-key').severity, 'warn');
});

test('security: front-end patterns do not run over PHP and vice versa', () => {
  // A Vue file with `extract(`/`system(`-looking JS must NOT trip the PHP rules.
  const js = scanContent('utils/util.js', 'const x = obj.extract; const s = system.env;');
  assert.deepEqual(js.filter((x) => x.rule.startsWith('php-')), []);
  // …but eval / v-html / innerHTML are front-end security findings.
  assert.equal(scanContent('utils/a.js', 'eval(userInput);').find((x) => x.rule === 'js-dangerous-function').severity, 'error');
  const vue = scanContent('components/x/index.vue', '<view v-html="html"></view>');
  assert.ok(vue.some((x) => x.rule === 'vue-v-html'));
  assert.ok(scanContent('libs/a.js', 'el.innerHTML = data;').some((x) => x.rule === 'js-innerhtml'));
  // …and a PHP file must not trip the front-end rules.
  const php = scanContent('app/Http/Controllers/XController.php', '<?php $h = "<b>"; // innerHTML = nope');
  assert.deepEqual(php.filter((x) => x.rule.startsWith('js-') || x.rule === 'vue-v-html'), []);
});

test('security: single-quoted SQL (literal in PHP) and placeholder secrets are not flagged', () => {
  // single quotes in PHP do not interpolate — flagging this would be a false positive
  assert.deepEqual(
    scanContent('app/X.php', "->whereRaw('name = $q')").filter((x) => x.rule === 'php-raw-sql-interpolation'),
    [],
  );
  // concatenation is the real smell
  assert.ok(scanContent('app/X.php', "->whereRaw('name = ' . $q)").some((x) => x.rule === 'php-raw-sql-interpolation'));
  // example configs ship placeholders (bench/php-app: config/filesystems.php 'your-key')
  assert.deepEqual(
    scanContent('config/filesystems.php', "<?php 'key' => 'your-key', 'secret' => 'your-secret';").filter((x) => x.rule === 'php-hardcoded-secret'),
    [],
  );
});

test('security: a Request type-hint counts as validation (no false positive)', () => {
  const typed = scanContent('app/Http/Controllers/PatientsController.php', '<?php\npublic function store(PatientRequest $request) { Patient::create($request->all()); }');
  assert.deepEqual(typed.filter((x) => x.rule === 'php-unvalidated-mass-input'), []);
});

test('language traps: string/comment contents are blanked before operator matching', () => {
  // Laravel query operators live in string literals — not loose comparisons.
  const ok = scanContent('app/Criteria/X.php', "<?php $q->where('status', '!=', 1); $q->where('a', '==', 'b');");
  assert.deepEqual(ok.filter((x) => x.rule === 'php-loose-comparison'), []);
  // a real one still fires, at the right line
  const bad = scanContent('app/Criteria/X.php', '<?php\n$a = 1;\nif ($a == "1") { return true; }');
  const hit = bad.find((x) => x.rule === 'php-loose-comparison');
  assert.ok(hit);
  assert.equal(hit.line, 3);
  // comments too
  assert.deepEqual(scanContent('app/X.php', '<?php // use == here\n$a === $b;').filter((x) => x.rule === 'php-loose-comparison'), []);
  assert.equal(blankLiterals("x = 'ab' // cd").length, "x = 'ab' // cd".length, 'offsets must be preserved');
});

test('language traps: JS loose equality only when it decides something', () => {
  const js = scanContent('utils/a.js', 'if (res.code == 0) { ok(); }');
  assert.ok(js.some((x) => x.rule === 'js-loose-equality' && x.severity === 'info'));
  // string content is not a comparison
  assert.deepEqual(scanContent('utils/a.js', "const op = '=='; const s = 'a != b';").filter((x) => x.rule === 'js-loose-equality'), []);
  // strict equality is fine
  assert.deepEqual(scanContent('utils/a.js', 'if (res.code === 0) {}').filter((x) => x.rule === 'js-loose-equality'), []);
});

test('language traps: leftover console/debugger, empty catch, TODO stubs', () => {
  const dbg = scanContent('components/x/index.vue', 'console.log(res); debugger;');
  assert.ok(dbg.some((x) => x.rule === 'js-debug-left-on' && x.severity === 'warn'));
  const php = scanContent('app/Http/Controllers/XController.php', '<?php $a=1; // console.log 在 PHP 里不算');
  assert.deepEqual(php.filter((x) => x.rule === 'js-debug-left-on'), []);

  const ec = scanContent('libs/uniApi.js', 'try { f(); } catch (e) {}');
  assert.ok(ec.some((x) => x.rule === 'empty-catch'));
  assert.deepEqual(scanContent('libs/uniApi.js', 'try { f(); } catch (e) { log(e); }').filter((x) => x.rule === 'empty-catch'), []);

  const todo = scanContent('api/order.js', '// TODO: 稍后补校验，先这样');
  assert.equal(todo.find((x) => x.rule === 'ai-todo-left').severity, 'info');
  assert.ok(scanContent('app/Http/Controllers/XController.php', "<?php throw new \\Exception('not implemented');").some((x) => x.rule === 'ai-todo-left'));
});

test('AI hallucinations: unresolved local/alias imports, hallucinated deps, unknown PSR-4 class', () => {
  const indexedFiles = new Set(['api/order.js', 'components/payment/index.vue', 'utils/request.js', 'src/lib/util.ts', 'app/Http/Controllers/PatientsController.php']);
  const deps = new Set(['lodash', '@dcloudio/uni-app']);
  const is = (src, file = 'api/order.js') => hallucinationFindings(file, src, { indexedFiles, deps, psr4: { 'App\\': 'app/' } });

  // resolved imports (with and without ./ , ../ and omitted /index.vue) are silent
  assert.deepEqual(is("import request from './request';", 'utils/cache.js'), [], 'sibling ./ import resolves');
  assert.deepEqual(is("import { x } from '../../api/order';", 'components/payment/index.vue'), [], '../ resolves to api/order.js');
  assert.deepEqual(is("import p from '@/components/payment';"), [], 'alias + omitted /index.vue');
  assert.deepEqual(is("import u from '../src/lib/util';", 'api/order.js'), []);
  assert.deepEqual(is("import _ from 'lodash'; import { onLoad } from '@dcloudio/uni-app';"), []);
  assert.deepEqual(is("import fs from 'fs';"), [], 'node builtins are not packages');

  // hallucinated local path
  const ghost = is("import x from './nothing/here';");
  assert.equal(ghost.length, 1);
  assert.equal(ghost[0].rule, 'js-unresolved-local-import');
  assert.equal(ghost[0].severity, 'warn');
  // hallucinated package
  const pkg = is("import { fake } from 'vue-fake-widget';");
  assert.equal(pkg[0].rule, 'hallucinated-dependency');
  assert.match(pkg[0].evidence, /package=vue-fake-widget/);
  // invented PHP class in the project's own namespace
  const cls = is("<?php\nuse App\\Services\\InvoiceService;", 'app/Http/Controllers/PatientsController.php');
  assert.equal(cls[0].rule, 'php-unknown-class-import');
  assert.match(cls[0].evidence, /expected=app\/Services\/InvoiceService\.php/);
  // framework/vendor namespaces are outside the PSR-4 map → silent
  assert.deepEqual(is("<?php\nuse Illuminate\\Support\\Facades\\DB;", 'app/Http/Controllers/PatientsController.php'), []);
});

test('AI hallucinations: joinPosix normalises ./ and ../ segments', () => {
  assert.equal(joinPosix('', './config/app'), 'config/app');
  assert.equal(joinPosix('components/payment', '../utils/request'), 'components/utils/request');
  assert.equal(joinPosix('a/b', '../../x'), 'x');
  assert.equal(joinPosix('a/b', './c/./d'), 'a/b/c/d');
});

test('findings sort by severity and render with why + evidence', () => {
  const index = makeIndex({
    unresolvedRoutes: [{ method: 'GET', uri: 'visit/create', controller: 'VisitsController', action: 'create', file: 'routes/web.php', line: 85, reason: 'unknown-action' }],
    unresolvedPages: [{ kind: 'navigation', file: 'mixins/skuSelect.js', line: 342, target: null, via: 'uni.navigateTo', reason: 'dynamic-url' }],
    symbols: [{ id: 'VisitsController', name: 'VisitsController', kind: 'class', file: 'app/Http/Controllers/VisitsController.php', line_start: 11, line_end: 80 },
      { id: 'store', name: 'store', kind: 'function', file: 'app/Http/Controllers/PatientsController.php', line_start: 300, line_end: 340 },
      { id: 'store2', name: 'store', kind: 'function', file: 'app/Http/Controllers/VisitsController.php', line_start: 20, line_end: 60 }],
  });
  const changes = makeChanges({
    changed_files: [{ file: 'app/Http/Controllers/VisitsController.php' }, { file: 'mixins/skuSelect.js' }],
    changed_symbols: [{ symbol: 'store', file: 'app/Http/Controllers/VisitsController.php', line_start: 20, confidence: 0.5 }],
  });
  const f = reviewFindings({ changes, index, readFile: () => null });
  assert.equal(f[0].severity, 'error');
  const out = renderFindings(f, { scope: 'unstaged', via: 'git' });
  assert.match(out, /为什么：/);
  assert.match(out, /证据：/);
  assert.match(out, /error 1/);
});
