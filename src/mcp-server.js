#!/usr/bin/env node
/**
 * ArchNav MCP Server — single-entry, multi-engine.
 *
 * Public tool surface (9 tools, down from 22):
 *   locate · read · callers · impact · trace · explore · status · analyze · fusion_calls
 *
 * Multi-engine: `callers` / `fusion_calls` fan out to the codegraph CLI, the
 * gitnexus CLI and the native ArchNav index, then fuse with src/fusion.js.
 * The `engine` parameter selects one (auto|codegraph|gitnexus|archnav).
 *
 * The former 13 GitNexus proxy tools are folded into `explore` behind its `op`
 * parameter, so no capability was dropped.
 *
 * stdout carries JSON-RPC only; every log goes to stderr.
 */
import path from 'path';
import { spawn } from 'child_process';
import { archNav } from './navigation.js';
import { readCode } from './reader.js';
import { analyze, saveIndex } from './analyzer.js';
import * as codegraphEngine from './engines/codegraph.js';
import * as gitnexusEngine from './engines/gitnexus.js';
import { mergeCalls, confidenceOf } from './fusion.js';

// ═══════════════════════════════════════════════════
//  GitNexus MCP Proxy (lazy — only `explore` needs it)
// ═══════════════════════════════════════════════════

let gnProcess = null;
let gnMsgId = 1000;
const gnPending = new Map();
let gnBuffer = '';

function startGitNexusMCP() {
  try {
    gnProcess = spawn('gitnexus', ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'], shell: true, windowsHide: true });

    gnProcess.stdout.on('data', (chunk) => {
      gnBuffer += chunk.toString();
      const lines = gnBuffer.split('\n');
      gnBuffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.id && gnPending.has(msg.id)) {
            const { resolve } = gnPending.get(msg.id);
            gnPending.delete(msg.id);
            resolve(msg);
          }
        } catch { /* not JSON */ }
      }
    });

    gnProcess.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (!text.includes('GitNexus: MCP')) process.stderr.write(`[gitnexus] ${text}`);
    });

    gnProcess.on('exit', (code) => {
      process.stderr.write(`[archnav] GitNexus MCP exited (code ${code})\n`);
      gnProcess = null;
      for (const [id, { reject }] of gnPending) { reject(new Error('GitNexus MCP exited')); gnPending.delete(id); }
    });

    sendToGitNexus('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'archnav', version: '1.0.0' },
    });
    return true;
  } catch (e) {
    process.stderr.write(`[archnav] Failed to start GitNexus MCP: ${e.message}\n`);
    return false;
  }
}

async function ensureGN() {
  if (!gnProcess) {
    if (!startGitNexusMCP()) throw new Error('GitNexus MCP not available. Install: npm install -g gitnexus');
    await new Promise((r) => setTimeout(r, 2000));
  }
  return gnProcess;
}

async function sendToGitNexus(method, params) {
  if (!gnProcess) throw new Error('GitNexus MCP not available');
  const id = ++gnMsgId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { gnPending.delete(id); reject(new Error(`GitNexus MCP timeout: ${method}`)); }, 30000);
    gnPending.set(id, {
      resolve: (msg) => { clearTimeout(timeout); resolve(msg); },
      reject: (err) => { clearTimeout(timeout); reject(err); },
    });
    gnProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function callGitNexusTool(toolName, args) {
  const response = await sendToGitNexus('tools/call', { name: toolName, arguments: args || {} });
  if (response.error) throw new Error(response.error.message || JSON.stringify(response.error));
  return response.result;
}

async function callGN(tool, args) {
  await ensureGN();
  return callGitNexusTool(tool, args);
}

// ═══════════════════════════════════════════════════
//  Tool Definitions (9)
// ═══════════════════════════════════════════════════

const ENGINE_ENUM = { type: 'string', enum: ['archnav', 'codegraph', 'gitnexus', 'auto'], description: 'Engine selector. Default `archnav` (this repo\'s own graph, no external binary). `auto` fans out to the external CLIs when installed — cross-check only.' };

