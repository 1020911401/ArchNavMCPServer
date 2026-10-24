/**
 * Index contract tests: the on-disk index is the only thing every query depends on, so
 * its two failure modes are pinned here —
 *   1. a half-written file (crash / Ctrl-C mid-analyze) must never be published, and
 *   2. an index from an older shape must be refused loudly, not read as if current.
 * Both shipped broken: `saveIndex` did a direct 1.8 MB writeFileSync and there was no
 * version field at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getIndex, saveIndex, INDEX_SCHEMA_VERSION } from '../src/analyzer.js';

const tmpRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-index-'));
  fs.mkdirSync(path.join(dir, '.archnav'), { recursive: true });
  return dir;
};

test('saveIndex stamps the schema version and getIndex reads it back', () => {
  const dir = tmpRepo();
  saveIndex(dir, { symbols: [{ name: 'a', file: 'a.php' }] });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, '.archnav', 'index.json'), 'utf8'));
  assert.equal(raw.schemaVersion, INDEX_SCHEMA_VERSION, 'the file on disk carries its generation');
  const loaded = getIndex(dir);
  assert.equal(loaded.schemaVersion, INDEX_SCHEMA_VERSION);
  assert.equal(loaded.symbols.length, 1);
});

test('saveIndex publishes atomically — no temp file survives a successful write', () => {
  const dir = tmpRepo();
  saveIndex(dir, { symbols: [] });
  const leftovers = fs.readdirSync(path.join(dir, '.archnav')).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'the tmp file must be renamed away, not abandoned');
});

test('getIndex refuses an index written by a newer build (the shape it cannot know)', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, '.archnav', 'index.json'),
    JSON.stringify({ schemaVersion: INDEX_SCHEMA_VERSION + 1, symbols: [{ name: 'future' }] }));
  const messages = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { messages.push(String(chunk)); return write.call(process.stderr, chunk, ...rest); };
  let loaded;
  try {
    loaded = getIndex(dir);
  } finally {
    process.stderr.write = write;
  }
  assert.equal(loaded, null, 'a newer generation must not be returned as data');
  assert.match(messages.join(''), /not supported/, 'the refusal must name the generation gap');
  assert.match(messages.join(''), /archnav analyze \./, 'and how to fix it');
});

test('getIndex still reads a legacy index (same shape, no stamp) — v1 stays supported', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, '.archnav', 'index.json'), JSON.stringify({ symbols: [{ name: 'legacy' }] }));
  const loaded = getIndex(dir);
  assert.equal(loaded?.symbols?.[0]?.name, 'legacy', 'retiring v1 is a deliberate, separate change');
});

test('getIndex still tolerates a missing or truncated file (returns null, no throw)', () => {
  const dir = tmpRepo();
  assert.equal(getIndex(dir), null, 'missing index');
  fs.writeFileSync(path.join(dir, '.archnav', 'index.json'), '{"symbols": [');
  assert.equal(getIndex(dir), null, 'truncated index must not throw at the reader');
});
