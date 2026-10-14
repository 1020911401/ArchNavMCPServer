/**
 * Tests for src/resolver/vue-sfc.js — Vue SFC nested-callback call extraction.
 *
 * Run: node --test tests/resolver/
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractVueCalls } from '../../src/resolver/vue-sfc.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vue = p => path.join(repo, 'bench', 'vue-app', p);

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('order_details/index.vue → orderTake@1316 nested in a `success` callback', () => {
  const calls = extractVueCalls(vue('pages/goods/order_details/index.vue'));
  const hit = calls.find(c => c.callee === 'orderTake' && c.line === 1316);
  assert.ok(hit, 'orderTake call at line 1316 was extracted');
  assert.match(String(hit.enclosing), /success/, 'enclosing references success');
  assert.equal(hit.kind, 'callback');
});

test('integral_order_details.vue → orderTake inside a callback near line 423', () => {
  const calls = extractVueCalls(vue('pages/points_mall/integral_order_details.vue'));
  const hit = calls.find(c => c.callee === 'orderTake');
  assert.ok(hit, 'orderTake call extracted');
  assert.ok(hit.line >= 420 && hit.line <= 426, `line in 420..426, got ${hit.line}`);
  assert.match(String(hit.enclosing), /success/);
  assert.equal(hit.kind, 'callback');
});

test('<script setup>: top-level calls are setup, nested arrows are callbacks', () => {
  const f = path.join(dir, 'Setup.vue');
  fs.writeFileSync(f, [
    '<template><view/></template>',
    '<script setup>',
    "import { getUserInfo } from '@/api/user.js'",
    'getUserInfo()',
    'function run () {',
    '  fetchData().then(res => {',
    '    doCallback()',
    '  })',
    '}',
    'const helper = () => {',
    '  doHelper()',
    '}',
    '</script>',
  ].join('\n'));

  const calls = extractVueCalls(f);
  const byName = Object.fromEntries(calls.map(c => [c.callee, c]));

  assert.equal(byName.getUserInfo.line, 4);
  assert.equal(byName.getUserInfo.kind, 'setup');
  assert.equal(byName.getUserInfo.enclosing, null);

  assert.equal(byName.doCallback.kind, 'callback');
  assert.equal(byName.doCallback.enclosing, 'run');

  assert.equal(byName.doHelper.kind, 'method');
  assert.equal(byName.doHelper.enclosing, 'helper');
});

test('options-API methods: direct call is a method, nested success callback is a callback', () => {
  const f = path.join(dir, 'Options.vue');
  fs.writeFileSync(f, [
    '<template><view/></template>',
    '<script>',
    'export default {',
    '  mounted () {',
    '    this.load()',
    '  },',
    '  methods: {',
    '    load () {',
    '      uni.showModal({',
    '        success: (res) => {',
    '          orderTake(orderId ? orderId : this.order_id)',
    '        }',
    '      })',
    '    }',
    '  }',
    '}',
    '</script>',
  ].join('\n'));

  const calls = extractVueCalls(f);
  const load = calls.find(c => c.callee === 'load');
  assert.equal(load.kind, 'method');
  assert.equal(load.enclosing, 'mounted');

  const take = calls.find(c => c.callee === 'orderTake');
  assert.equal(take.line, 11);
  assert.equal(take.kind, 'callback');
  assert.equal(take.enclosing, 'success');
});