const TOOLS = [
  {
    name: 'archnav_locate',
    description: '[ArchNav] Locate a symbol: file, line range, layer, confidence.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name' },
        projectDir: { type: 'string', description: 'Project root' },
        all: { type: 'boolean', description: 'Show all matches' },
      },
      required: ['name'],
    },
  },
  {
    name: 'archnav_read',
    description: "[ArchNav] Read a symbol's real source from disk to verify a locate.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name' },
        projectDir: { type: 'string' },
        lines: { type: 'boolean', description: 'Prefix line numbers' },
      },
      required: ['name'],
    },
  },
  {
    name: 'archnav_callers',
    description: '[ArchNav] Find callers of a symbol. Uses this repo\'s own knowledge graph by default; pass engine=auto to also ask the external CLIs (codegraph, gitnexus) as a cross-check.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name' },
        engine: ENGINE_ENUM,
        file: { type: 'string', description: 'Disambiguate a symbol by file' },
        repo: { type: 'string', description: 'gitnexus repository name' },
        projectDir: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Per-engine timeout (default 120000)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'archnav_impact',
    description: '[ArchNav] Blast radius: what breaks when a symbol changes, with fused risk.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        projectDir: { type: 'string' },
        repo: { type: 'string', description: 'gitnexus repository name' },
        maxDepth: { type: 'number' },
      },
      required: ['name'],
    },
  },
  {
    name: 'archnav_changes',
    description: '[ArchNav] Change-impact: map a git diff (or content drift) to the touched symbols and everything that breaks — the pre-commit question.',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: { type: 'string' },
        scope: { type: 'string', description: 'unstaged | staged | all | compare', enum: ['unstaged', 'staged', 'all', 'compare'] },
        base: { type: 'string', description: 'base ref for scope=compare (e.g. main)' },
      },
    },
  },
  {
    name: 'archnav_trace',
    description: '[ArchNav] Trace the shortest call path between two symbols across layers.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' }, projectDir: { type: 'string' } },
      required: ['from', 'to'],
    },
  },
  {
    name: 'archnav_explore',
    description: '[ArchNav] Deep graph ops via GitNexus: query, context, cypher, route_map, rename, detect_changes, api_impact, tool_map, groups, list_repos, deep_impact, arch.',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['arch', 'query', 'context', 'cypher', 'impact', 'route_map', 'rename', 'detect_changes', 'shape_check', 'api_impact', 'tool_map', 'group_list', 'group_sync', 'list_repos', 'deep_impact'],
          description: 'Operation (default query)',
        },
        query: { type: 'string', description: 'Search query / cypher text' },
        name: { type: 'string', description: 'Symbol name (context)' },
        target: { type: 'string', description: 'Impact target' },
        direction: { type: 'string', enum: ['upstream', 'downstream'] },
        route: { type: 'string' },
        symbol_name: { type: 'string' },
        new_name: { type: 'string' },
        dry_run: { type: 'boolean' },
        scope: { type: 'string', enum: ['unstaged', 'staged', 'all', 'compare'] },
        maxDepth: { type: 'number' },
        repo: { type: 'string', description: 'gitnexus repository name' },
        projectDir: { type: 'string' },
      },
    },
  },
  {
    name: 'archnav_status',
    description: '[ArchNav] Report index staleness and confidence versus current code.',
    inputSchema: { type: 'object', properties: { projectDir: { type: 'string' } } },
  },
  {
    name: 'archnav_analyze',
    description: '[ArchNav] Build or update the architecture knowledge graph index.',
    inputSchema: { type: 'object', properties: { projectDir: { type: 'string' } }, required: ['projectDir'] },
  },
  {
    name: 'archnav_fusion_calls',
    description: '[ArchNav] Multi-engine caller fusion: per-engine counts plus merged call sites with confidence. `archnav` (default) uses only this repo\'s graph; `auto` adds the external CLIs when installed.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name' },
        file: { type: 'string', description: 'Disambiguate a symbol by file' },
        repo: { type: 'string', description: 'gitnexus repository name' },
        projectDir: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['name'],
    },
  },
];

// Folded GitNexus proxy operations (formerly 13 standalone tools).
const EXPLORE_OPS = {
  query: 'query',
  context: 'context',
  cypher: 'cypher',
  impact: 'impact',
  route_map: 'route_map',
  rename: 'rename',
  detect_changes: 'detect_changes',
  shape_check: 'shape_check',
  api_impact: 'api_impact',
  tool_map: 'tool_map',
  group_list: 'group_list',
  group_sync: 'group_sync',
  list_repos: 'list_repos',
  deep_impact: 'deep_impact',
};

