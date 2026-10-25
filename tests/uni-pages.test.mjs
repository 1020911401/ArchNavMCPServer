/**
 * uni-app page/graph parser tests — src/parsers/uniPages.js
 *
 * Covers the three edge groups the module must produce, plus the loud
 * `unresolved` bucket (nothing may be silently dropped):
 *   (a) pages.json / subPackages / tabBar → `page:` nodes + page → `file:` edges
 *   (b) uni.navigateTo… / <navigator url> → `file:` → `page:` navigation edges
 *   (c) `@/components/…` imports          → `file:` → `file:` component edges
 *
 * The real corpus is bench/vue-app (a uni-app project); the unresolved cases use
 * a tiny throwaway project built in the test so a ghost page path can be
 * constructed on purpose.
 *
 * Run: node --test tests/uni-pages.test.mjs
 */
import { test } from 'node:test';
import { testWithFixtures } from './helpers/fixtures.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractUniPages } from '../src/parsers/uniPages.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VUE = path.resolve(here, '..', 'bench', 'vue-app');

// One scan of the real corpus, shared by the assertions below (the extractor
// walks + reads the whole repo, so don't pay for it per test).
const CORPUS = extractUniPages(VUE, []);

const byId = (nodes) => new Map(nodes.map((n) => [n.id, n]));
const byKind = (edges, kind) => edges.filter((e) => e.source_kind === kind);

// ── (a) pages.json → page nodes + page → file edges ────────────────────────

testWithFixtures('pages.json: every pages[] entry becomes a page: node pointing at its .vue', () => {
  const { nodes, edges } = CORPUS;
  const ids = byId(nodes);

  for (const p of [
    'pages/guide/index',
    'pages/index/index',
    'pages/order_addcart/order_addcart',
    'pages/user/index',
    'pages/goods_cate/goods_cate',
  ]) {
    assert.ok(ids.has(`page:${p}`), `missing page node page:${p}`);
  }

  const node = ids.get('page:pages/index/index');
  assert.equal(node.type, 'page');
  assert.equal(node.file, 'pages.json', 'the node records where the declaration lives');
  assert.ok(Number.isInteger(node.line) && node.line > 0, 'page node carries a pages.json line');

  const edge = edges.find(
    (e) => e.from === 'page:pages/index/index' && e.to === 'file:pages/index/index.vue',
  );
  assert.ok(edge, 'page:pages/index/index must point at file:pages/index/index.vue');
  assert.equal(edge.type, 'DEPENDS_ON');
  assert.ok(Number.isInteger(edge.line) && edge.line > 0);
});

testWithFixtures('subPackages: a page path is joined with its root', () => {
  const { nodes } = CORPUS;
  const ids = byId(nodes);

  // { root: 'pages/goods_details', pages: [{ path: 'index' }] }
  assert.ok(ids.has('page:pages/goods_details/index'), 'root + path must be joined');
  assert.equal(ids.get('page:pages/goods_details/index').source, 'subPackages');
  // { root: 'pages/goods', pages: [{ path: 'order_details/index' }] }
  assert.ok(ids.has('page:pages/goods/order_details/index'));
  // { root: 'pages/points_mall', pages: [{ path: 'integral_goods_list' }] }
  assert.ok(ids.has('page:pages/points_mall/integral_goods_list'));
});

testWithFixtures('tabBar: list[].pagePath is a declaration source too', () => {
  const { nodes } = CORPUS;
  const ids = byId(nodes);
  const node = ids.get('page:pages/goods_cate/goods_cate');
  assert.ok(node, 'tabBar pagePath must produce a page node');
  assert.ok(node.sources.includes('tabBar'), 'tabBar must be recorded as a source');
});

// ── (b) navigation edges ───────────────────────────────────────────────────

testWithFixtures('navigation: uni.navigateTo/switchTab and <navigator url> become navigation edges', () => {
  const { edges } = CORPUS;
  const nav = byKind(edges, 'navigation');
  assert.ok(nav.length > 0, 'expected navigation edges from the uni-app corpus');

  for (const e of nav) {
    assert.ok(e.from.startsWith('file:'), `navigation edge source must be a file: ${e.from}`);
    assert.ok(e.to.startsWith('page:'), `navigation edge target must be a page: ${e.to}`);
    assert.ok(Number.isInteger(e.line) && e.line > 0, 'navigation edge carries a line');
  }

  // `?order_id=` query strings are stripped before matching pages.json.
  assert.ok(
    nav.some((e) => e.to === 'page:pages/goods/order_details/index'),
    'a `?query=` url must still match its page',
  );
  // A tabBar target reached through switchTab/reLaunch/navigateTo.
  assert.ok(nav.some((e) => e.to === 'page:pages/index/index'));
});

// ── (c) component edges ────────────────────────────────────────────────────

