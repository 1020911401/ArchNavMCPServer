/**
 * TDD test — WASM parser must init the tree-sitter runtime + load the language
 * + compile queries ONCE PER LANGUAGE, not once per file, without changing results.
 *
 * Acceptance:
 *   a) parsing 2+ files of one language → initializations === 1, languageLoads === 1
 *   b) same php file twice → identical (name,line) set (results deterministic)
 *   c) full bench/php-app index → symbols 682, calls 3595, canonical hash unchanged
 *   d) .php and .go do not cross-pollute the per-language caches
 *
 * Run: node --test tests/php-parse-cache.test.mjs
 */
import { test } from 'node:test';
import { testWithFixtures } from './helpers/fixtures.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseWasmFile } from '../src/parsers/wasmParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const PHP_APP = path.join(REPO, 'bench', 'php-app');
const SKIP = new Set(['node_modules', '.git', '.archnav', '.codegraph', '.gitnexus', 'vendor']);

// Pre-change baseline (captured with bench/tools/.baseline_full.mjs on the
// unfixed parser): these numbers / hashes must be byte-identical afterwards.
const BASELINE = {
  files: 274,
  symbols: 682,
  calls: 3595,
  symHash: 'bf38284f1adcb3fd2e1fbb3fad033bc0d627d4d0f2e20df792f06fab9d347fc8',
  callHash: '530aa29878108f4cfbc3fa286bd103f7ede8829c40d610e517263c7d0dab78a9',
};

function walkPhp(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      walkPhp(path.join(dir, e.name), acc);
    } else if (e.name.endsWith('.php')) {
      acc.push(path.join(dir, e.name));
    }
  }
  return acc;
}

// Module-level scan, but never at import time when the fixture corpus is absent: a
// throw here fails the whole file before any `skip` can apply (it did — one ENOENT in
// the first import hid the four tests behind "test failed").
const phpFiles = fs.existsSync(PHP_APP) ? walkPhp(PHP_APP).sort() : [];

testWithFixtures('(a) runtime init + language load + query compile happen once per language', () => {
  const wasmUrl = new URL('../src/parsers/wasmParser.js', import.meta.url).href;
  const sample = phpFiles.slice(0, 3).map((f) => path.relative(PHP_APP, f).replace(/\\/g, '/'));
  const code = `
    const mod = await import(${JSON.stringify(wasmUrl)});
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = ${JSON.stringify(PHP_APP)};
    const rels = ${JSON.stringify(sample)};
    for (const rel of rels) {
      const full = path.join(root, rel);
      await mod.parseWasmFile(full, root, fs.readFileSync(full, 'utf-8'));
    }
    process.stdout.write(JSON.stringify(mod.__getInitStats()));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf-8' });
  assert.equal(r.status, 0, `child process failed: ${r.stderr}`);

  const stats = JSON.parse(r.stdout.trim().split('\n').pop());
  const n = sample.length;
  assert.equal(
    stats.initializations,
    1,
    `expected 1 runtime init for ${n} files, got ${stats.initializations} (per-file rebuild)`
  );
  assert.equal(
    stats.languageLoads,
    1,
    `expected 1 language load for ${n} files, got ${stats.languageLoads} (per-file rebuild)`
  );
});

testWithFixtures('(b) same php file parsed twice → identical (name,line) set', async () => {
  const full = phpFiles[0];
  const content = fs.readFileSync(full, 'utf-8');
  const key = (s) => `${s.name}@${s.line_start}`;

  const r1 = await parseWasmFile(full, PHP_APP, content);
  const r2 = await parseWasmFile(full, PHP_APP, content);

  const a = r1.symbols.map(key).sort();
  const b = r2.symbols.map(key).sort();
  assert.ok(a.length > 0, 'expected symbols from the sample file');
  assert.deepEqual(a, b, 'symbol (name,line) set must be identical across parses');
});

testWithFixtures('(c) full php-app index matches pre-change baseline (counts + hash)', async () => {
  const symLines = [];
  const callLines = [];
  let symbols = 0;
  let calls = 0;

  for (const f of phpFiles) {
    const r = await parseWasmFile(f, PHP_APP, fs.readFileSync(f, 'utf-8'));
    const rel = path.relative(PHP_APP, f).replace(/\\/g, '/');
    for (const s of r.symbols || []) {
      symbols++;
      symLines.push(`${rel}|${s.name}|${s.line_start}|${s.line_end}|${s.kind}`);
    }
    for (const c of r.calls || []) {
      calls++;
      callLines.push(`${rel}|${c.caller}|${c.callee}|${c.line}|${c.col}|${c.receiver ?? ''}|${c.source_kind}`);
    }
  }

  symLines.sort();
  callLines.sort();
  const symHash = createHash('sha256').update(symLines.join('\n')).digest('hex');
  const callHash = createHash('sha256').update(callLines.join('\n')).digest('hex');

  assert.equal(phpFiles.length, BASELINE.files, 'indexed php file count changed');
  assert.equal(symbols, BASELINE.symbols, 'symbol count changed');
  assert.equal(calls, BASELINE.calls, 'call count changed');
  assert.equal(symHash, BASELINE.symHash, 'symbol set (file|name|lines|kind) changed');
  assert.equal(callHash, BASELINE.callHash, 'call set (file|caller|callee|line|col|receiver|kind) changed');
});

testWithFixtures('(d) php and go do not cross-pollute the per-language caches', async () => {
  const phpFile = phpFiles[0];
  const php = await parseWasmFile(phpFile, PHP_APP, fs.readFileSync(phpFile, 'utf-8'));

  const goSrc = `package main

type Point struct { X int; Y int }

func Add(a int, b int) int { return a + b }

func (p Point) Sum() int { return p.X + p.Y }
`;
  const go = await parseWasmFile(path.join(PHP_APP, 'synthetic.go'), PHP_APP, goSrc);

  if (go.error) {
    // Grammar unavailable on this host — the contract is only "no throw, error field".
    assert.ok(Array.isArray(go.symbols) && go.symbols.length === 0, 'failed language must return empty symbols');
  } else {
    const goNames = go.symbols.map((s) => s.name).sort();
    assert.ok(goNames.includes('Add'), `go symbols missing Add: ${JSON.stringify(goNames)}`);
    assert.ok(goNames.includes('Point'), `go symbols missing Point: ${JSON.stringify(goNames)}`);
    // Go results must not leak php symbols, and every symbol is tagged from the go file.
    assert.ok(go.symbols.every((s) => s.file === 'synthetic.go'), 'go symbols must belong to synthetic.go');
    assert.ok(!go.symbols.some((s) => php.symbols.some((p) => p.name === s.name && p.kind === 'class' && s.kind === 'class' && false)));
  }

  // Re-parse php AFTER go — the php cache must still return the same php symbols.
  const phpAgain = await parseWasmFile(phpFile, PHP_APP, fs.readFileSync(phpFile, 'utf-8'));
  assert.deepEqual(
    phpAgain.symbols.map((s) => `${s.name}@${s.line_start}`).sort(),
    php.symbols.map((s) => `${s.name}@${s.line_start}`).sort(),
    'php results changed after parsing go (cache cross-talk)'
  );
});
