/**
 * Navigation tests — regression coverage for:
 *   (a) non-string `imports` elements must not crash callers()/impact()
 *   (b) same-name symbols must report ambiguity with candidates
 *   (c) callers()/impact() must accept a { file } / { kind } disambiguation filter
 *
 * Run: node --test tests/navigation.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { archNav } from '../src/navigation.js';

let dir;

// A hand-built index fixture: getIndex(dirPath) reads <dir>/.archnav/index.json
const fixture = {
  symbols: [
    // Two definitions sharing the same name → ambiguity
    { id: 'a1', name: 'getUserInfo', kind: 'function', file: 'api/admin.js', line_start: 360, line_end: 366,
      imports: [{ from: './user', source: './user' }] },
    { id: 'a2', name: 'getUserInfo', kind: 'function', file: 'api/user.js', line_start: 17, line_end: 23,
      imports: ['./request'] },
    // Unique definition whose own imports contain a non-string (object) element
    { id: 'o1', name: 'orderTake', kind: 'function', file: 'pages/goods/order_details/index.vue', line_start: 50, line_end: 60,
      imports: [{ from: './x' }, 'api/mall'] },
    // Another symbol whose imports are objects only — this is what used to crash
    // the `imp.replace(...)` scan inside callers()/impact().
    { id: 'p1', name: 'listOrders', kind: 'function', file: 'pages/orders/index.vue', line_start: 10, line_end: 20,
      imports: [{ from: '@/api/order', source: '@/api/order', specifiers: ['listOrders'], line: 3 }] },
  ],
  fileHashes: {},
  knowledgeGraph: { edges: [] },
  layerMap: {},
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-nav-test-'));
  fs.mkdirSync(path.join(dir, '.archnav'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.archnav', 'index.json'), JSON.stringify(fixture));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- (a) non-string imports must not crash ---------------------------------

test('callers() does not throw when symbols carry non-string imports elements', async () => {
  const r = await archNav.callers('orderTake', dir);
  assert.ok(Array.isArray(r.relations), 'relations should be an array');
});

test('impact() does not throw when symbols carry non-string imports elements', async () => {
  const r = await archNav.impact('orderTake', dir);
  assert.equal(r.type, 'impact');
  assert.ok(Array.isArray(r.direct_impact));
});

// --- (b) same-name disambiguation ------------------------------------------

test('callers() reports ambiguity when a name has multiple definitions', async () => {
  const r = await archNav.callers('getUserInfo', dir);
  assert.equal(r.ambiguous, true);
  assert.ok(Array.isArray(r.candidates));
  assert.equal(r.candidates.length, 2);
  for (const c of r.candidates) {
    assert.deepEqual(Object.keys(c).sort(), ['file', 'kind', 'line', 'name']);
  }
  assert.deepEqual(r.candidates.map(c => c.file).sort(), ['api/admin.js', 'api/user.js']);
});

test('callers() keeps the original shape when the name is unique', async () => {
  const r = await archNav.callers('orderTake', dir);
  assert.notEqual(r.ambiguous, true);
  assert.equal(r.type, 'callers');
  assert.equal(r.symbol, 'orderTake');
  assert.equal(r.file, 'pages/goods/order_details/index.vue');
  assert.equal(typeof r.line, 'number');
  assert.ok(Array.isArray(r.relations));
});

test('locate() reports ambiguity with candidates for a duplicated name', async () => {
  const r = await archNav.locate('getUserInfo', dir);
  assert.equal(r.ambiguous, true);
  assert.equal(r.candidates.length, 2);
  assert.deepEqual(r.candidates.map(c => c.file).sort(), ['api/admin.js', 'api/user.js']);
});

test('locate() keeps the original shape when the name is unique', async () => {
  const r = await archNav.locate('orderTake', dir);
  assert.notEqual(r.ambiguous, true);
  assert.equal(r.type, 'locate');
  assert.equal(r.symbol.name, 'orderTake');
  assert.equal(r.symbol.file, 'pages/goods/order_details/index.vue');
});

// --- (c) file / kind disambiguation ----------------------------------------

test('callers(name, dir, { file }) disambiguates by file', async () => {
  const r = await archNav.callers('getUserInfo', dir, { file: 'api/user.js' });
  assert.notEqual(r.ambiguous, true);
  assert.equal(r.type, 'callers');
  assert.equal(r.file, 'api/user.js');
  assert.equal(r.line, 17);
});

test('impact(name, dir, { file }) disambiguates by file', async () => {
  const r = await archNav.impact('getUserInfo', dir, { file: 'api/admin.js' });
  assert.notEqual(r.ambiguous, true);
  assert.equal(r.type, 'impact');
  assert.equal(r.file, 'api/admin.js');
  assert.equal(r.line_start, 360);
});

test('locate(name, dir, { file, kind }) filters by file and kind', async () => {
  const r = await archNav.locate('getUserInfo', dir, { file: 'api/admin.js', kind: 'function' });
  assert.notEqual(r.ambiguous, true);
  assert.equal(r.symbol.file, 'api/admin.js');
});

// --- (c2) --file naming a *caller* file filters the result list -------------

test('callers(name, dir, { file }) filters relations when the file is a caller', async () => {
  const r = await archNav.callers('orderTake', dir, { file: 'pages/orders/index.vue' });
  assert.notEqual(r.ambiguous, true);
  assert.equal(r.type, 'callers');
  assert.equal(r.filtered_by_file, 'pages/orders/index.vue');
  assert.ok(r.relations.every(rel => rel.file.replace(/\\/g, '/') === 'pages/orders/index.vue'));
  assert.ok(r.relations.some(rel => rel.symbol === 'listOrders'));
});

test('callers(name, dir, { file }) on a caller file with no hits returns an empty list', async () => {
  const r = await archNav.callers('orderTake', dir, { file: 'pages/nowhere.vue' });
  assert.equal(r.type, 'callers');
  assert.deepEqual(r.relations, []);
});