// ═══════════════════════════════════════════════════
//  Multi-engine caller gathering
// ═══════════════════════════════════════════════════

async function gatherCallersFromEngines(name, args) {
  const dir = path.resolve(args.projectDir || process.cwd());
  const engine = args.engine || 'archnav';
  const timeoutMs = args.timeoutMs;
  const results = [];

  if (engine === 'auto' || engine === 'codegraph') {
    try {
      const r = await codegraphEngine.callers(name, { projectDir: dir, file: args.file, timeoutMs });
      results.push({ ...r, engine: 'codegraph' });
    } catch (e) {
      results.push({ symbol: name, callers: [], engine: 'codegraph', error: `adapter_exception: ${e.message}` });
    }
  }
  if (engine === 'auto' || engine === 'gitnexus') {
    try {
      const r = await gitnexusEngine.callers(name, { repo: args.repo, file: args.file, projectDir: dir, timeoutMs });
      results.push({ ...r, engine: 'gitnexus' });
    } catch (e) {
      results.push({ symbol: name, callers: [], engine: 'gitnexus', error: `adapter_exception: ${e.message}` });
    }
  }
  if (engine === 'auto' || engine === 'archnav') {
    try {
      const r = await archNav.callers(name, dir);
      const callers = (r.relations || []).map((rel) => ({
        file: rel.file,
        line: rel.line === '?' || rel.line === undefined ? null : rel.line,
        enclosing: rel.symbol,
        engine: 'archnav',
        source_kind: rel.source === 'call-graph' ? 'ast' : 'heuristic',
      }));
      results.push({ symbol: name, callers, raw: r, engine: 'archnav', error: r.error });
    } catch (e) {
      results.push({ symbol: name, callers: [], engine: 'archnav', error: `adapter_exception: ${e.message}` });
    }
  }
  return results;
}

function describeErrors(results) {
  const notes = [];
  for (const r of results) {
    if (r.error) notes.push(`${r.engine}: ${r.error}`);
    if (r.ambiguous && r.candidates?.length) notes.push(`${r.engine}: ambiguous (${r.candidates.length} defs, resolved_by=${r.resolved_by || 'n/a'})`);
  }
  return notes;
}

function formatEngineCounts(fused) {
  return fused.sources.map((s) => `${s.engine}=${s.count}${s.error ? ` (${s.error})` : ''}`).join(', ');
}

function formatFusedCallers(name, fused, verbose, notes) {
  let text = `🔼 Callers of ${name}  [fused ${fused.callers.length} | ${formatEngineCounts(fused)}]\n\n`;
  if (!fused.callers.length) {
    text += '   (no callers found)\n';
  } else {
    for (const c of fused.callers) {
      const loc = `${c.file}${c.line !== null ? `:${c.line}` : ':?'}`;
      const who = c.enclosing ? ` ${c.enclosing}` : '';
      text += `   ${loc}${who}  [${c.engines.join('+')} · ${c.source_kind} · ${c.confidence.toFixed(2)}]\n`;
    }
  }
  if (verbose) {
    text += `\n   engines agreeing: ${fused.engines.join(', ') || '(none)'}\n`;
    for (const s of fused.sources) text += `   source ${s.engine}: ${s.count} raw${s.error ? ` — ${s.error}` : ''}\n`;
  }
  if (notes?.length) text += `\n   ⚠️ ${notes.join('; ')}\n`;
  return text;
}

// ═══════════════════════════════════════════════════
//  Tool Handlers
// ═══════════════════════════════════════════════════

