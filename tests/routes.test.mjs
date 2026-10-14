/**
 * Laravel route edges — "route → controller action" DEPENDS_ON edges.
 *
 * Why: `routes/` produces 0 symbols, so a Laravel app had no edge from an HTTP
 * entry point into the controller method it dispatches. `impact()` therefore
 * reported controller actions as the outermost consumers. These edges make the
 * reverse DEPENDS_ON walk climb one hop further, up to the route.
 *
 * Evidence sources:
 *   - bench/php-app  (real Laravel app, rebuilt here with `src/index.js analyze`)
 *   - a tiny throwaway project (routes/web.php + one controller) that carries the
 *     forms bench/php-app happens not to use: array actions `[C::class, 'm']`,
 *     `Route::match`/`Route::any`, `Route::prefix(...)->group(...)`, a resource
 *     with `only => [...]`, and one deliberately misspelled controller.
 *
 * Run: node --test tests/routes.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PHP_APP = path.join(REPO, 'bench', 'php-app');
const INDEX = path.join(PHP_APP, '.archnav', 'index.json');
const posix = (p) => String(p ?? '').replace(/\\/g, '/');

const PATIENTS = 'app/Http/Controllers/PatientsController.php';
const HISTORIES = 'app/Http/Controllers/HistoriesController.php';
/** graph id convention: `sym:<the symbol's own file string>::<name>` */
const sym = (file, name) => `sym:${file}::${name}`;

