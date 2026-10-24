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

test('a second file in the same directory still gets its tsconfig paths', () => {
  // The old cache returned `{paths: {}}` for a repeat lookup of the same ancestor chain, so
  // only the first file per directory resolved; every later one silently fell back to the
  // repo root (measured on a real monorepo: 1 of 2 files in `api/modules/`).
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-memo-'));
  fs.mkdirSync(path.join(d, 'src', 'api', 'modules'), { recursive: true });
  fs.mkdirSync(path.join(d, 'src', 'utils'), { recursive: true });
  fs.writeFileSync(path.join(d, 'src', 'utils', 'request.ts'), '// req');
  fs.writeFileSync(path.join(d, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
  }));
  fs.writeFileSync(path.join(d, 'package.json'), '{}');
  const from = (n) => path.join(d, 'src', 'api', 'modules', n);
  for (const name of ['a.ts', 'b.ts', 'c.ts']) {
    assert.equal(resolveAlias('@/utils/request', { repoDir: d, fromFile: from(name) }), 'src/utils/request.ts', name);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('monorepo: @/ belongs to the importing package, not the repo root', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-mono-'));
  for (const pkg of ['admin', 'merchant']) {
    fs.mkdirSync(path.join(d, pkg, 'src', 'utils'), { recursive: true });
    fs.mkdirSync(path.join(d, pkg, 'src', 'pages'), { recursive: true });
    fs.writeFileSync(path.join(d, pkg, 'src', 'utils', 'request.ts'), `// ${pkg}`);
    fs.writeFileSync(path.join(d, pkg, 'package.json'), '{}');
    fs.writeFileSync(path.join(d, pkg, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
    }));
  }
  // no config-based hit for `@shared/...`-style peers: the built-in @/ fallback must still
  // pick the importing package's own src before the repo root
  fs.rmSync(path.join(d, 'merchant', 'tsconfig.json'));
  assert.equal(
    resolveAlias('@/utils/request', { repoDir: d, fromFile: path.join(d, 'admin', 'src', 'pages', 'a.vue') }),
    'admin/src/utils/request.ts',
  );
  assert.equal(
    resolveAlias('@/utils/request', { repoDir: d, fromFile: path.join(d, 'merchant', 'src', 'pages', 'b.vue') }),
    'merchant/src/utils/request.ts',
  );
  fs.rmSync(d, { recursive: true, force: true });
});