async function handleToolCall(name, args) {
  const dir = path.resolve(args.projectDir || process.cwd());

  switch (name) {
    case 'archnav_locate': {
      const result = await archNav.locate(args.name, dir, { all: args.all });
      if (result.error) return mkErr(result.error);
      const s = result.symbol;
      return mkText(`📌 ${s.name}\n  Kind: ${s.kind || 'symbol'}\n  File: ${s.file}\n  Lines: ${s.line_start}–${s.line_end}\n  Signature: ${s.signature || 'N/A'}\n  Layer: ${result.layer || '(unknown)'}\n  Confidence: ${(result.confidence * 100).toFixed(0)}%`);
    }

    case 'archnav_read': {
      const result = await readCode(args.name, dir, { lines: args.lines });
      if (result.error) return mkErr(result.error);
      const code = result.lines ? result.code : `\`\`\`\n${result.code}\n\`\`\``;
      return mkText(`${code}\n\n📍 ${result.file}:${result.line_start}–${result.line_end}\nConfidence: ${(result.confidence * 100).toFixed(0)}%`);
    }

    case 'archnav_callers':
    case 'archnav_fusion_calls': {
      const results = await gatherCallersFromEngines(args.name, args);
      const fused = mergeCalls(results);
      if (!fused.symbol) fused.symbol = args.name;
      const notes = describeErrors(results);
      return mkText(formatFusedCallers(args.name, fused, name === 'archnav_fusion_calls', notes));
    }

    case 'archnav_changes': {
      const r = await archNav.changes(dir, { scope: args.scope || 'unstaged', base: args.base });
      if (r.error) return mkErr(r.error);
      let text = `🔀 Change impact — ${r.summary.changed_files} file(s) via ${r.via === 'git' ? `git diff (${r.scope})` : 'content drift'}\n`;
      if (r.note) text += `⚠️  ${r.note}\n`;
      if (r.changed_symbols.length) {
        text += '\n📝 Changed symbols:\n';
        for (const s of r.changed_symbols) text += `   ${s.symbol} (${s.kind || '?'}) → ${s.file}:${s.line_start ?? '?'}\n`;
      } else {
        text += '\n📝 No indexed symbol falls inside the changed lines.\n';
      }
      text += `\n🔴 Direct impact (${r.summary.direct}):\n`;
      for (const x of r.direct_impact) text += `   ${x.symbol} → ${x.file}:${x.line ?? '?'}${x.via ? ` (via ${x.via})` : ''}\n`;
      if (!r.summary.direct) text += '   (none)\n';
      text += `\n🟡 Indirect impact (${r.summary.indirect}):\n`;
      for (const x of r.indirect_impact.slice(0, 20)) text += `   ${x.symbol} → ${x.file}:${x.line ?? '?'} (depth ${x.depth}, via ${x.via ?? '?'})\n`;
      if (r.summary.indirect > 20) text += `   … ${r.summary.indirect - 20} more\n`;
      if (!r.summary.indirect) text += '   (none)\n';
      if (r.affected_routes.length) {
        text += `\n🛣️  Routes (${r.affected_routes.length}):\n`;
        for (const x of r.affected_routes) text += `   ${x.symbol} → ${x.file}:${x.line ?? '?'}\n`;
      }
      if (r.unmapped_files.length) {
        text += `\n⚪ Changed but unmapped (${r.unmapped_files.length}):\n`;
        for (const f of r.unmapped_files) text += `   ${f}\n`;
      }
      return { content: [{ type: 'text', text }] };
    }

    case 'archnav_impact': {
      const archResult = await archNav.impact(args.name, dir);
      if (archResult.error) return mkErr(archResult.error);
      let text = `💥 Impact: ${args.name}\n\n`;
      if (archResult.layer) text += `🏗️  Layer (ArchNav): ${archResult.layer}\n`;
      if (archResult.confidence !== undefined) text += `📊 Confidence: ${(archResult.confidence * 100).toFixed(0)}%\n`;
      if (archResult.direct_impact?.length) {
        text += '\n🔴 Direct (ArchNav):\n';
        for (const i of archResult.direct_impact) text += `   ${i.symbol} → ${i.file}:${i.line}\n`;
      }
      try {
        const gnResult = await callGN('impact', { target: args.name, direction: 'upstream', maxDepth: args.maxDepth || 3, repo: args.repo });
        const gnText = gnResult?.content?.[0]?.text || '';
        if (gnText) {
          const jsonPart = gnText.split('\n---')[0].trim();
          try {
            const gnData = JSON.parse(jsonPart);
            text += `\n🔍 Risk (GitNexus): ${gnData.risk || 'N/A'}\n`;
            if (gnData.summary) text += `   Direct: ${gnData.summary.direct || 0}\n   Processes affected: ${gnData.summary.processes_affected || 0}\n`;
          } catch { text += `\n[GitNexus raw]\n${gnText.substring(0, 300)}`; }
        }
      } catch { /* gitnexus optional */ }
      if (!archResult.direct_impact?.length) text += '\n⚠️ No direct callers found in ArchNav graph.';
      return mkText(text);
    }

    case 'archnav_trace': {
      const result = await archNav.trace(args.from, args.to, dir);
      let text = '';
      if (result.path?.length) {
        text += `🔍 ArchNav Trace: ${args.from} → ${args.to}\n`;
        for (let i = 0; i < result.path.length; i++) {
          const s = result.path[i];
          const p = i === 0 ? '┌─' : i === result.path.length - 1 ? '└─' : '├─';
          text += `${p} ${s.symbol} (${s.file}:${s.line}) [${s.layer}]\n`;
          if (i < result.path.length - 1) text += `│  ↓ ${s.call_type || 'calls'}\n`;
        }
        if (result.crossesLayers) text += `🏗️ Crosses: ${result.crossesLayers.join(' → ')}\n`;
      }
      if (!text) text = result.error ? `⚠️ ${result.error}` : `No path found: ${args.from} → ${args.to}`;
      return mkText(text);
    }

    case 'archnav_explore': {
      const op = args.op || 'query';
      if (op === 'arch') {
        const result = await archNav.architecture(dir);
        if (result.error) return mkErr(result.error);
        let text = `🏗️ Architecture Map: ${result.projectName}\n\n`;
        for (const layer of result.layers) text += `${layer.violations > 0 ? '⚠️' : '✅'} ${layer.name}  (files: ${layer.files})\n`;
        if (result.flows?.length) {
          text += '\n🔀 Flows:\n';
          for (const f of result.flows) text += `   ${f.name}: ${f.path.join(' → ')}\n`;
        }
        return mkText(text);
      }
      const gnTool = EXPLORE_OPS[op];
      if (!gnTool) return mkErr(`Unknown explore op: ${op}`);
      try {
        const result = await callGN(gnTool, args);
        if (result?.content) return mkText(result.content.map((c) => c.text || '').join('\n'));
        return mkText(JSON.stringify(result, null, 2));
      } catch (e) {
        return mkErr(`GitNexus error: ${e.message}`);
      }
    }

    case 'archnav_status': {
      const result = await archNav.status(dir);
      return mkText(result.stale
        ? `⚠️ STALE (${result.changedFiles} changed)\nHEAD: ${result.currentHead?.substring(0, 8)}\nConfidence: ${(result.overallConfidence * 100).toFixed(0)}%`
        : '✅ Fresh');
    }

    case 'archnav_analyze': {
      const result = await analyze(dir, {});
      saveIndex(dir, result._raw || result);
      return mkText(`✅ ${result.files} files, ${result.symbols} symbols, ${result.layers} layers`);
    }
  }

  return mkErr(`Unknown tool: ${name}`);
}

