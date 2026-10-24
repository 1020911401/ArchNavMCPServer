/**
 * Shared SFC parse cache — src/parsers/vueCache.js
 *
 * The contract this file pins down:
 *   1. one parse per file per run — the analyzer pass
 *      (src/analyzer.js → parseVueFile) and the resolver pass
 *      (src/resolver/index.js → scanModules) read the same `.vue` file, and the
 *      second reader is served from the cache instead of re-parsing;
 *   2. keying — blocks are keyed by (absolute path, size, mtimeMs), ASTs by the
 *      script body itself, so a changed file can never be served a stale entry
 *      (this file rewrites a fixture and asserts the new body is visible);
 *   3. boundedness — the caches evict oldest-first once they hit their entry or
 *      byte limit, so a long-lived process cannot grow without limit;
 *   4. isolation — two repos with the *same relative path* never share a blocks
 *      entry.
 *
 * Run: node --test tests/vue-parse-cache.test.mjs
 */
import { test, before, after } from 'node:test';
import { testWithFixtures } from './helpers/fixtures.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractScriptBlocks, extractVueCalls, parseModule, collectCalls,
} from '../src/resolver/vue-sfc.js';
import { parseVueFile } from '../src/parsers/vueSymbols.js';
import {
  CACHE_LIMITS, cacheSizes, cacheStats, clearParseCache,
} from '../src/parsers/vueCache.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vue = (p) => path.join(repo, 'bench', 'vue-app', p);

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-cache-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Write a fixture under the temp root and return its absolute path. */
function write(rel, text) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

/** A minimal SFC whose <script> body is `body`. */
const sfc = (body) => `<template><view/></template>\n<script>\n${body}\n</script>\n`;

// ═══════════════════════════════════════════════
//  1. one parse per file per run
// ═══════════════════════════════════════════════

test('analyzer pass + resolver pass share one parse (the .vue double-parse is gone)', () => {
  const file = write('shared/index.vue', sfc([
    "import { orderPay } from '@/api/order.js'",
    'export default {',
    '  methods: {',
    '    goPay () {',
    '      orderPay({ id: 1 }).then(res => { done(res) })',
    '    }',
    '  }',
    '}',
  ].join('\n')));

  clearParseCache();
  const before0 = cacheStats();

  // pass 1 — what src/analyzer.js does: it already read the file, then asks for symbols
  const content = fs.readFileSync(file, 'utf-8');
  const parsed = parseVueFile(file, tmp, content);
  assert.ok(parsed.symbols.some((s) => s.name === 'goPay'), 'pass 1 extracted goPay');

  // pass 2 — what src/resolver/index.js scanModules() does: re-read from disk and parse
  const calls = [];
  for (const block of extractScriptBlocks(file)) {
    const ast = parseModule(block.body, { jsx: block.jsx });
    calls.push(...collectCalls(ast, { lineOffset: block.startLine, setup: block.setup }));
  }
  const hit = calls.find((c) => c.callee === 'orderPay');
  assert.ok(hit, 'pass 2 saw the same call');
  assert.equal(hit.line, 7);

  const after1 = cacheStats();
  assert.equal(after1.parses - before0.parses, 1, 'the script body reached the parser exactly once');
  assert.equal(after1.blocksHits - before0.blocksHits, 1, 'the second pass reused the cached blocks');
  assert.equal(after1.astHits - before0.astHits, 1, 'the second pass reused the cached AST');
});

test('a second call with the same path and body is a hit, a different body is not', () => {
  clearParseCache();
  const a = write('keyed/one.vue', sfc('export default {}'));
  const b = write('keyed/two.vue', sfc('export default { methods: {} }'));
  const s0 = cacheStats();

  extractScriptBlocks(a);
  extractScriptBlocks(a);
  extractScriptBlocks(b);

  const s = cacheStats();
  assert.equal(s.blocksMisses - s0.blocksMisses, 2, 'the file was split twice (a, b) — never three times');
  assert.equal(s.blocksHits - s0.blocksHits, 1, 'the identical (path, size, mtime) pair was served from cache');
});

// ═══════════════════════════════════════════════
//  2. invalidation — a changed file must re-parse
// ═══════════════════════════════════════════════

test('a rewritten file is re-parsed (grow the script → new size)', () => {
  const file = write('invalidate/grow.vue', sfc('export default { methods: { a () { oldCall() } } }'));
  assert.ok(extractVueCalls(file).some((c) => c.callee === 'oldCall'));

  fs.writeFileSync(file, sfc('export default { methods: { a () { newCall() } } }'));
  const after = extractVueCalls(file);
  assert.ok(after.some((c) => c.callee === 'newCall'), 'the rewrite is visible');
  assert.ok(!after.some((c) => c.callee === 'oldCall'), 'no stale call survived the rewrite');
});