/** Run the real CLI (`analyze --json`) and return the analysis object it prints. */
function analyzeCli(dir) {
  const r = spawnSync(process.execPath, ['src/index.js', 'analyze', dir, '--json'], {
    cwd: REPO,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `analyze ${dir} must exit 0 (stderr: ${r.stderr})`);
  return JSON.parse(r.stdout);
}

// ── fixture project ─────────────────────────────────────────────────────────

const FIXTURE_WEB = `<?php

use App\\Http\\Controllers\\PatientsController;

Route::get('/patients', 'PatientsController@index');
Route::get('/patients/array', [PatientsController::class, 'index']);
Route::match(['get', 'post'], '/patients/match', 'PatientsController@store');
Route::any('/patients/any', 'PatientsController@notice');

Route::group(['middleware' => 'auth'], function () {
    Route::get('/patients/in-group', 'PatientsController@index');
});

Route::prefix('admin')->name('admin.')->group(function () {
    Route::get('/dash', 'PatientsController@dashboard');
    Route::group(['middleware' => 'auth'], function () {
        Route::resource('care', 'PatientsController', ['only' => ['index', 'store']]);
    });
});

// Deliberately misspelled controller class: must be reported, never dropped.
Route::get('/typo', 'PatientsControler@index');
`;

const FIXTURE_CONTROLLER = `<?php

namespace App\\Http\\Controllers;

class PatientsController
{
    public function index() { return 'index'; }
    public function create() { return 'create'; }
    public function store() { return 'store'; }
    public function show($id) { return 'show'; }
    public function edit($id) { return 'edit'; }
    public function update($id) { return 'update'; }
    public function destroy($id) { return 'destroy'; }
    public function notice() { return 'notice'; }
    public function dashboard() { return 'dashboard'; }
}
`;

let index;              // bench/php-app index.json
let kg;                 // bench/php-app knowledgeGraph
let routeEdges;         // DEPENDS_ON edges whose `from` is a route: node
let nodesById;          // bench/php-app nodes by id
let fixDir;             // fixture project dir
let fixtureResult;      // analyze() return value for the fixture (CLI --json)
let fixtureIndex;       // fixture .archnav/index.json

before(() => {
  // Rebuild the real Laravel index through the CLI (same path a user runs).
  const r = spawnSync(process.execPath, ['src/index.js', 'analyze', 'bench/php-app'], {
    cwd: REPO,
    stdio: 'ignore',
  });
  assert.equal(r.status, 0, 'analyze bench/php-app must exit 0');
  index = JSON.parse(fs.readFileSync(INDEX, 'utf-8'));
  kg = index.knowledgeGraph || { nodes: [], edges: [] };
  routeEdges = (kg.edges || []).filter(
    (e) => e.type === 'DEPENDS_ON' && String(e.from).startsWith('route:')
  );
  nodesById = new Map((kg.nodes || []).map((n) => [n.id, n]));

  // Tiny fixture project for the forms bench/php-app does not exercise.
  fixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-routes-'));
  fs.mkdirSync(path.join(fixDir, 'routes'), { recursive: true });
  fs.mkdirSync(path.join(fixDir, 'app', 'Http', 'Controllers'), { recursive: true });
  fs.writeFileSync(path.join(fixDir, 'routes', 'web.php'), FIXTURE_WEB);
  fs.writeFileSync(path.join(fixDir, 'app', 'Http', 'Controllers', 'PatientsController.php'), FIXTURE_CONTROLLER);

  fixtureResult = analyzeCli(fixDir);
  fixtureIndex = JSON.parse(fs.readFileSync(path.join(fixDir, '.archnav', 'index.json'), 'utf-8'));
});

after(() => {
  if (fixDir) fs.rmSync(fixDir, { recursive: true, force: true });
});

// ── (a) route edges exist and point at real symbol nodes ────────────────────

test('(a) route:* DEPENDS_ON edges exist (>=5) and every target is a real sym id', () => {
  const byType = {};
  for (const e of kg.edges || []) byType[e.type] = (byType[e.type] || 0) + 1;
  assert.ok(
    routeEdges.length >= 5,
    `expected >=5 route edges, got ${routeEdges.length}; edge types: ${JSON.stringify(byType)}`
  );

  const symIds = new Set((index.symbols || []).map((s) => `sym:${s.file}::${s.name}`));
  for (const e of routeEdges) {
    assert.ok(symIds.has(e.to), `route edge points at a nonexistent symbol: ${e.from} → ${e.to}`);
  }

  // route nodes are registered with method/uri/file/line metadata
  const routeNodes = (kg.nodes || []).filter((n) => n.type === 'route' && String(n.id).startsWith('route:'));
  assert.ok(routeNodes.length >= 5, `expected route nodes, got ${routeNodes.length}`);
  for (const n of routeNodes) {
    assert.ok(typeof n.method === 'string' && n.method, `route node ${n.id} has no method`);
    assert.ok(typeof n.uri === 'string', `route node ${n.id} has no uri`);
    assert.equal(posix(n.file), 'routes/web.php');
    assert.ok(Number.isInteger(n.line) && n.line > 0, `route node ${n.id} has no line`);
  }
});

// ── (c) a known route resolves to a known controller method ────────────────

test('(c) route:GET /patients → sym:<PatientsController.php>::index (string action form)', () => {
  const e = (fixtureResult.knowledgeGraph.edges || []).find((x) => x.from === 'route:GET /patients');
  assert.ok(e, 'no route:GET /patients edge in the fixture project');
  assert.equal(e.to, sym(PATIENTS, 'index'));
  assert.equal(e.source_kind, 'route');
});

test('(c2) the real app resolves its resource route to the controller method', () => {
  const e = routeEdges.find((x) => x.from === 'route:GET patient');
  assert.ok(e, 'no route:GET patient edge in bench/php-app');
  assert.equal(e.to, sym(PATIENTS, 'index'));
});

// ── (b) both action forms are supported ────────────────────────────────────

test('(b) string \'C@m\' and array [C::class, \'m\'] actions both produce an edge', () => {
  const want = sym(PATIENTS, 'index');
  const str = fixtureResult.knowledgeGraph.edges.find((e) => e.from === 'route:GET /patients');
  const arr = fixtureResult.knowledgeGraph.edges.find((e) => e.from === 'route:GET /patients/array');
  assert.ok(str, 'string action form produced no edge');
  assert.ok(arr, 'array action form produced no edge');
  assert.equal(str.to, want);
  assert.equal(arr.to, want);

  // Route::match expands to one route per verb; Route::any covers the common ones.
  const m = fixtureResult.knowledgeGraph.edges.filter((e) => e.from.includes('/patients/match'));
  assert.deepEqual(m.map((e) => e.from).sort(), ['route:GET /patients/match', 'route:POST /patients/match']);
  assert.ok(m.every((e) => e.to === sym(PATIENTS, 'store')));
  const any = fixtureResult.knowledgeGraph.edges.filter((e) => e.from.includes('/patients/any'));
  assert.ok(any.some((e) => e.from === 'route:GET /patients/any'), 'Route::any must cover GET');
  assert.ok(any.some((e) => e.from === 'route:POST /patients/any'), 'Route::any must cover POST');

  // nested Route::group([...], function () { ... }) keeps its routes, and
  // Route::prefix('admin')->group(...) prefixes the uri.
  const inGroup = fixtureResult.knowledgeGraph.edges.find((e) => e.from === 'route:GET /patients/in-group');
  assert.ok(inGroup, 'route declared inside a middleware group was lost');
  assert.equal(inGroup.to, sym(PATIENTS, 'index'));
  const dash = fixtureResult.knowledgeGraph.edges.find((e) => e.from === 'route:GET admin/dash');
  assert.ok(dash, 'chained Route::prefix(...)->group(...) prefix was not applied');
  assert.equal(dash.to, sym(PATIENTS, 'dashboard'));
});

// ── (d) Route::resource expansion, only/except respected ───────────────────

test('(d) Route::resource expands the 7 default actions with Laravel uris', () => {
  // Route::resource('patient', 'PatientsController') — bench/php-app/routes/web.php:75
  const byId = new Map(routeEdges.map((e) => [e.from, e.to]));
  const expected = {
    'route:GET patient': 'index',
    'route:GET patient/create': 'create',
    'route:POST patient': 'store',
    'route:GET patient/{patient}': 'show',
    'route:GET patient/{patient}/edit': 'edit',
    'route:PUT patient/{patient}': 'update',
    'route:PATCH patient/{patient}': 'update',
    'route:DELETE patient/{patient}': 'destroy',
  };
  for (const [id, action] of Object.entries(expected)) {
    assert.equal(byId.get(id), sym(PATIENTS, action), `${id} should resolve to ${action}`);
  }
  // …and no less: exactly these 7 actions (PUT+PATCH both feed `update`).
  const resourceEdges = routeEdges.filter((e) => Object.keys(expected).includes(e.from));
  const actions = new Set(resourceEdges.map((e) => e.to.split('::').pop()));
  assert.deepEqual(
    [...actions].sort(),
    ['create', 'destroy', 'edit', 'index', 'show', 'store', 'update']
  );
  assert.equal(resourceEdges.length, 8, 'PUT + PATCH both register `update`');
});

test('(d2) Route::resource except => [...] is respected', () => {
  // Route::resource('history', 'HistoriesController', ['except' => ['edit','update']])
  const hist = routeEdges.filter((e) => e.to.startsWith(`sym:${HISTORIES}::`));
  const ids = [...new Set(hist.map((e) => e.from))].sort();
  // index/store/show/destroy survive; edit/update are except'd…
  assert.deepEqual(ids, [
    'route:DELETE history/{history}',
    'route:GET /history/destruct',   // the explicit route declared above the resource
    'route:GET history',
    'route:GET history/{history}',
    'route:POST history',
  ]);
  // …and `Route::resource` also registers create, but HistoriesController has no
  // create() — that route must be reported, not invented:
  assert.ok(!ids.includes('route:GET history/create'));
  const unresolved = index.unresolvedRoutes || [];
  const create = unresolved.find((u) => u.uri === 'history/create');
  assert.ok(create, `history/create should be reported unresolved (got ${JSON.stringify(unresolved)})`);
  assert.equal(create.action, 'create');
  assert.equal(create.reason, 'unknown-action');
  assert.equal(create.line, 51);
});

test('(d3) an `only` resource inside a nested prefix group expands to just those actions', () => {
  const careEdges = fixtureResult.knowledgeGraph.edges.filter((e) => String(e.from).includes('admin/care'));
  const ids = [...new Set(careEdges.map((e) => e.from))].sort();
  assert.deepEqual(ids, ['route:GET admin/care', 'route:POST admin/care']);
  assert.equal(careEdges.find((e) => e.from === 'route:GET admin/care').to, sym(PATIENTS, 'index'));
  assert.equal(careEdges.find((e) => e.from === 'route:POST admin/care').to, sym(PATIENTS, 'store'));
});

// ── (e) edges carry source_kind:'route' and the declaration line ───────────

test('(e) every route edge carries source_kind:route + an integer line', () => {
  assert.ok(routeEdges.length > 0);
  for (const e of routeEdges) {
    assert.equal(e.source_kind, 'route', `edge ${e.from} → ${e.to} lacks source_kind:route`);
    assert.ok(Number.isInteger(e.line) && e.line > 0, `edge ${e.from} → ${e.to} lacks a line`);
  }
  const lines = fs.readFileSync(path.join(PHP_APP, 'routes', 'web.php'), 'utf-8').split('\n');
  for (const e of routeEdges) {
    assert.ok(e.line <= lines.length, `${e.from} line ${e.line} outside routes/web.php`);
    assert.match(lines[e.line - 1] ?? '', /Route::/, `${e.from}: line ${e.line} is not a Route:: statement`);
  }
  // exact line evidence: routes/web.php:66 is `Route::get('/patient/confirm/{id}', 'PatientsController@confirm')`
  assert.equal(routeEdges.find((e) => e.from === 'route:GET /patient/confirm/{id}')?.line, 66);
  assert.equal(routeEdges.find((e) => e.from === 'route:GET /mini-booking/transfer/{id}')?.line, 79);
});

// ── (f) unresolved routes fail loudly ──────────────────────────────────────

test('(f) unresolvable routes land in unresolvedRoutes (analyze return + index.json)', () => {
  const unresolved = fixtureResult.unresolvedRoutes;
  assert.ok(Array.isArray(unresolved), `analyze() must return unresolvedRoutes (got ${typeof unresolved})`);

  const typo = unresolved.find((x) => JSON.stringify(x).includes('PatientsControler'));
  assert.ok(typo, `misspelled controller was dropped silently (unresolvedRoutes: ${JSON.stringify(unresolved)})`);
  assert.equal(posix(typo.file), 'routes/web.php');
  assert.ok(Number.isInteger(typo.line) && typo.line > 0, 'unresolved entry must carry the declaration line');
  assert.ok(typo.reason, 'unresolved entry must carry a reason');
  // The route itself is still in the graph — only the edge is missing.
  assert.ok(
    (fixtureResult.knowledgeGraph.nodes || []).some((n) => n.id === 'route:GET /typo'),
    'the unresolved route node should still be registered'
  );

  // Persisted for the CLI/`kgraph` consumers.
  assert.ok(Array.isArray(fixtureIndex.unresolvedRoutes), 'index.json must expose unresolvedRoutes');
  assert.ok(
    fixtureIndex.unresolvedRoutes.some((x) => JSON.stringify(x).includes('PatientsControler')),
    'index.json.unresolvedRoutes lost the typo'
  );
  assert.ok(Array.isArray(index.unresolvedRoutes), 'bench/php-app index.json must expose unresolvedRoutes');
});
