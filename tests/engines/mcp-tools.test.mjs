/**
 * MCP server tool-surface test.
 *
 * Boots the real `src/mcp-server.js` over stdio and drives it with JSON-RPC
 * (initialize → tools/list, plus one tools/call) to prove the converged,
 * single-entry tool surface still starts and answers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(root, 'src', 'mcp-server.js');

const EXPECTED_TOOLS = [
  'archnav_analyze',
  'archnav_callers',
  'archnav_changes',
  'archnav_explore',
  'archnav_fusion_calls',
  'archnav_impact',
  'archnav_locate',
  'archnav_read',
  'archnav_review',
  'archnav_status',
  'archnav_trace',
];

const MAX_TOOLS = 12;

/** Boot the server, expose a `call()` that resolves JSON-RPC responses by id. */
function startServer() {
  const child = spawn(process.execPath, [SERVER], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let buf = '';
  let stderr = '';
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let msg;
      try { msg = JSON.parse(t); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const call = (message, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const id = message.id;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${message.method}; stderr=${stderr.slice(-300)}`));
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify(message) + '\n');
  });

  return { child, call, getStderr: () => stderr };
}

test('mcp: initialize + tools/list respond, tools are single-entry and ≤12', async () => {
  const { child, call } = startServer();
  try {
    const init = await call({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'archnav-test', version: '0' } },
    });
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.id, 1);
    assert.ok(init.result, 'initialize must return a result');
    assert.deepEqual(init.result.capabilities, {
      tools: {},
      resources: { listChanged: false },
      prompts: { listChanged: false },
    });
    assert.equal(init.result.serverInfo.name, 'archnav');

    const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = list.result.tools;

    // ≤ 12 (convergence target)
    assert.ok(tools.length <= MAX_TOOLS, `expected ≤${MAX_TOOLS} tools, got ${tools.length}`);

    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, EXPECTED_TOOLS, 'tool name set must match the converged surface');

    // every former gn_* proxy entry is gone (folded into archnav_explore)
    assert.ok(!names.some((n) => n.startsWith('gn_')), 'no raw gn_* tools should remain');

    // descriptions stay within 40 words
    for (const t of tools) {
      const words = t.description.trim().split(/\s+/).length;
      assert.ok(words <= 40, `${t.name} description is ${words} words (max 40)`);
      assert.equal(t.inputSchema?.type, 'object', `${t.name} needs an object inputSchema`);
    }

    // the GitNexus proxy ops survive as explore's `op` enum
    const explore = tools.find((t) => t.name === 'archnav_explore');
    const ops = explore.inputSchema.properties.op.enum;
    for (const op of ['query', 'context', 'cypher', 'route_map', 'rename', 'detect_changes', 'api_impact', 'tool_map', 'list_repos', 'deep_impact']) {
      assert.ok(ops.includes(op), `explore.op should still expose "${op}"`);
    }
  } finally {
    child.kill();
  }
});

test('mcp: tools/call round-trips (archnav_status needs no external engine)', async () => {
  const { child, call } = startServer();
  try {
    await call({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'archnav-test', version: '0' } },
    });
    const res = await call({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'archnav_status', arguments: { projectDir: root } },
    });
    assert.ok(Array.isArray(res.result.content), 'tools/call should return a content array');
    assert.equal(res.result.content[0].type, 'text');
    assert.ok(typeof res.result.content[0].text === 'string' && res.result.content[0].text.length > 0);
  } finally {
    child.kill();
  }
});

test('mcp: unknown tool returns an error result, not a crash', async () => {
  const { child, call } = startServer();
  try {
    await call({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'archnav-test', version: '0' } },
    });
    const res = await call({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'gn_query', arguments: { query: 'x' } },
    });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /Unknown tool/);
  } finally {
    child.kill();
  }
});

// ── playbook over MCP: prompts are workflows, resources are the long references ──
const EXPECTED_PROMPTS = ['archnav_deep', 'archnav_review_diff', 'archnav_self_review', 'archnav_test_select'];
const EXPECTED_RESOURCES = [
  'archnav://skill',
  'archnav://skill/code-review',
  'archnav://skill/self-review',
  'archnav://skill/comparison',
  'archnav://skill/kanban-review',
  'archnav://skill/anchor-review',
  'archnav://skill/playbook-full',
];

test('mcp: prompts/list and prompts/get serve the workflows from skill/archnav', async () => {
  const { child, call } = startServer();
  try {
    const list = await call({ jsonrpc: '2.0', id: 20, method: 'prompts/list' });
    const names = list.result.prompts.map((p) => p.name).sort();
    assert.deepEqual(names, EXPECTED_PROMPTS, 'prompt set is the four workflows');
    for (const p of list.result.prompts) {
      assert.ok(p.description && p.description.length > 10, `${p.name} needs a description`);
      assert.ok(Array.isArray(p.arguments), `${p.name} exposes its optional dir argument`);
    }

    const get = await call({
      jsonrpc: '2.0', id: 21, method: 'prompts/get',
      params: { name: 'archnav_review_diff', arguments: { dir: 'C:/work/project' } },
    });
    const text = get.result.messages[0].content.text;
    assert.equal(get.result.messages[0].role, 'user');
    assert.match(text, /review-rules\.mjs/, 'the workflow names the actual command');
    assert.match(text, /目标仓：`C:\/work\/project`/, 'the dir argument is carried into the prompt');

    // unknown prompt is a protocol-level invalid-params error, not a silent empty result
    const bad = await call({ jsonrpc: '2.0', id: 22, method: 'prompts/get', params: { name: 'nope' } });
    assert.equal(bad.error?.code, -32602);
    assert.match(bad.error?.message, /unknown prompt/);
  } finally {
    child.kill();
  }
});

test('mcp: resources/list and resources/read serve the playbook, and a bad uri is an error', async () => {
  const { child, call } = startServer();
  try {
    const list = await call({ jsonrpc: '2.0', id: 30, method: 'resources/list' });
    const uris = list.result.resources.map((r) => r.uri).sort();
    assert.deepEqual(uris, [...EXPECTED_RESOURCES].sort());
    for (const r of list.result.resources) {
      assert.equal(r.mimeType, 'text/markdown');
      assert.ok(r.name && r.title, `${r.uri} needs name + title`);
    }

    const read = await call({ jsonrpc: '2.0', id: 31, method: 'resources/read', params: { uri: 'archnav://skill' } });
    const skill = read.result.contents[0];
    assert.equal(skill.uri, 'archnav://skill');
    assert.match(skill.text, /^---\r?\nname: archnav/, 'the thin playbook keeps its frontmatter (Hermes can install it)');

    const rules = await call({ jsonrpc: '2.0', id: 32, method: 'resources/read', params: { uri: 'archnav://skill/code-review' } });
    assert.ok(rules.result.contents[0].text.length > 5000, 'the rule catalogue is served whole');

    const bad = await call({ jsonrpc: '2.0', id: 33, method: 'resources/read', params: { uri: 'archnav://nope' } });
    assert.equal(bad.error?.code, -32602);
    assert.match(bad.error?.message, /unknown resource/);
  } finally {
    child.kill();
  }
});
