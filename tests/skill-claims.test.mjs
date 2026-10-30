/**
 * skill-claims.test.mjs — the playbook is documentation, and documentation rots.
 *
 * These tests do not re-read the prose looking for meaning; they check the shapes
 * of drift that were actually found in v1.7.0:
 *
 *   1. a claim that a script/CLI/flag/resource exists when it does not
 *   2. a served MCP surface the always-on page (or its table) never mentions
 *   3. an internal contradiction (a "three pitfalls" heading over five items,
 *      a frontmatter version that disagrees with its own changelog)
 *
 * The audit script is the implementation; this file proves the audit still bites by
 * breaking a **copy** of the skill and restoring nothing — `--skill` exists so that
 * `node --test` (which runs files in parallel processes) can never race another
 * test through an in-place edit of a tracked file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const AUDIT = path.join(ROOT, 'scripts', 'audit-skill.mjs');
const SKILL = path.join(ROOT, 'skill', 'archnav');

const audit = (skillDir = null) => {
  const args = [AUDIT, ...(skillDir ? ['--skill', skillDir] : [])];
  try {
    return { code: 0, out: execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
};

/** A throwaway copy of skill/archnav that a test may break at will. */
function scratchSkill(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-skill-copy-'));
  fs.cpSync(SKILL, dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

test('the skill as committed passes its own audit', () => {
  const r = audit();
  assert.equal(r.code, 0, `audit failed:\n${r.out}`);
  assert.match(r.out, /0 error\(s\)/);
});

test('the audit catches a heading that contradicts its list', (t) => {
  const dir = scratchSkill(t);
  const file = path.join(dir, 'SKILL.md');
  // rewritten generically: hard-coding the current count ("七个") made this test stop
  // biting the moment the playbook was thinned to five pitfalls.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^## .*坑.*$/m, '## 一个必须先知道的坑'));
  const r = audit(dir);
  assert.equal(r.code, 1, 'a one-item heading over a multi-item list must fail the audit');
  assert.match(r.out, /heading count contradicts the list/);
});

test('the audit catches a resource dropped from the playbook table', (t) => {
  const dir = scratchSkill(t);
  const file = path.join(dir, 'SKILL.md');
  // drop the table row *and* the prose mention: one stray mention would be a
  // passing reference, and the audit asks for a row an agent would actually see.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
    .replaceAll('archnav://skill/anchor-review', 'the ANCHOR document'));
  const r = audit(dir);
  assert.equal(r.code, 1, 'a served-but-undocumented resource must fail the audit');
  assert.match(r.out, /served MCP resource is not in the playbook table/);
});

test('the audit catches a documented flag the script never reads', (t) => {
  const dir = scratchSkill(t);
  const file = path.join(dir, 'SKILL.md');
  // Append the bad claim instead of rewriting an existing sentence: replacing prose
  // makes the test stop biting the moment the page is rewritten (happened twice).
  fs.appendFileSync(file, '\n`node scripts/review-rules.mjs --pretend-flag .`\n');
  const r = audit(dir);
  assert.equal(r.code, 1, 'a flag nobody implements must fail the audit');
  assert.match(r.out, /documents a flag the script never reads/);
});

test('the audit catches a reference to a script that does not exist', (t) => {
  const dir = scratchSkill(t);
  const file = path.join(dir, 'SKILL.md');
  fs.appendFileSync(file, '\n见 `scripts/checklist_from_rules.mjs`。\n');
  const r = audit(dir);
  assert.equal(r.code, 1, 'a path that does not exist must fail the audit');
  assert.match(r.out, /references a path that does not exist/);
});

test('the audit catches a CLI command the binary does not have', (t) => {
  const dir = scratchSkill(t);
  const file = path.join(dir, 'SKILL.md');
  fs.appendFileSync(file, '\n`archnav version-info <dir>`\n');
  const r = audit(dir);
  assert.equal(r.code, 1, 'an invented subcommand must fail the audit');
  assert.match(r.out, /names a CLI command the CLI does not have/);
});

test('the audit catches a prompt whose file is missing', (t) => {
  const dir = scratchSkill(t);
  fs.rmSync(path.join(dir, 'prompts', 'deep.md'));
  const r = audit(dir);
  assert.equal(r.code, 1, 'a prompt pointing at a deleted file must fail the audit');
  assert.match(r.out, /prompt declares a file that does not exist/);
});

test('the audit catches advice the tool has outgrown', (t) => {
  const dir = scratchSkill(t);
  const file = path.join(dir, 'prompts', 'review-diff.md');
  fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\n先 \`git add -N .\`，否则新文件不进 diff。\n`);
  const r = audit(dir);
  assert.equal(r.code, 1, '`git add -N .` as a workflow step contradicts `changes`');
  assert.match(r.out, /repeats advice the tool has outgrown/);
});

test('auditing a copy never touches the tracked skill', () => {
  const before = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
  audit(SKILL);
  assert.equal(fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8'), before);
});

// ---- deployment drift: sync-skill must name what the repo cannot audit ------
const SYNC = path.join(ROOT, 'scripts', 'sync-skill.mjs');
const sync = (dir, ...flags) => {
  const r = spawnSync(process.execPath, [SYNC, ...flags, '--out', dir], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` };
};

test('sync-skill --check reports files that live only in the installed skill', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-sync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.equal(sync(dir).code, 0, 'first sync should succeed');
  fs.writeFileSync(path.join(dir, 'references', 'stale-local-doc.md'), '# 本地手写、仓库里没有\n');

  const warned = sync(dir, '--check');
  assert.equal(warned.code, 0, 'an orphan is a warning by default, not a failure');
  assert.match(warned.out, /not in skill\/archnav/);
  assert.match(warned.out, /orphan: references\/stale-local-doc\.md/);

  const strict = sync(dir, '--check', '--strict');
  assert.equal(strict.code, 1, '--strict turns the warning into a failure');
});
