/**
 * `.vue` symbol extraction quality gate — src/parsers/vueSymbols.js
 *
 * The analyzer's file walk used to skip `.vue` entirely, so a uni-app project's
 * 269 SFCs contributed **0 symbols**; routing them through the generic acorn
 * path instead yields `✖` garbage from the `<template>` and still misses every
 * option-API method. These assertions pin the real behaviour on the corpus.
 *
 * Run: node --test tests/vue-symbols.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseVueFile } from '../src/parsers/vueSymbols.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VUE = path.resolve(here, '..', 'bench', 'vue-app');
const parse = (rel) => parseVueFile(path.join(VUE, rel), VUE);
const names = (r) => r.symbols.map((s) => s.name);

test('components/payment/index.vue yields its real option-API methods (goPay @121) and no noise', () => {
  const r = parse('components/payment/index.vue');
  const byName = new Map(r.symbols.map((s) => [s.name, s]));

  for (const name of ['goPay', 'payType', 'formpost', 'close']) {
    assert.ok(byName.has(name), `missing method ${name} (got ${names(r).join(', ')})`);
  }
  assert.equal(byName.get('goPay').line_start, 121);
  assert.ok(byName.get('goPay').line_end > byName.get('goPay').line_start);

  // option containers are recognised …
  assert.equal(byName.get('props').kind, 'props');
  assert.equal(byName.get('data').kind, 'data');

  // … and there is no template/acorn garbage in the symbol list
  assert.ok(!names(r).some((n) => /✖|^\s*$|<|>/.test(n)), `garbage symbol in ${JSON.stringify(names(r))}`);
  for (const s of r.symbols) {
    assert.ok(Number.isInteger(s.line_start) && s.line_start > 0, `${s.name}: line_start`);
    assert.ok(s.line_end >= s.line_start, `${s.name}: line range`);
    assert.equal(typeof s.kind, 'string');
  }
});

test('pages/goods/order_details/index.vue lists its hooks and methods with real line numbers', () => {
  const r = parse('pages/goods/order_details/index.vue');
  const byName = new Map(r.symbols.map((s) => [s.name, s]));

  // lifecycle hooks (options API) with the lines seen in the file
  assert.equal(byName.get('onLoad')?.kind, 'hook');
  assert.equal(byName.get('onLoad').line_start, 705);
  assert.equal(byName.get('onShow')?.kind, 'hook');
  assert.equal(byName.get('onShow').line_start, 715);

  // a few `methods:` entries, all inside the methods block (line > 797)
  for (const name of ['setOpenShare', 'defaultTake', 'cancelOrder']) {
    const s = byName.get(name);
    assert.ok(s, `missing method ${name}`);
    assert.equal(s.kind, 'method');
    assert.ok(s.line_start > 797, `${name} must be located inside methods{} (got ${s.line_start})`);
  }
  assert.equal(byName.get('defaultTake').line_start, 1309);

  assert.ok(!names(r).some((n) => /✖/.test(n)));
});

test('every .vue in the corpus parses without a single garbage symbol', () => {
  const walk = (dir, acc = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (e.name.endsWith('.vue')) acc.push(p);
    }
    return acc;
  };
  const files = walk(VUE);
  assert.ok(files.length > 100, `expected a real corpus (got ${files.length} .vue)`);

  let total = 0;
  let empty = 0;
  for (const f of files) {
    const r = parseVueFile(f, VUE);
    total += r.symbols.length;
    if (r.symbols.length === 0) empty++;
    for (const s of r.symbols) {
      assert.ok(s.name && !/✖/.test(s.name), `${path.relative(VUE, f)}: bad symbol name ${JSON.stringify(s.name)}`);
      assert.ok(s.line_start >= 1, `${path.relative(VUE, f)}:${s.name} line_start`);
    }
  }
  assert.ok(total > 500, `expected many symbols from .vue files (got ${total})`);
  assert.ok(empty < files.length / 2, `too many .vue files yielded nothing (${empty}/${files.length})`);
});