test('a SAME-SIZE rewrite is still re-parsed (mtime part of the key)', () => {
  const v1 = sfc('export default { methods: { a () { aaaCall() } } }');
  const v2 = v1.replace('aaaCall', 'bbbCall');
  assert.equal(v2.length, v1.length, 'fixture: both versions have the same byte length');

  const file = write('invalidate/same-size.vue', v1);
  assert.ok(extractVueCalls(file).some((c) => c.callee === 'aaaCall'));

  fs.writeFileSync(file, v2);
  const after = extractVueCalls(file);
  assert.ok(after.some((c) => c.callee === 'bbbCall'), 'same-size rewrite is visible');
  assert.ok(!after.some((c) => c.callee === 'aaaCall'), 'no stale call survived a same-size rewrite');
});

test('a caller-supplied body wins over what the cache holds for that path', () => {
  const onDisk = sfc('export default { methods: { aaaFn () { aaaaCall() } } }');
  const inMemory = sfc('export default { methods: { bbbFn () { bbbbCall() } } }');
  assert.equal(inMemory.length, onDisk.length, 'fixture: same byte length, disk never changes');
  const file = write('invalidate/from-memory.vue', onDisk);

  const first = parseVueFile(file, tmp, onDisk);
  assert.ok(first.symbols.some((s) => s.name === 'aaaFn'));
  const second = parseVueFile(file, tmp, inMemory);
  assert.ok(second.symbols.some((s) => s.name === 'bbbFn'), 'the supplied body was parsed');
  assert.ok(!second.symbols.some((s) => s.name === 'aaaFn'), 'the cached disk body was not reused');
});

// ═══════════════════════════════════════════════
//  3. boundedness
// ═══════════════════════════════════════════════

test('the AST cache is bounded and evicts oldest-first', () => {
  clearParseCache();
  const limit = CACHE_LIMITS.astEntries;
  const n = limit + 32;
  for (let i = 0; i < n; i++) parseModule(`const v${i} = ${i};\n`);

  const sizes = cacheSizes();
  assert.ok(sizes.ast <= limit, `AST cache stayed within ${limit} entries (got ${sizes.ast})`);
  assert.equal(sizes.ast, limit, 'the cache filled up to — not past — its limit');

  // the oldest entry was evicted: re-parsing it is a miss …
  const s0 = cacheStats();
  parseModule('const v0 = 0;\n');
  assert.equal(cacheStats().parses - s0.parses, 1, 'the oldest entry was evicted');

  // … while the newest one is still there: a hit, i.e. no new parse
  const s1 = cacheStats();
  parseModule(`const v${n - 1} = ${n - 1};\n`);
  assert.equal(cacheStats().parses - s1.parses, 0, 'the newest entry is still cached');
  assert.equal(cacheStats().astHits - s1.astHits, 1);
});

test('the blocks cache is bounded too', () => {
  clearParseCache();
  const limit = CACHE_LIMITS.blocksEntries;
  for (let i = 0; i < limit + 8; i++) {
    const f = write(`bounded/f${i}.vue`, sfc(`export default { methods: { m${i} () {} } }`));
    extractScriptBlocks(f);
  }
  const sizes = cacheSizes();
  assert.ok(sizes.blocks <= limit, `blocks cache stayed within ${limit} entries (got ${sizes.blocks})`);
  assert.ok(cacheStats().evictions > 0, 'something was evicted');
});

// ═══════════════════════════════════════════════
//  4. isolation — no cross-repo bleed
// ═══════════════════════════════════════════════

test('two repos with the same relative path never share a blocks entry', () => {
  const bodyA = 'export default { methods: { fromA () {} } }';
  const bodyB = 'export default { methods: { fromB () {} } }';
  assert.equal(bodyA.length, bodyB.length, 'fixture: same size, different content');
  const a = write('repoA/pages/index.vue', sfc(bodyA));
  const b = write('repoB/pages/index.vue', sfc(bodyB));

  clearParseCache();
  const ba = extractScriptBlocks(a);
  const bb = extractScriptBlocks(b);
  assert.match(ba[0].body, /fromA/);
  assert.match(bb[0].body, /fromB/, 'repo B is not served repo A\'s blocks');
  assert.notEqual(ba, bb, 'each file gets its own block list');

  fs.writeFileSync(a, sfc('export default { methods: { fromA2 () {} } }'));
  assert.match(extractScriptBlocks(a)[0].body, /fromA2/, 'repo A sees its own rewrite');
  assert.match(extractScriptBlocks(b)[0].body, /fromB/, 'repo B is untouched');
});

testWithFixtures('clearParseCache() really empties both caches', () => {
  extractVueCalls(vue('components/payment/index.vue'));
  assert.ok(cacheSizes().ast > 0 && cacheSizes().blocks > 0);
  clearParseCache();
  const s = cacheSizes();
  assert.equal(s.ast, 0);
  assert.equal(s.blocks, 0);
  assert.equal(s.bytes, 0);
});
