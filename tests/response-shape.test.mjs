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
import { resolveHandlerShape, methodBody } from '../scripts/response-shape.mjs';

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

test('two classes with the same name: the one that declares the action wins', (t) => {
  // measured on the real repo: 5 handlers of `System/.../ThemeController` resolved to
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
