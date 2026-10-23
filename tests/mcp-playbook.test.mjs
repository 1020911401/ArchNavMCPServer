/**
 * The MCP playbook layer: prompts (workflows) and resources (long references) served
 * from `skill/archnav/`. Tested by importing the module directly — the MCP tests spawn
 * the server as a child process, so the graph has no import edge to these functions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listResources, readResource, listPrompts, getPrompt, SKILL_DIR } from '../src/mcp-playbook.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('prompts: the four workflows exist and each has a readable body', () => {
  const prompts = listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ['archnav_deep', 'archnav_review_diff', 'archnav_self_review', 'archnav_test_select']);
  for (const p of prompts) {
    const got = getPrompt(p.name);
    assert.ok(!got.error, `${p.name}: ${got.error}`);
    const text = got.messages[0].content.text;
    assert.ok(text.length > 200, `${p.name} body is too short to be a workflow`);
    assert.equal(got.messages[0].role, 'user');
  }
});

test('prompts: the optional dir argument is appended, and an unknown name is an error', () => {
  const got = getPrompt('archnav_test_select', { dir: 'D:/code/api' });
  assert.match(got.messages[0].content.text, /目标仓：`D:\/code\/api`/);
  const plain = getPrompt('archnav_test_select');
  assert.doesNotMatch(plain.messages[0].content.text, /目标仓/);
  assert.match(getPrompt('nope').error, /unknown prompt/);
});

test('resources: every uri maps to a file that exists and is served whole', () => {
  const resources = listResources();
  assert.ok(resources.length >= 6);
  for (const r of resources) {
    assert.equal(r.mimeType, 'text/markdown');
    const got = readResource(r.uri);
    assert.ok(!got.error, `${r.uri}: ${got.error}`);
    const text = got.contents[0].text;
    assert.equal(got.contents[0].uri, r.uri);
    assert.ok(text.length > 500, `${r.uri} looks truncated (${text.length} chars)`);
  }
  assert.match(readResource('archnav://nope').error, /unknown resource/);
});

test('the thin playbook is installable as a Hermes skill (frontmatter + trigger)', () => {
  const text = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  assert.match(text, /^---\r?\nname: archnav/);
  assert.match(text, /\ndescription: Use when /);
  assert.match(text, /\nversion: \d+\.\d+\.\d+/);
  assert.ok(text.length < 4000, 'the always-loaded part must stay small — depth lives in references/');
});

test('the repo copy is self-contained: skill dir sits inside the repo', () => {
  assert.equal(path.relative(root, SKILL_DIR).replace(/\\/g, '/'), 'skill/archnav');
});
