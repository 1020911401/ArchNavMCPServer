/**
 * Tests for src/resolver/alias.js — module specifier → real, existing path.
 *
 * Run: node --test tests/resolver/
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveAlias } from '../../src/resolver/alias.js';

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
  fs.mkdirSync(path.join(dir, 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'x', 'y.js'), '// y');
  fs.mkdirSync(path.join(dir, 'mod', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod', 'sub', 'index.js'), '// idx');
  fs.mkdirSync(path.join(dir, 'comp'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'comp', 'A.vue'), '<template/>');
  fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pkg', 'data.json'), '{}');
  fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'sib.js'), '// sib');
  fs.writeFileSync(path.join(dir, 'a', 'sib.mjs'), '// sib mjs');
  // custom alias via tsconfig paths
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@@/*': ['src/*'] } },
  }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'util.ts'), '// u');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('@/ with explicit extension → real path relative to the repo root', () => {
  assert.equal(resolveAlias('@/x/y.js', { repoDir: dir }), 'x/y.js');
});

test('@/ without extension → append the first existing extension', () => {
  assert.equal(resolveAlias('@/x/y', { repoDir: dir }), 'x/y.js');
});

test('@/ resolving a directory → index.js', () => {
  assert.equal(resolveAlias('@/mod/sub', { repoDir: dir }), 'mod/sub/index.js');
});

test('@/ resolves .vue and .json too', () => {
  assert.equal(resolveAlias('@/comp/A', { repoDir: dir }), 'comp/A.vue');
  assert.equal(resolveAlias('@/pkg/data', { repoDir: dir }), 'pkg/data.json');
});

test('relative ./ resolves against the importing file dir', () => {
  const from = path.join(dir, 'a', 'b.js');
  assert.equal(resolveAlias('./sib', { repoDir: dir, fromFile: from }), 'a/sib.js');
  assert.equal(resolveAlias('./sib.js', { repoDir: dir, fromFile: from }), 'a/sib.js');
});

test('relative ../ resolves', () => {
  const from = path.join(dir, 'a', 'b.js');
  assert.equal(resolveAlias('../x/y.js', { repoDir: dir, fromFile: from }), 'x/y.js');
});

test('tsconfig compilerOptions.paths is honored', () => {
  assert.equal(resolveAlias('@@/util', { repoDir: dir }), 'src/util.ts');
});

test('default @/ still points at the repo root even when a config exists', () => {
  assert.equal(resolveAlias('@/x/y', { repoDir: dir }), 'x/y.js');
});

test('missing target → null', () => {
  assert.equal(resolveAlias('@/nope/missing', { repoDir: dir }), null);
});

test('default @/ points at the repo root when there is no config at all', () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'alias2-'));
  fs.mkdirSync(path.join(d2, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(d2, 'lib', 'z.mjs'), '// z');
  assert.equal(resolveAlias('@/lib/z', { repoDir: d2 }), 'lib/z.mjs');
  fs.rmSync(d2, { recursive: true, force: true });
});
