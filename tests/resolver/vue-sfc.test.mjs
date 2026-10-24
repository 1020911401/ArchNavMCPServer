/**
 * Tests for src/resolver/vue-sfc.js — Vue SFC nested-callback call extraction.
 *
 * Run: node --test tests/resolver/
 */
import { test, before, after } from 'node:test';
import { testWithFixtures } from '../helpers/fixtures.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractVueCalls } from '../../src/resolver/vue-sfc.js';
import { buildResolvedEdges } from '../../src/resolver/integrate.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vue = p => path.join(repo, 'bench', 'vue-app', p);

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

testWithFixtures('order_details/index.vue → orderTake@1316 nested in a `success` callback', () => {
  const calls = extractVueCalls(vue('pages/goods/order_details/index.vue'));
  const hit = calls.find(c => c.callee === 'orderTake' && c.line === 1316);
  assert.ok(hit, 'orderTake call at line 1316 was extracted');
  assert.match(String(hit.enclosing), /success/, 'enclosing references success');
  assert.equal(hit.kind, 'callback');
});

testWithFixtures('integral_order_details.vue → orderTake inside a callback near line 423', () => {
  const calls = extractVueCalls(vue('pages/points_mall/integral_order_details.vue'));
  const hit = calls.find(c => c.callee === 'orderTake');
  assert.ok(hit, 'orderTake call extracted');
  assert.ok(hit.line >= 420 && hit.line <= 426, `line in 420..426, got ${hit.line}`);
  assert.match(String(hit.enclosing), /success/);
  assert.equal(hit.kind, 'callback');
});

testWithFixtures('<script setup>: top-level calls are setup, nested arrows are callbacks', () => {
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

testWithFixtures('options-API methods: direct call is a method, nested success callback is a callback', () => {
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

// ═══════════════════════════════════════════════════════════════════════════
//  uni-app conditional compilation (`// #ifdef`) — the strict TS parser gives
//  up on these blocks, so they used to contribute ZERO call edges. The
//  acorn-loose fallback must recover their *real* calls and nothing else.
// ═══════════════════════════════════════════════════════════════════════════

/** The 4 SFCs in bench/vue-app whose <script> block the TS parser rejects. */
const IFDEF_SFCS = [
  'components/payment/index.vue',
  'pages/goods/cashier/index.vue',
  'pages/goods/order_confirm/index.vue',
  'pages/users/user_info/index.vue',
];

testWithFixtures('#ifdef SFC: payment/index.vue recovers orderPay() with its real line number', () => {
  const calls = extractVueCalls(vue('components/payment/index.vue'));
  const hit = calls.find(c => c.callee === 'orderPay');
  assert.ok(hit, 'orderPay survived the strict-parse failure');
  assert.equal(hit.kind, 'callback');
  assert.equal(hit.enclosing, 'goPay');

  // ground truth from disk — not from the parser under test
  const raw = fs.readFileSync(vue('components/payment/index.vue'), 'utf-8').split('\n');
  assert.match(raw[hit.line - 1], /\borderPay\s*\(/, `line ${hit.line} really calls orderPay(`);
});

testWithFixtures('#ifdef SFC: cashier/index.vue recovers orderPay() at the grepped line', () => {
  const raw = fs.readFileSync(vue('pages/goods/cashier/index.vue'), 'utf-8').split('\n');
  const trueLines = raw
    .map((text, i) => (/\borderPay\s*\(/.test(text) ? i + 1 : 0))
    .filter(Boolean);
  assert.ok(trueLines.length > 0, 'fixture sanity: the file really calls orderPay(');

  const lines = extractVueCalls(vue('pages/goods/cashier/index.vue'))
    .filter(c => c.callee === 'orderPay')
    .map(c => c.line)
    .sort((a, b) => a - b);
  assert.deepEqual(lines, trueLines, 'every orderPay( call site is found at the right line');
});

testWithFixtures('#ifdef SFCs: all four produce real calls, and zero comment/dummy garbage', () => {
  const GARBAGE = /^(?:✖|#|ifdef|ifndef|endif|<\/?[a-z])/i;
  let total = 0;

  for (const rel of IFDEF_SFCS) {
    const file = vue(rel);
    const raw = fs.readFileSync(file, 'utf-8');
    const lines = raw.split('\n');
    const calls = extractVueCalls(file);

    assert.ok(calls.length > 50, `${rel}: expected a real call list, got ${calls.length}`);
    total += calls.length;

    for (const c of calls) {
      // an identifier callee — never a comment marker, template tag or acorn-loose dummy
      assert.match(c.callee, /^[A-Za-z_$][A-Za-z0-9_$]*$/, `garbage callee ${JSON.stringify(c.callee)} in ${rel}`);
      assert.ok(!GARBAGE.test(c.callee), `garbage callee ${JSON.stringify(c.callee)} in ${rel}`);
      // every extracted call must have a call site in the file text
      assert.ok(raw.includes(`${c.callee}(`), `${rel}:${c.line} ${c.callee}() has no call site in the file`);
      assert.ok(Number.isInteger(c.line) && c.line >= 1 && c.line <= lines.length, `${rel}: line ${c.line} is out of range`);
    }
  }

  assert.ok(total > 400, `the four malformed SFCs contribute real calls (got ${total})`);
});

testWithFixtures('#ifdef SFC: the recovered call becomes a call-graph:callback edge to api/order.js', () => {
  const { edges } = buildResolvedEdges(vue('.'), [{ name: 'orderPay', file: 'api/order.js' }]);
  const hits = edges.filter(e =>
    e.from === 'file:components/payment/index.vue' && e.to === 'sym:api/order.js::orderPay');
  assert.equal(hits.length, 1, `expected exactly one orderPay edge, got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].source_kind, 'callback');
  assert.equal(hits[0].line, 138);
});
