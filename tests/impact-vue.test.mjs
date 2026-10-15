/**
 * Vue-side impact tests — the uni-app graph must let impact() climb *past* the
 * `.vue` call site.
 *
 * The gap being fixed: a `.vue` file's call sites are recorded as
 * `file:<path>` nodes ("the call happens inside this file"), and those nodes had
 * **zero incoming edges**, so a depth-2 reverse DEPENDS_ON walk was structurally
 * empty on the Vue side — `impact orderTake --file api/order.js` reported the 2
 * call-site files and nothing else.
 *
 * Now the graph also carries page → file edges (pages.json) and component → file
 * edges (`@/components/…` imports), so depth 2 reaches the page that renders the
 * component / owns the call site.
 *
 * Nothing here is inferred from an import-basename guess: every relation must
 * come from a DEPENDS_ON edge.
 *
 * Run: node --test tests/impact-vue.test.mjs
 *      (needs a fresh index: `node src/index.js analyze bench/vue-app`)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { archNav } from '../src/navigation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VUE = path.resolve(here, '..', 'bench', 'vue-app');

const posix = (p) => String(p ?? '').replace(/\\/g, '/');
const readIndex = () => JSON.parse(fs.readFileSync(path.join(VUE, '.archnav', 'index.json'), 'utf-8'));

// ── depth 1 must not regress ───────────────────────────────────────────────

test('impact(orderTake): depth-1 is still exactly the 2 real .vue call-site files', async () => {
  const r = await archNav.impact('orderTake', VUE, { file: 'api/order.js' });
  assert.notEqual(r.ambiguous, true);

  const files = r.direct_impact.map((d) => posix(d.file)).sort();
  assert.deepEqual(files, [
    'pages/goods/order_details/index.vue',
    'pages/users/user_invoice_order/index.vue',
  ]);
  // no import-basename false positive sneaks back in through the new edges
  assert.ok(
    !r.direct_impact.some((d) => /skuSelect|mixins\//i.test(posix(d.file))),
    'mixins/skuSelect.js only imports api/order.js — it is not a caller',
  );
  assert.ok(!r.direct_impact.some((d) => d.source === 'import-heuristic'));
  for (const d of r.direct_impact) assert.equal(d.depth, 1);
});

// ── depth 2 now reaches pages ──────────────────────────────────────────────

test('impact(orderTake): depth-2 now reaches the PAGES that own those call sites', async () => {
  const r = await archNav.impact('orderTake', VUE, { file: 'api/order.js' });
  const ind = r.indirect_relations ?? r.indirect_impact;
  assert.ok(Array.isArray(ind), 'indirect_relations must be an array');
  assert.ok(ind.length > 0, 'depth-2 must no longer be structurally empty');

  const pages = ind.filter((x) => x.kind === 'page');
  assert.ok(pages.length > 0, `expected page relations at depth 2 (got ${JSON.stringify(ind)})`);

  const symbols = pages.map((p) => p.symbol);
  assert.ok(
    symbols.includes('PAGE /pages/goods/order_details/index'),
    `expected PAGE /pages/goods/order_details/index (got ${JSON.stringify(symbols)})`,
  );
  // this page renders the payment component — i.e. a page reached through the
  // component graph, not just the direct call site.
  assert.ok(
    symbols.includes('PAGE /pages/users/user_invoice_order/index'),
    `expected PAGE /pages/users/user_invoice_order/index (got ${JSON.stringify(symbols)})`,
  );

  for (const p of pages) {
    assert.equal(p.depth, 2);
    assert.equal(p.file, 'pages.json', 'a page relation renders the declaring file');
    assert.ok(Number.isInteger(p.line) && p.line > 0, 'a page relation renders the declaring line');
    assert.equal(typeof p.via, 'string');
  }
});

// ── the original component-internal-symbol case, now reachable ─────────────

test('impact(goPay): a component method climbs to the pages that render the component', async () => {
  const r = await archNav.impact('goPay', VUE, { file: 'components/payment/index.vue' });
  assert.notEqual(r.ambiguous, true, 'goPay is defined in several pages, so --file must disambiguate');
  assert.equal(posix(r.file), 'components/payment/index.vue');
  assert.equal(r.line_start, 121);

  // depth 1: the files that reference the component (its owner file's dependents)
  const directFiles = r.direct_impact.map((d) => posix(d.file));
  assert.ok(
    directFiles.includes('pages/users/user_invoice_order/index.vue'),
    `expected the component's referrers at depth 1 (got ${JSON.stringify(directFiles)})`,
  );
  for (const d of r.direct_impact) assert.equal(d.depth, 1);

  // depth 2: the page entry points those files are pages of
  const ind = r.indirect_relations ?? r.indirect_impact;
  assert.ok(Array.isArray(ind) && ind.length > 0, 'depth-2 must not be empty');
  const pages = ind.filter((x) => x.kind === 'page');
  assert.ok(pages.length > 0, `expected PAGE relations (got ${JSON.stringify(ind)})`);
  const symbols = pages.map((p) => p.symbol);
  assert.ok(
    symbols.includes('PAGE /pages/users/user_invoice_order/index'),
    `expected PAGE /pages/users/user_invoice_order/index (got ${JSON.stringify(symbols)})`,
  );
  for (const p of pages) {
    assert.equal(p.file, 'pages.json');
    assert.ok(Number.isInteger(p.line) && p.line > 0);
  }
});

// ── the graph structure those depth-2 hops rely on ─────────────────────────

test('component graph: file:components/payment/index.vue is referenced by pages', () => {
  const idx = readIndex();
  const deps = idx.knowledgeGraph.edges.filter((e) => e.type === 'DEPENDS_ON');
  const incoming = deps.filter((e) => e.to === 'file:components/payment/index.vue');
  assert.ok(incoming.length >= 1, 'the payment component must have incoming component edges');
  assert.ok(incoming.every((e) => e.source_kind === 'component'));
  assert.ok(
    incoming.some((e) => e.from === 'file:pages/users/user_invoice_order/index.vue'),
    'user_invoice_order/index.vue imports the payment component',
  );
  assert.ok(
    !incoming.some((e) => e.to === e.from),
    'a file must never reference itself',
  );
});

test('page graph: page:pages/goods/order_details/index points at its .vue file', () => {
  const idx = readIndex();
  const edge = idx.knowledgeGraph.edges.find(
    (e) => e.from === 'page:pages/goods/order_details/index'
      && e.to === 'file:pages/goods/order_details/index.vue',
  );
  assert.ok(edge, 'page → file edge must exist');
  assert.equal(edge.type, 'DEPENDS_ON');
  const node = idx.knowledgeGraph.nodes.find((n) => n.id === 'page:pages/goods/order_details/index');
  assert.ok(node, 'page node must be registered in the graph');
  assert.equal(node.file, 'pages.json');
});

// ── the explicit "owner file" hop, on hand-built graphs ────────────────────
//
// Semantics: when expanding a node we take its own incoming DEPENDS_ON edges
// *plus* the incoming edges of the file it belongs to (`file:` + the symbol's
// own file). That is what makes a component method reachable: nothing calls
// `goPay`, but the file that defines it is referenced by every page that
// renders the component.

/** Build a throwaway index and read it back through impact(). */
function withIndex(edges, symbols, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-owner-'));
  try {
    fs.mkdirSync(path.join(dir, '.archnav'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.archnav', 'index.json'),
      JSON.stringify({ symbols, fileHashes: {}, layerMap: {}, knowledgeGraph: { nodes: [], edges } }),
    );
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const sym = (file, name) => ({ id: name, name, kind: 'function', file, line_start: 1, line_end: 3, imports: [] });

test('owner-file hop: a symbol with no caller still surfaces the files that reference its file', async () => {
  await withIndex(
    [
      // nothing calls `goPay` …
      // … but the file it lives in is referenced by a component consumer.
      { from: 'file:pages/a/index.vue', to: 'file:components/payment/index.vue', type: 'DEPENDS_ON', line: 1, source_kind: 'component' },
    ],
    [sym('components\\payment\\index.vue', 'goPay')],
    async (dir) => {
      const r = await archNav.impact('goPay', dir);
      assert.notEqual(r.ambiguous, true);
      const direct = r.direct_impact.map((d) => posix(d.file));
      // note the '\' spelling of the symbol's own file must still find the '/'
      // file node the component edge points at.
      assert.ok(
        direct.includes('pages/a/index.vue'),
        `expected the referrer at depth 1 (got ${JSON.stringify(r.direct_impact)})`,
      );
      for (const d of r.direct_impact) assert.equal(d.depth, 1);
    },
  );
});

test('owner-file hop: depth 2 walks the incoming edges of the node\'s own file', async () => {
  await withIndex(
    [
      // depth-1 for `helper` is a *symbol* in a different file, whose own
      // incoming edges are empty …
      { from: 'sym:src/mid.js::callerSym', to: 'sym:src/helper.js::helper', type: 'DEPENDS_ON', line: 11, source_kind: 'ast' },
      // … but that file is referenced by a component.
      { from: 'file:components/payment/index.vue', to: 'file:src/mid.js', type: 'DEPENDS_ON', line: 1, source_kind: 'component' },
    ],
    [sym('src/helper.js', 'helper'), sym('src/mid.js', 'callerSym')],
    async (dir) => {
      const r = await archNav.impact('helper', dir);
      assert.notEqual(r.ambiguous, true);
      assert.ok(r.direct_impact.some((d) => d.symbol === 'callerSym'), 'depth 1 is the real caller');
      const files = (r.indirect_relations || []).map((x) => posix(x.file));
      assert.ok(
        files.includes('components/payment/index.vue'),
        `the depth-2 owner-file hop must surface the referrer (got ${JSON.stringify(r.indirect_relations)})`,
      );
      for (const rel of r.indirect_relations) assert.equal(rel.depth, 2);
    },
  );
});
