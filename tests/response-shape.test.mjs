/**
 * response-shape.test.mjs — shape-check M1 (docs/shape-check.md §3.2, §4.1).
 *
 * The contract under test: how much of a handler's response shape is recoverable,
 * and — more importantly — when the resolver says `unresolved` instead of inventing
 * keys. Ground truth lives in bench/fe-be-pair/README.md (the same README that pins
 * the fe-be counts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHandlerShape, methodBody, collectFrontendReads, shapeIsComparable, searchResponseKey } from '../scripts/response-shape.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(ROOT, 'bench', 'fe-be-pair', 'backend');

const shape = (controller, action, index = null) =>
  resolveHandlerShape({ root: FIXTURE, controller, action, index });

test('L0: a controller that states its own keys (the 6% case)', () => {
  const r = shape('OrderController', 'index');
  assert.equal(r.level, 'local', JSON.stringify(r));
  assert.deepEqual([...r.keys].sort(), ['method', 'ok']);
  assert.ok(r.via.some((v) => /OrderController\.php/.test(v)), `evidence: which file was read — ${r.via.join(' | ')}`);
  assert.ok(r.via.some((v) => /::index$/.test(v)), `via names the action too — ${r.via.join(' | ')}`);
});

test('L0 on `$data[...]` assignments (the service body itself)', () => {
  const r = shape('CouponService', 'issueList');
  assert.equal(r.level, 'local', JSON.stringify(r));
  assert.deepEqual([...r.keys].sort(), ['image', 'list', 'show']);
});

test('L1: a delegated shape resolves one hop into the service (the 69% case)', () => {
  const r = shape('CouponController', 'lst');
  assert.equal(r.level, 'service', JSON.stringify(r));
  assert.deepEqual([...r.keys].sort(), ['image', 'list', 'show']);
  assert.equal(r.depth, 2, 'exactly one hop beyond the controller');
  assert.ok(r.via.some((v) => /CouponService\.php/.test(v)), `via must show the service: ${r.via.join(' -> ')}`);
});

test('depth cap: a service that delegates again stays unresolved, never guessed', () => {
  const r = shape('CouponController', 'deep');
  assert.equal(r.level, 'unresolved', JSON.stringify(r));
  assert.equal(r.reason, 'depth-cap', 'charter §3.2: cap at controller -> service');
  assert.deepEqual(r.keys, [], 'no invented keys');
  assert.ok(r.via.length >= 2, 'still explains which files it looked at');
});

test('a method that does not exist is unresolved with a reason, not a miss', () => {
  const r = shape('ReportController', 'nope');
  assert.equal(r.level, 'unresolved', JSON.stringify(r));
  assert.equal(r.reason, 'method-not-found');
  assert.ok(r.via.length >= 1, 'it says which controller file it opened');
});

test('an unknown controller is unresolved, not a throw', () => {
  const r = shape('NotAController', 'anything');
  assert.equal(r.level, 'unresolved', JSON.stringify(r));
  assert.equal(r.reason, 'controller-not-found');
});

test('the same answers come out through the index (the path review-rules will use)', async (t) => {
  // hermetic: copy the fixture, analyze it, hand the index to the resolver
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'response-shape-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  execFileSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), 'analyze', '.'], { cwd: dir, encoding: 'utf8' });
  const index = JSON.parse(fs.readFileSync(path.join(dir, '.archnav', 'index.json'), 'utf8'));
  assert.ok((index.symbols || []).length > 0, 'fixture indexes');

  const withIndex = (c, a) => resolveHandlerShape({ root: dir, controller: c, action: a, index });
  assert.equal(withIndex('OrderController', 'index').level, 'local');
  assert.deepEqual([...withIndex('CouponController', 'lst').keys].sort(), ['image', 'list', 'show']);
  assert.equal(withIndex('CouponController', 'deep').reason, 'depth-cap');
  assert.equal(withIndex('ReportController', 'nope').reason, 'method-not-found');
});

test('methodBody is brace- and string-safe (a `}` inside a string cannot end a method)', () => {
  const src = [
    '<?php',
    'class A {',
    '  public function tricky() {',
    "    $x = '}';   // closing brace in a string",
    "    return ['k' => $x];",
    '  }',
    '  public function after() {',
    "    return ['never' => 'reached'];",
    '  }',
    '}',
    '',
  ].join('\n');
  const body = methodBody(src, 'tricky');
  assert.ok(body, 'method found');
  assert.match(body.body, /closing brace in a string/, 'the comment line is inside the body');
  assert.doesNotMatch(body.body, /never.*reached/, 'the next method is outside the body');
});

test('two classes with the same name: the one that declares the action wins', (t) => {  // measured on the real repo: 5 handlers of `System/.../ThemeController` resolved to
  // `Admin/.../Diy/ThemeController` (same basename, different module) and reported
  // method-not-found — ambiguity must be settled by evidence, not by first hit
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'response-shape-ambig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  w('app/Admin/Diy/ThemeController.php', [
    '<?php',
    'class ThemeController {',
    '  public function index() {',
    "    return ['wrong' => 1];",
    '  }',
    '}',
    '',
  ].join('\n'));
  w('app/System/Controllers/ThemeController.php', [
    '<?php',
    'class ThemeController {',
    '  public function products() {',
    "    return ['right' => 1];",
    '  }',
    '}',
    '',
  ].join('\n'));

  const r = resolveHandlerShape({ root: dir, controller: 'ThemeController', action: 'products' });
  assert.equal(r.level, 'local', JSON.stringify(r));
  assert.deepEqual(r.keys, ['right'], 'it must land on the module that declares products()');
  assert.ok(r.via.some((v) => /no products\(\)/.test(v)), `the rejected candidate is evidence: ${r.via.join(' | ')}`);

  const none = resolveHandlerShape({ root: dir, controller: 'ThemeController', action: 'missing' });
  assert.equal(none.reason, 'method-not-found', 'neither candidate declares it');
  assert.ok(none.via.filter((v) => /no missing\(\)/.test(v)).length === 2, 'both were tried');
});

// ── M2: which response fields does the client read? ──────────────────────────────

const FRONT = path.join(ROOT, 'bench', 'fe-be-pair', 'frontend');

test('M2: an endpoint with a caller resolves the fields it reads', () => {
  const r = collectFrontendReads({ root: FRONT, method: 'GET', path: '/api/coupons' });
  assert.equal(r.level, 'resolved', JSON.stringify(r));
  const fields = r.reads.map((x) => x.field).sort();
  assert.deepEqual(fields, ['list', 'nope'], 'the planted pair: one real field, one impossible');
  const nope = r.reads.find((x) => x.field === 'nope');
  assert.match(nope.file, /pages\/coupons\.js$/, 'reads live in the caller, not the api layer');
  assert.equal(nope.line, 7, 'exact line of the read');
  assert.ok(r.via.includes('api/index.js') && r.via.some((v) => /pages\/coupons\.js/.test(v)),
    `via shows both hops: ${r.via.join(', ')}`);
});

test('M2: an endpoint nobody calls is unresolved, not an empty pass', () => {
  // `/api/wrong-method` has a binding in the api layer but nobody calls it — and now that
  // pages/deep.js calls /api/deep (M5 second-stage fixture), the "nobody calls it" case
  // needs an endpoint that is genuinely uncalled.
  const r = collectFrontendReads({ root: FRONT, method: 'POST', path: '/api/wrong-method' });
  assert.equal(r.level, 'unresolved', JSON.stringify(r));
  assert.equal(r.reason, 'no-callsite-reads');
  assert.deepEqual(r.reads, [], 'no reads means no answer');
});

test('M2: an endpoint the frontend never declares is unresolved', () => {
  const r = collectFrontendReads({ root: FRONT, method: 'GET', path: '/api/never-called' });
  assert.equal(r.level, 'unresolved');
  assert.equal(r.reason, 'endpoint-not-found');
});

test('M3 pairing rule: shape + reads decide a missing field', () => {
  const reads = collectFrontendReads({ root: FRONT, method: 'GET', path: '/api/coupons' });
  const shape = resolveHandlerShape({ root: path.join(ROOT, 'bench', 'fe-be-pair', 'backend'), controller: 'CouponController', action: 'lst' });
  assert.equal(shape.level, 'service');
  const missing = reads.reads.map((x) => x.field).filter((f) => !shape.keys.includes(f));
  assert.deepEqual(missing, ['nope'], 'the field the backend never returns');
});

// ── regressions from measuring the rule on the real pair (2026-11-01) ────────────

test('a read at the window edge is not cut into a phantom field', (t) => {
  // measured: a read at abs 2272 inside a window ending at 2289 turned
  // `res.data.customer_url` into a field `customer` that the file never contains
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-window-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  fs.writeFileSync(path.join(dir, 'api.js'), "export const fetchType = () => request.get('/type');\n");

  const callToken = 'fetchType(';
  const pre = "import { fetchType } from './api.js';\nexport function show() {\n  return " + callToken;
  const mid = ').then((res) => {\n  ';
  const callPos = pre.indexOf(callToken);
  const phantom = 'res.data.customer';                       // what a 600-char window cuts to
  const marker = 'res.data.customer_url';
  const markerStart = callPos + 600 - phantom.length;        // so the window ends *inside* the name
  const filler = ' '.repeat(Math.max(0, markerStart - (pre.length + mid.length)));
  fs.writeFileSync(path.join(dir, 'caller.js'), pre + mid + filler + marker + ';\n});\n}\n');

  const r = collectFrontendReads({ root: dir, method: 'GET', path: '/type' });
  assert.equal(r.level, 'resolved', JSON.stringify(r));
  assert.deepEqual(r.reads.map((x) => x.field), ['customer_url'], 'the whole identifier, re-assembled past the window edge');
  assert.ok(!r.reads.some((x) => x.field === 'customer'), 'the phantom must not exist');
});

test('an unexpandable return makes the shape partial; a `data` payload stays identifiable', (t) => {
  // review-rules refuses to compare BOTH: a partial backend shape (the union is only a
  // lower bound) and a payload carrying `data` (`res.data.x` may read the nested object)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-partial-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'MixedController.php'), [
    '<?php',
    'class MixedController {',
    '  public function mixed() {',
    '    if ($x) { return ["a" => 1]; }',
    '    return $this->service->other();',
    '  }',
    '  public function wrapped() {',
    '    return ["type" => "x", "data" => []];',
    '  }',
    '}',
    '',
  ].join('\n'));

  const mixed = resolveHandlerShape({ root: dir, controller: 'MixedController', action: 'mixed' });
  assert.equal(mixed.level, 'local');
  assert.deepEqual(mixed.keys, ['a'], 'keys read from the branch we could model');
  assert.equal(mixed.partial, true, 'a return we cannot expand makes the union a lower bound');

  const wrapped = resolveHandlerShape({ root: dir, controller: 'MixedController', action: 'wrapped' });
  assert.equal(wrapped.partial, undefined, 'every branch was modelled');
  assert.deepEqual([...wrapped.keys].sort(), ['data', 'type'], 'the rule detects the wrapper by this key');
});

test('shapeIsComparable is the single gate — rule and coverage cannot drift', () => {
  // the guards were written inline in three places and drifted twice while this was
  // verified; everything must go through this predicate
  assert.equal(shapeIsComparable({ level: 'local', keys: ['a'] }), true, 'read shape, no wrapper');
  assert.equal(shapeIsComparable({ level: 'service', keys: ['list', 'count'] }), true, 'service shape');
  assert.equal(shapeIsComparable({ level: 'unresolved', keys: [] }), false, 'never read a shape');
  assert.equal(shapeIsComparable({ level: 'local', keys: ['a'], partial: true }), false,
    'an unmodelled return branch makes the union a lower bound');
  assert.equal(shapeIsComparable({ level: 'local', keys: ['type', 'data'] }), false,
    'wrapper payload: res.data.x may read the nested object');
  assert.equal(shapeIsComparable({ level: 'local' }), false, 'no keys array is not comparable');
  assert.equal(shapeIsComparable(null), false, 'null-safe');
  assert.equal(shapeIsComparable({ level: 'repo', keys: ['rows', 'count'] }), false,
    'M4 verdict: hop-3 keys stay outside the gate until §2.3 agreement evidence exists');
});

// ── M4: the third hop works mechanically, and stays outside the gate ──────────────

const BACKEND = path.join(ROOT, 'bench', 'fe-be-pair', 'backend');

test('the injected service wins over a stranger with the same method name', (t) => {
  // measured on the real pair (2026-11-01): `KefuV2Controller` injects `V2KefuService`,
  // 8+ services declare `record()`, and name order picked `AdminFlowStatisticService`
  // — whose keys (`list, count`) became the "shape" of an endpoint that really returns
  // `serviceList`, fabricating a missing-field finding
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-hint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  // same method name, different shapes — alphabetically the wrong one comes first
  w('app/Services/AAAFirstService.php', [
    '<?php',
    'class AAAFirstService {',
    '  public function record() { return ["list" => 1, "count" => 2]; }',
    '}',
    '',
  ].join('\n'));
  w('app/Services/ZedTargetService.php', [
    '<?php',
    'class ZedTargetService {',
    '  public function record() { return ["serviceList" => []]; }',
    '}',
    '',
  ].join('\n'));
  w('app/Http/FakeController.php', [
    '<?php',
    'class FakeController {',
    '  public function __construct(private readonly ZedTargetService $service) {}',
    '  public function record() { return app("json")->success($this->service->record()); }',
    '}',
    '',
  ].join('\n'));

  const r = resolveHandlerShape({ root: dir, controller: 'FakeController', action: 'record' });
  assert.equal(r.level, 'service', JSON.stringify(r));
  assert.deepEqual(r.keys, ['serviceList'], 'the injected service, not the alphabetical first');
  assert.match(r.via.join(' -> '), /ctor hint: ZedTargetService/, `the hint is the evidence: ${r.via.join(' -> ')}`);
});

test('the window stops at this call: a neighbouring call\'s reads are not attributed', (t) => {
  // measured 2026-11-02: `res.data.downloadBase64` belongs to `getInvoiceLink()`, but a
  // fixed 600-char window reached it from `getOrderList()` — the rule reported a field
  // missing from `order/list` that the order-list handler never had anything to do with
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-bound-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  fs.writeFileSync(path.join(dir, 'api.js'), [
    "export const alpha = () => request.get('/alpha');",
    "export const beta = () => request.get('/beta');",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'caller.js'), [
    "import { alpha, beta } from './api.js';",
    'export function run() {',
    '  alpha().then((res) => res.data.keep);',
    '  beta().then((res) => res.data.other);',
    '}',
    '',
  ].join('\n'));

  const a = collectFrontendReads({ root: dir, method: 'GET', path: '/alpha' });
  assert.equal(a.level, 'resolved', JSON.stringify(a));
  assert.deepEqual(a.reads.map((x) => x.field), ['keep'], 'only its own chain');
  const b = collectFrontendReads({ root: dir, method: 'GET', path: '/beta' });
  assert.deepEqual(b.reads.map((x) => x.field), ['other'], 'and the neighbour keeps its own');
});

test('compact() names are response keys — neither reader may miss them', (t) => {
  // measured 2026-11-02: `DivisionService` returns `compact('list','count','codeUrl')`,
  // so `codeUrl` looked undeclared and got reported as missing
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'C.php'), [
    '<?php',
    'class C {',
    '  public function show() {',
    "    return compact('list', 'count', 'codeUrl');",
    '  }',
    '}',
    '',
  ].join('\n'));

  const shape = resolveHandlerShape({ root: dir, controller: 'C', action: 'show' });
  assert.deepEqual([...shape.keys].sort(), ['codeUrl', 'count', 'list'], 'keys come from compact()');
  assert.equal(shapeIsComparable(shape), true, 'and the pair is comparable, not "unreadable"');
  assert.ok(searchResponseKey({ root: dir, field: 'codeUrl' }).declared > 0,
    'the declaration index sees compact() too');
});

test('M5 second stage: declaration search answers "does this key exist at all"', (t) => {  // the gate refuses ~60% of pairs; silence there hid a true defect (`bindName`: 0
  // declarations in 909 PHP files). The fallback asks the declaration question instead.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decl-search-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  w('app/A.php', [
    '<?php',
    '$result = ["present" => 1];',
    '$row["assigned"] = 2;',
    '',
  ].join('\n'));
  w('app/B.php', '<?php // nothing declared here\n');
  fs.mkdirSync(path.join(dir, 'vendor', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'vendor', 'x', 'C.php'), '<?php $v = ["vendorOnly" => 1];\n');

  assert.ok(searchResponseKey({ root: dir, field: 'present' }).declared > 0, 'array-literal key');
  assert.ok(searchResponseKey({ root: dir, field: 'assigned' }).declared > 0, 'index assignment');
  assert.equal(searchResponseKey({ root: dir, field: 'ghostField' }).declared, 0, 'nowhere: the strong claim');
  assert.equal(searchResponseKey({ root: dir, field: 'vendorOnly' }).declared, 0, 'vendor is not the project');
  const ghost = searchResponseKey({ root: dir, field: 'ghostField' });
  assert.ok(ghost.scannedFiles >= 2, `scanned count is evidence: ${ghost.scannedFiles}`);
  assert.ok(Array.isArray(ghost.sites), 'sites are returned for declared keys');
});

test('M4: with maxDepth 3 the resolver reaches the injected repository', () => {  const capped = resolveHandlerShape({ root: BACKEND, controller: 'CouponController', action: 'fromRepo' });
  assert.equal(capped.level, 'unresolved', JSON.stringify(capped));
  assert.equal(capped.reason, 'depth-cap', 'the default cap (controller -> service) holds');

  const hop3 = resolveHandlerShape({ root: BACKEND, controller: 'CouponController', action: 'fromRepo', maxDepth: 3 });
  assert.equal(hop3.level, 'repo', JSON.stringify(hop3));
  assert.deepEqual(hop3.keys, ['rows', 'count'], 'keys read from OrderRepository::rows');
  assert.equal(hop3.depth, 3);
  assert.ok(hop3.via.some((v) => /OrderRepository\.php/.test(v)), `via shows the third file: ${hop3.via.join(' -> ')}`);

  // …and the gate still refuses it: measured 2026-11-01, only 3/29 depth-cap pairs
  // resolve at hop 3 and NONE of them had a readable frontend, so agreement evidence
  // is zero (docs/shape-check.md §2.3)
  assert.equal(shapeIsComparable(hop3), false, 'level repo is not admitted without §2.3 evidence');
});