testWithFixtures('component: `@/components/…` imports become component edges to the real .vue', () => {
  const { edges } = CORPUS;
  const comp = byKind(edges, 'component');
  assert.ok(comp.length > 0, 'expected component edges');

  const edge = comp.find((e) => e.to === 'file:components/payment/index.vue');
  assert.ok(edge, 'the payment component is imported by several pages');
  assert.ok(edge.from.startsWith('file:pages/'), 'the referrer is the importing page file');
  assert.ok(Number.isInteger(edge.line) && edge.line > 0);
});

// ── unresolved: nothing may be dropped silently ────────────────────────────

test('unresolved: ghost pages, missing .vue and dynamic urls are all reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-uni-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'pages.json'),
      JSON.stringify({
        pages: [{ path: 'pages/a/index' }, { path: 'pages/declared_without_vue/index' }],
        subPackages: [],
        tabBar: { list: [] },
      }),
    );
    fs.mkdirSync(path.join(dir, 'pages', 'a'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'pages', 'a', 'index.vue'),
      [
        '<template>',
        '  <navigator url="/pages/ghost/nope">go</navigator>',
        '</template>',
        '<script>',
        "uni.navigateTo({ url: '/pages/ghost/other?id=1' });",
        'uni.navigateTo({ url: someDynamicVar });',
        '</script>',
      ].join('\n'),
    );

    const { nodes, edges, unresolved } = extractUniPages(dir, []);
    const ids = byId(nodes);

    // the two declared pages exist as nodes
    assert.ok(ids.has('page:pages/a/index'));
    assert.ok(ids.has('page:pages/declared_without_vue/index'));
    // the page that has no .vue gets no page→file edge …
    assert.ok(
      !edges.some((e) => e.from === 'page:pages/declared_without_vue/index'),
      'no page→file edge when the .vue is absent',
    );
    // … and is reported instead
    assert.ok(
      unresolved.some((u) => u.kind === 'page' && u.target === 'pages/declared_without_vue/index' && u.reason === 'missing-vue'),
      `expected a missing-vue entry (got ${JSON.stringify(unresolved)})`,
    );

    // the page that does have a .vue is linked
    assert.ok(edges.some((e) => e.from === 'page:pages/a/index' && e.to === 'file:pages/a/index.vue'));

    // ghost navigation targets (tag + call, query stripped) are reported, not linked
    const targets = unresolved.map((u) => u.target);
    assert.ok(targets.includes('pages/ghost/nope'), 'navigator url ghost page');
    assert.ok(targets.includes('pages/ghost/other'), 'query-stripped ghost page');
    assert.ok(!edges.some((e) => e.to === 'page:pages/ghost/nope'));
    assert.ok(unresolved.some((u) => u.reason === 'unknown-page'));
    // a non-literal url is reported as well
    assert.ok(unresolved.some((u) => u.reason === 'dynamic-url'), 'non-literal url must be reported');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── pages.json discovery: per app, not only at the repo root ───────────────
//
// A monorepo keeps the uni-app at `<app>/src/pages.json` (crmeb-laravel:
// uniapp/src/pages.json). Reading only `<root>/pages.json` found nothing there,
// so `knownPages` stayed empty — every page looked unregistered and every
// navigateTo looked like a dead link (measured: 89 + 12 bogus findings).
test('pages.json is found under <app>/src and page paths resolve against that app', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-uni-app-'));
  try {
    const mk = (rel, body = '') => {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    };
    mk('uniapp/src/pages.json', JSON.stringify({
      pages: [{ path: 'pages/index/index' }, { path: 'pages/ghost/none' }],
      tabBar: { list: [{ pagePath: 'pages/index/index' }] },
    }));
    mk('uniapp/src/pages/index/index.vue', "<template><view/></template>\n<script>uni.navigateTo({ url: '/pages/ghost/none' });</script>");
    // a sibling SPA: no pages.json, so nothing here is a uni-app page
    mk('admin/src/pages/dash/Home.vue', '<template><view/></template>');

    const { nodes, edges, stats, unresolved } = extractUniPages(dir, []);

    assert.deepEqual(stats.apps, [{ pagesJson: 'uniapp/src/pages.json', baseDir: 'uniapp/src', pages: 2 }]);
    assert.equal(stats.pages, 2, 'both declared pages become nodes');
    // the .vue is found relative to the app that declared it, not the repo root
    assert.ok(
      edges.some((e) => e.from === 'page:pages/index/index' && e.to === 'file:uniapp/src/pages/index/index.vue'),
      `page→file edge must point into uniapp/src (got ${JSON.stringify(edges.map((e) => [e.from, e.to]))})`,
    );
    // the declared-but-missing page is reported against the right pages.json
    assert.ok(unresolved.some((u) => u.reason === 'missing-vue'
      && u.file === 'uniapp/src/pages.json' && u.target === 'pages/ghost/none'));
    // a page node is never invented for the SPA
    assert.ok(!nodes.some((n) => String(n.file || '').startsWith('admin/')));
    // …and the navigation target that IS declared is linked, not reported
    assert.ok(edges.some((e) => e.from === 'file:uniapp/src/pages/index/index.vue' && e.to === 'page:pages/ghost/none'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