function mkText(text) { return { content: [{ type: 'text', text }] }; }
function mkErr(msg) { return { content: [{ type: 'text', text: `⚠️ ${msg}` }], isError: true }; }

// ═══════════════════════════════════════════════════
//  MCP Server Loop
// ═══════════════════════════════════════════════════

const serverInfo = { name: 'archnav', version: '2.0.0' };

process.stdin.setEncoding('utf-8');
let buffer = '';

process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let request;
    try { request = JSON.parse(trimmed); } catch { sendError(null, ERRORS.INVALID_REQUEST); continue; }

    const id = request.id;
    const method = request.method;

    try {
      switch (method) {
        case 'initialize':
          send(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo });
          break;
        case 'tools/list':
          send(id, { tools: TOOLS });
          break;
        case 'tools/call': {
          const result = await handleToolCall(request.params?.name, request.params?.arguments || {});
          send(id, result);
          break;
        }
        case 'notifications/initialized':
          break;
        default:
          sendError(id, ERRORS.METHOD_NOT_FOUND);
      }
    } catch (e) {
      process.stderr.write(`[archnav] Error ${method}: ${e.message}\n`);
      sendError(id, { ...ERRORS.INTERNAL_ERROR, message: e.message });
    }
  }
});

function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function sendError(id, error) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error }) + '\n'); }

const ERRORS = {
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
};

process.stderr.write(`[archnav] MCP server: ${TOOLS.length} tools; engine: archnav (default) — optional cross-check engines: codegraph, gitnexus\n`);

export { TOOLS, handleToolCall, gatherCallersFromEngines, confidenceOf };
