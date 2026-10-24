/**
 * tests/changes.test.mjs — change-impact analysis (`archnav changes`).
 *
 * Builds a throwaway git repo, indexes it, edits one line and asserts the diff
 * is mapped to the right symbol plus its dependants. Also covers the non-git
 * drift fallback and the loud-failure paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { archNav } from '../src/navigation.js';
import { analyze, saveIndex } from '../src/analyzer.js';

/** `analyze()` only returns the graph — the CLI saves it in a separate step. */
async function indexRepo(root) {
  const result = await analyze(root);
  saveIndex(root, result._raw || result);
}

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };

function tmpRepo(prefix) {
  const base = process.env.TMPDIR || os.tmpdir();
  return fs.mkdtempSync(path.join(base, prefix));
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Minimal Laravel-shaped project: a controller method, a caller, a route. */
function scaffold(root, { git: useGit }) {
  write(root, 'app/Http/Controllers/Controller.php', [
    '<?php',
    'namespace App\\Http\\Controllers;',
    'class Controller',
    '{',
    '    public function departments()',
    '    {',
    "        $value = Cache::remember('departments', 60, function () {",
    "            return DB::table('departments')->get();",
    '        });',
    '        return $value;',
    '    }',
    '}',
    '',
  ].join('\n'));
  write(root, 'app/Http/Controllers/UsersController.php', [
    '<?php',
    'namespace App\\Http\\Controllers;',
    'class UsersController extends Controller',
    '{',
    '    public function index()',
    '    {',
    '        $rows = $this->departments();',
    '        return $rows;',
    '    }',
    '}',
    '',
  ].join('\n'));
  write(root, 'routes/web.php', [
    '<?php',
    "Route::get('/users', 'UsersController@index');",
    '',
  ].join('\n'));

  if (useGit) {
    git(root, ['init', '-q', '.']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'test']);
    // The index directory must be ignored, otherwise `git add -A` stages
    // .archnav/index.json and every scope reports extra changed files.
    write(root, '.gitignore', '.archnav/\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'baseline']);
  }
}

test('changes: git diff line -> symbol -> direct callers + route layer', async () => {
  const root = tmpRepo('archnav-changes-git-');
  scaffold(root, { git: true });
  await indexRepo(root);

  // Edit exactly one line inside departments().
  const f = path.join(root, 'app/Http/Controllers/Controller.php');
  const before = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, before.replace("'departments', 60", "'departments_v2', 60"));
  assert.notEqual(fs.readFileSync(f, 'utf8'), before, 'the edit must actually change the file');

  const r = await archNav.changes(root, { scope: 'unstaged' });
  assert.equal(r.type, 'changes');
  assert.equal(r.via, 'git', 'a git repo must use the diff path');

  const changedNames = r.changed_symbols.map((s) => s.symbol);
  assert.ok(changedNames.includes('departments'), `departments must be in the changed set, got ${changedNames}`);
  // The untouched sibling method must not be reported as changed.
  assert.ok(!changedNames.includes('index'), 'a method outside the changed lines must not be reported');

  const directFiles = r.direct_impact.map((x) => x.file.replace(/\\/g, '/'));
  assert.ok(
    directFiles.some((x) => x.endsWith('UsersController.php')),
    `the caller must be reported as direct impact, got ${JSON.stringify(directFiles)}`
  );
  // Route layer: the route dispatching to the caller is a depth-2 dependant.
  assert.ok(r.summary.affected_routes >= 1, 'the route pointing at the caller must be reported');
  assert.ok(r.affected_routes.every((x) => x.file.endsWith('web.php')));
  assert.equal(r.unmapped_files.length, 0, `nothing should be unmapped, got ${JSON.stringify(r.unmapped_files)}`);
  assert.equal(r.summary.changed_files, 1);
});

test('changes: no modification -> empty summary, still via git', async () => {
  const root = tmpRepo('archnav-changes-clean-');
  scaffold(root, { git: true });
  await indexRepo(root);

  const r = await archNav.changes(root, { scope: 'unstaged' });
  assert.equal(r.via, 'git');
  assert.equal(r.summary.changed_files, 0);
  assert.equal(r.summary.changed_symbols, 0);
  assert.equal(r.impacted.length, 0);
});

test('changes: staged scope sees staged edits, unstaged scope does not', async () => {
  const root = tmpRepo('archnav-changes-staged-');
  scaffold(root, { git: true });
  await indexRepo(root);

  const f = path.join(root, 'app/Http/Controllers/Controller.php');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace("'departments', 60", "'departments_v3', 60"));

  const unstaged = await archNav.changes(root, { scope: 'unstaged' });
  assert.equal(unstaged.summary.changed_files, 1, 'the edit is unstaged first');

  git(root, ['add', '-A']);
  const staged = await archNav.changes(root, { scope: 'staged' });
  assert.equal(staged.summary.changed_files, 1, 'after staging, the staged scope must see it');
  const afterUnstaged = await archNav.changes(root, { scope: 'unstaged' });
  assert.equal(afterUnstaged.summary.changed_files, 0, 'staging removes it from unstaged');
});

test('changes: non-git directory falls back to content drift and says so', async () => {
  const root = tmpRepo('archnav-changes-nogit-');
  scaffold(root, { git: false });
  await indexRepo(root);

  const f = path.join(root, 'app/Http/Controllers/Controller.php');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace("'departments', 60", "'departments_v4', 60"));

  const r = await archNav.changes(root, { scope: 'unstaged' });
  assert.equal(r.via, 'drift', 'without git the drift path must be used');
  assert.ok(r.note && /git/i.test(r.note), 'the fallback must be disclosed in a note');
  const names = r.changed_symbols.map((s) => s.symbol);
  assert.ok(names.includes('departments'), `drift must still map the symbol, got ${names}`);
});

test('changes: unknown scope and compare-without-base fail loudly', async () => {
  const root = tmpRepo('archnav-changes-bad-');
  scaffold(root, { git: true });
  await indexRepo(root);

  const bad = await archNav.changes(root, { scope: 'working-tree' });
  assert.ok(bad.error && /Unknown scope/i.test(bad.error), `expected a loud error, got ${JSON.stringify(bad)}`);
  assert.equal(bad.via, undefined, 'an invalid scope must NOT silently fall back to drift');

  const noBase = await archNav.changes(root, { scope: 'compare' });
  assert.ok(noBase.error && /base/i.test(noBase.error), `expected a loud error, got ${JSON.stringify(noBase)}`);
});

test('changes: scope=corpus returns every indexed code file and no impact', async () => {
  const root = tmpRepo('archnav-changes-corpus-');
  scaffold(root, { git: true });
  // A doc file the index records but no rule should classify as "unmapped change".
  write(root, 'docs/notes.md', '# notes\n');
  await indexRepo(root);

  const r = await archNav.changes(root, { scope: 'corpus' });
  assert.equal(r.error, undefined);
  assert.equal(r.via, 'corpus');
  const files = r.changed_files.map((f) => f.file);
  assert.ok(files.includes('app/Http/Controllers/Controller.php'), `expected the controller, got ${files}`);
  assert.ok(files.every((f) => !/\.md$/.test(f)), 'corpus carries code files only');
  assert.ok(r.changed_files.every((f) => f.ranges === null), 'a corpus file is whole-file, not a hunk');
  assert.deepEqual(r.changed_symbols, [], 'corpus must not claim symbols changed');
  assert.deepEqual(r.impacted, [], 'corpus must not invent an impact set');
  assert.equal(r.summary.changed_files, r.changed_files.length);
});
