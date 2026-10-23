/**
 * Version info of the *target* repository — the question "which version of this
 * code am I reviewing?" answered from git, the manifests, and the index.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectVersionInfo, readGitInfo, readManifests } from '../src/version-info.js';

const git = (dir, args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim();

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-version-'));
  git(dir, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-app', version: '2.3.4' }), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.js'), 'export const a = 1;\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'feat: first commit']);
  git(dir, ['tag', 'v2.3.4']);
  return dir;
}

test('git identity: commit, short sha, branch, exact tag, clean worktree', () => {
  const dir = makeRepo();
  try {
    const g = readGitInfo(dir);
    assert.equal(g.branch, 'main');
    assert.equal(g.exact_tag, 'v2.3.4', 'HEAD is the tagged commit');
    assert.equal(g.tag, 'v2.3.4');
    assert.equal(g.dirty, false);
    assert.equal(g.commits, 1);
    assert.match(g.head, /^[0-9a-f]{40}$/);
    assert.equal(g.short.length, 7);
    assert.match(g.subject, /first commit/);
    assert.match(g.date, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dirty worktree is reported with its file count, and a newer commit moves the tag back', () => {
  const dir = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'index.js'), 'export const a = 2;\n', 'utf8');
    const dirty = readGitInfo(dir);
    assert.equal(dirty.dirty, true);
    assert.equal(dirty.dirty_files, 1);

    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'fix: second']);
    const after = readGitInfo(dir);
    assert.equal(after.dirty, false);
    assert.equal(after.exact_tag, null, 'HEAD is no longer the tagged commit');
    assert.equal(after.tag, 'v2.3.4', 'the nearest tag is still reported');
    assert.match(after.describe, /^v2\.3\.4-1-g[0-9a-f]+$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('manifests: package.json / composer.json / pyproject.toml / go.mod', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-manifests-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'web', version: '1.2.0' }));
    fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({ name: 'acme/api', version: '3.1.0' }));
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "svc"\nversion = "0.4.2"\n');
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/tool\n\ngo 1.22\n');
    const m = readManifests(dir);
    assert.deepEqual(m.package_json, { name: 'web', version: '1.2.0' });
    assert.deepEqual(m.composer_json, { name: 'acme/api', version: '3.1.0' });
    assert.deepEqual(m.pyproject, { name: 'svc', version: '0.4.2' });
    assert.equal(m.go_mod.name, 'example.com/tool');
    assert.equal(m.go_mod.go, '1.22');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-git directory degrades to nulls instead of throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-nogit-'));
  try {
    assert.equal(readGitInfo(dir), null);
    const info = await collectVersionInfo(dir, { toolVersion: '0.0.1' });
    assert.equal(info.repo.is_git, false);
    assert.equal(info.repo.head, undefined);
    assert.equal(info.index, null, 'no index yet');
    assert.equal(info.tool.version, '0.0.1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the index is compared against HEAD instead of being presented as "the version"', async () => {
  const dir = makeRepo();
  try {
    fs.mkdirSync(path.join(dir, '.archnav'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.archnav', 'index.json'), JSON.stringify({ symbols: [], fileHashes: {} }), 'utf8');
    const head = git(dir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(dir, '.archnav', 'commit'), head + '\n', 'utf8');
    const info = await collectVersionInfo(dir);
    assert.equal(info.repo.is_git, true);
    assert.ok(info.index, 'an index on disk is reported');
    assert.equal(info.index.matches_head, true, 'indexed commit == HEAD');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
