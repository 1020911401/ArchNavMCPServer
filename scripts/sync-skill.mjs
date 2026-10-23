#!/usr/bin/env node
/**
 * Sync the playbook from this repo into the local Hermes skills tree.
 *
 * `skill/archnav/` is the single source of truth: the MCP server serves it as
 * resources, and this script installs the same files where Hermes looks for skills.
 * Without it there are two copies that drift — one manual sync already sliced a
 * SKILL.md in half (stale offsets after the first replace).
 *
 *   node scripts/sync-skill.mjs            # repo -> hermes skills dir
 *   node scripts/sync-skill.mjs --check    # exit 1 when they differ, write nothing
 *   node scripts/sync-skill.mjs --out DIR  # explicit destination
 *
 * The destination must look like a skills tree (…/skills/<category>/<name>/). The
 * category is taken from the current install when present, `software-development`
 * otherwise.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'skill', 'archnav');

const args = process.argv.slice(2);
const check = args.includes('--check');
const outFlag = args.indexOf('--out');
const NAME = 'archnav';

function defaultDest() {
  const base = process.env.HERMES_SKILLS_DIR
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'hermes', 'skills');
  const known = fs.existsSync(path.join(base, 'software-development', NAME))
    ? path.join(base, 'software-development', NAME)
    : path.join(base, 'software-development', NAME);
  return known;
}

const DEST = outFlag !== -1 ? path.resolve(args[outFlag + 1]) : defaultDest();

function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

const files = walk(SRC);
const diff = [];
for (const rel of files) {
  const srcText = fs.readFileSync(path.join(SRC, rel), 'utf8');
  let destText = null;
  try { destText = fs.readFileSync(path.join(DEST, rel), 'utf8'); } catch { /* missing */ }
  if (destText === null) diff.push(`missing: ${rel}`);
  else if (destText !== srcText) diff.push(`differs: ${rel}`);
}

if (check) {
  if (diff.length) {
    console.error(`❌ ${DEST} is out of sync with skill/archnav (${diff.length} file(s))`);
    for (const d of diff) console.error(`   ${d}`);
    console.error('   run: node scripts/sync-skill.mjs');
    process.exit(1);
  }
  console.log(`✅ ${DEST} matches skill/archnav (${files.length} files)`);
  process.exit(0);
}

for (const rel of files) {
  const target = path.join(DEST, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(SRC, rel), target);
}
console.log(`✅ synced ${files.length} file(s) -> ${DEST}`);
if (diff.length) for (const d of diff) console.log(`   ${d}`);
