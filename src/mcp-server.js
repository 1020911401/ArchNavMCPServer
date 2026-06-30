#!/usr/bin/env node
/**
 * ArchNav MCP Server — Dual-Engine (ArchNav + GitNexus)
 *
 * ArchNav native (9 tools): locate, read, arch, calls, callers, status, analyze, trace, impact
 * GitNexus proxy (13 tools): query, context, cypher, route_map, rename, detect_changes,
 *   shape_check, api_impact, tool_map, group_list, group_sync, list_repos, deep_impact
 * ───────────────────────────────────────────────
 * Total: 22 tools — surpasses GitNexus's 17
 */
import path from 'path';
import { spawn } from 'child_process';
import { archNav } from './navigation.js';
import { readCode } from './reader.js';
import { analyze, saveIndex, getIndex } from './analyzer.js';

// ═══════════════════════════════════════════════════
//  GitNexus MCP Proxy Client
// ═══════════════════════════════════════════════════

let gnProcess = null;
let gnMsgId = 1000;
const gnPending = new Map();
let gnBuffer = '';

function startGitNexusMCP() {
  try {
    gnProcess = spawn('gitnexus', ['mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

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
        } catch {}
      }
    });

    gnProcess.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (!text.includes('GitNexus: MCP')) {
        process.stderr.write(`[gitnexus] ${text}`);
      }
    });

    gnProcess.on('exit', (code) => {
      process.stderr.write(`[archnav] GitNexus MCP exited (code ${code})\n`);
      gnProcess = null;
      for (const [id, { reject }] of gnPending) {
        reject(new Error('GitNexus MCP exited'));
        gnPending.delete(id);
      }
    });

    // Send initialize
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

async function sendToGitNexus(method, params) {
  if (!gnProcess) throw new Error('GitNexus MCP not available');
  const id = ++gnMsgId;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      gnPending.delete(id);
      reject(new Error(`GitNexus MCP timeout: ${method}`));
    }, 30000);

    gnPending.set(id, {
      resolve: (msg) => {
        clearTimeout(timeout);
        resolve(msg);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    gnProcess.stdin.write(request);
  });
}

async function callGitNexusTool(toolName, args) {
  const response = await sendToGitNexus('tools/call', {
    name: toolName,
    arguments: args || {},
  });
  if (response.error) throw new Error(response.error.message || JSON.stringify(response.error));
  return response.result;
}

// ═══════════════════════════════════════════════════
//  Tool Definitions (22 tools)
// ═══════════════════════════════════════════════════

const TOOLS = [
  // ── ArchNav Native (9) ──
  {
    name: 'archnav_locate',
    description: '[ArchNav] Locate a symbol → file:line range + confidence score',
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
    description: '[ArchNav] Read actual source code from disk (verification pattern)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name' },
        projectDir: { type: 'string' },
        lines: { type: 'boolean' },
      },
      required: ['name'],
    },
  },
  {
    name: 'archnav_arch',
    description: '[ArchNav] Show layered architecture map',
    inputSchema: {
      type: 'object',
      properties: { projectDir: { type: 'string' } },
    },
  },
  {
    name: 'archnav_trace',
    description: '[ArchNav] Trace shortest call path between symbols',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' }, to: { type: 'string' }, projectDir: { type: 'string' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'archnav_impact',
    description: '[ArchNav] Blast radius analysis (shallow: direct + indirect callers)',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, projectDir: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'archnav_calls',
    description: '[ArchNav] Show outgoing calls from a symbol',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, projectDir: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'archnav_callers',
    description: '[ArchNav] Show incoming callers of a symbol',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, projectDir: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'archnav_status',
    description: '[ArchNav] Show index staleness vs current code',
    inputSchema: {
      type: 'object',
      properties: { projectDir: { type: 'string' } },
    },
  },
  {
    name: 'archnav_analyze',
    description: '[ArchNav] Build/update architecture knowledge graph',
    inputSchema: {
      type: 'object',
      properties: { projectDir: { type: 'string' } },
      required: ['projectDir'],
    },
  },

  // ── GitNexus Proxy (13) ──
  {
    name: 'gn_query',
    description: '[GitNexus] Deep semantic search over code knowledge graph',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        repo: { type: 'string', description: 'Repo name (omit if one repo)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'gn_context',
    description: '[GitNexus] 360° deep context of a symbol (callers, callees, relationships)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, uid: { type: 'string' },
        file_path: { type: 'string' }, kind: { type: 'string' },
        repo: { type: 'string' },
      },
    },
  },
  {
    name: 'gn_cypher',
    description: '[GitNexus] Execute Cypher queries against the code knowledge graph',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, repo: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'gn_impact',
    description: '[GitNexus] Deep blast radius with scope resolution and risk assessment',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' }, direction: { type: 'string', enum: ['upstream', 'downstream'] },
        maxDepth: { type: 'number' }, repo: { type: 'string' },
      },
      required: ['target', 'direction'],
    },
  },
  {
    name: 'gn_route_map',
    description: '[GitNexus] Show API route → handler mappings',
    inputSchema: {
      type: 'object',
      properties: { route: { type: 'string' }, repo: { type: 'string' } },
    },
  },
  {
    name: 'gn_rename',
    description: '[GitNexus] Graph-assisted multi-file rename',
    inputSchema: {
      type: 'object',
      properties: {
        symbol_name: { type: 'string' }, new_name: { type: 'string' },
        dry_run: { type: 'boolean' }, repo: { type: 'string' },
      },
      required: ['new_name'],
    },
  },
  {
    name: 'gn_detect_changes',
    description: '[GitNexus] Analyze uncommitted changes for affected flows',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['unstaged', 'staged', 'all', 'compare'] },
        repo: { type: 'string' },
      },
    },
  },
  {
    name: 'gn_shape_check',
    description: '[GitNexus] Check API response shapes against consumers',
    inputSchema: {
      type: 'object',
      properties: { route: { type: 'string' }, repo: { type: 'string' } },
    },
  },
  {
    name: 'gn_api_impact',
    description: '[GitNexus] Pre-change API route handler impact report',
    inputSchema: {
      type: 'object',
      properties: { route: { type: 'string' }, file: { type: 'string' }, repo: { type: 'string' } },
    },
  },
  {
    name: 'gn_tool_map',
    description: '[GitNexus] Show MCP/RPC tool definitions and handlers',
    inputSchema: {
      type: 'object',
      properties: { tool: { type: 'string' }, repo: { type: 'string' } },
    },
  },
  {
    name: 'gn_group_list',
    description: '[GitNexus] List configured repository groups',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
    },
  },
  {
    name: 'gn_group_sync',
    description: '[GitNexus] Rebuild Contract Registry for a group',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'gn_list_repos',
    description: '[GitNexus] List all indexed repositories',
    inputSchema: { type: 'object', properties: {} },
  },
];

// Map GitNexus tool names to their MCP tool names
const GN_TOOL_MAP = {
  gn_query: 'query',
  gn_context: 'context',
  gn_cypher: 'cypher',
  gn_impact: 'impact',
  gn_route_map: 'route_map',
  gn_rename: 'rename',
  gn_detect_changes: 'detect_changes',
  gn_shape_check: 'shape_check',
  gn_api_impact: 'api_impact',
  gn_tool_map: 'tool_map',
  gn_group_list: 'group_list',
  gn_group_sync: 'group_sync',
  gn_list_repos: 'list_repos',
};

// ═══════════════════════════════════════════════════
//  Tool Handlers
// ═══════════════════════════════════════════════════

async function handleToolCall(name, args) {
  const dir = path.resolve(args.projectDir || process.cwd());

  // ── ArchNav Native ──
  switch (name) {
    case 'archnav_locate': {
      const result = await archNav.locate(args.name, dir, { all: args.all });
      if (result.error) return mkErr(result.error);
      const sym = result.symbol;
      return mkText(`📌 ${sym.name}
  Kind: ${sym.kind || 'symbol'}
  File: ${sym.file}
  Lines: ${sym.line_start}–${sym.line_end}
  Signature: ${sym.signature || 'N/A'}
  Layer: ${result.layer || '(unknown)'}
  Confidence: ${(result.confidence * 100).toFixed(0)}%`);
    }

    case 'archnav_read': {
      const result = await readCode(args.name, dir, { lines: args.lines });
      if (result.error) return mkErr(result.error);
      const code = result.lines ? result.code : `\`\`\`\n${result.code}\n\`\`\``;
      return mkText(`${code}\n\n📍 ${result.file}:${result.line_start}–${result.line_end}\nConfidence: ${(result.confidence * 100).toFixed(0)}%`);
    }

    case 'archnav_arch': {
      const result = await archNav.architecture(dir);
      if (result.error) return mkErr(result.error);
      let text = `🏗️ Architecture Map: ${result.projectName}\n\n`;
      for (const layer of result.layers) {
        text += `${layer.violations > 0 ? '⚠️' : '✅'} ${layer.name}\n   Files: ${layer.files}\n`;
      }
      if (result.flows?.length) {
        text += '\n🔀 Flows:\n';
        for (const f of result.flows) text += `   ${f.name}: ${f.path.join(' → ')}\n`;
      }
      return mkText(text);
    }

    case 'archnav_trace': {
      const result = await archNav.trace(args.from, args.to, dir);
      let text = '';

      // Part 1: ArchNav trace (always)
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

      // Part 2: GitNexus deep trace (always, if available)
      try {
        const gnResult = await callGN('query', { query: `trace ${args.from} ${args.to}`, repo: args.repo });
        const gnText = gnResult?.content?.[0]?.text || '';
        if (gnText) {
          try {
            const gnData = JSON.parse(gnText);
            if (gnData.processes?.length) {
              text += `\n🔍 GitNexus Deep: ${gnData.processes.length} process(es)\n`;
              for (const p of gnData.processes.slice(0, 3)) {
                text += `   • ${p.summary || p.id} (${p.step_count || '?'} steps)\n`;
              }
            }
          } catch {
            // raw text
          }
        }
      } catch {}

      if (!text) {
        text = result.error ? `⚠️ ${result.error}` : `No path found: ${args.from} → ${args.to}`;
      }
      return mkText(text);
    }

    case 'archnav_impact': {
      let archResult = await archNav.impact(args.name, dir);
      let text = `💥 Impact: ${args.name}\n\n`;

      // Part 1: ArchNav layer + direct callers
      if (archResult.layer) text += `🏗️  Layer (ArchNav): ${archResult.layer}\n`;
      if (archResult.confidence !== undefined) text += `📊 Confidence: ${(archResult.confidence * 100).toFixed(0)}%\n`;
      if (archResult.direct_impact?.length) {
        text += `\n🔴 Direct (ArchNav):\n`;
        for (const i of archResult.direct_impact) text += `   ${i.symbol} → ${i.file}:${i.line}\n`;
      }

      // Part 2: GitNexus risk + depth (always)
      try {
        const gnResult = await callGN('impact', {
          target: args.name, direction: 'upstream', maxDepth: args.maxDepth || 3, repo: args.repo,
        });
        const gnText = gnResult?.content?.[0]?.text || '';
        if (gnText) {
          // Strip trailing text after the JSON (--- headers etc.)
          const jsonPart = gnText.split('\n---')[0].trim();
          try {
            const gnData = JSON.parse(jsonPart);
            text += `\n🔍 Risk (GitNexus): ${gnData.risk || 'N/A'}\n`;
            if (gnData.summary) {
              text += `   Direct: ${gnData.summary.direct || 0}\n`;
              text += `   Processes affected: ${gnData.summary.processes_affected || 0}\n`;
            }
            if (gnData.byDepthCounts) {
              text += `   By depth: ${JSON.stringify(gnData.byDepthCounts)}\n`;
            }
          } catch {
            text += `\n[GitNexus raw]\n${gnText.substring(0, 300)}`;
          }
        }
      } catch {}

      if (!archResult.direct_impact?.length) {
        text += '\n⚠️ No direct callers found in ArchNav graph.';
      }
      return mkText(text);
    }

    case 'archnav_calls':
    case 'archnav_callers': {
      const fn = name === 'archnav_calls' ? archNav.calls : archNav.callers;
      let result = await fn(args.name, dir);
      const direction = name === 'archnav_calls' ? 'calls' : 'called by';
      let text = `${direction === 'calls' ? '🔽' : '🔼'} ${args.name} ${direction}\n\n`;

      // Part 1: ArchNav's own call edges (with layer info)
      if (result.relations?.length) {
        text += `[ArchNav — ${result.relations.length} relationship(s)]\n`;
        for (const r of result.relations) {
          text += `   ${r.symbol} → ${r.file}:${r.line} [${r.layer || '?'}]\n`;
        }
      }

      // Part 2: GitNexus deep context (always, for UIDs + scope resolution)
      try {
        const gnResult = await callGN('context', { name: args.name, repo: args.repo });
        const gnText = gnResult?.content?.[0]?.text || '';
        if (gnText) {
          try {
            const gnData = JSON.parse(gnText);
            const rels = direction === 'calls'
              ? gnData.outgoing?.calls || []
              : gnData.incoming?.calls || [];
            if (rels.length) {
              text += `\n[GitNexus — ${rels.length} deep relationship(s)]\n`;
              for (const r of rels) {
                const uid = r.uid || '';
                text += `   ${r.name || '?'} → ${r.filePath}:${r.startLine || '?'}\n`;
                if (uid) text += `        UID: ${uid.substring(0, 60)}\n`;
              }
            }
          } catch {}
        }
      } catch {}

      if (!result.relations?.length) {
        text += '\n⚠️ No relationships found in ArchNav graph.';
      }
      return mkText(text);
    }

    case 'archnav_status': {
      const result = await archNav.status(dir);
      let text = result.stale
        ? `⚠️ STALE (${result.changedFiles} changed)\nHEAD: ${result.currentHead?.substring(0, 8)}\nConfidence: ${(result.overallConfidence * 100).toFixed(0)}%`
        : '✅ Fresh';
      return mkText(text);
    }

    case 'archnav_analyze': {
      const result = await analyze(dir, {});
      saveIndex(dir, result._raw || result);
      return mkText(`✅ ${result.files} files, ${result.symbols} symbols, ${result.layers} layers`);
    }
  }

  // ── GitNexus Proxy ──
  const gnTool = GN_TOOL_MAP[name];
  if (gnTool) {
    if (!gnProcess) {
      const started = startGitNexusMCP();
      if (!started) return mkErr('GitNexus MCP not available. Install: npm install -g gitnexus');
      // Wait for initialization
      await new Promise(r => setTimeout(r, 2000));
    }
    try {
      const result = await callGitNexusTool(gnTool, args);
      // Extract text from content array
      if (result?.content) {
        const texts = result.content.map(c => c.text || '').join('\n');
        return mkText(texts);
      }
      return mkText(JSON.stringify(result, null, 2));
    } catch (e) {
      return mkErr(`GitNexus error: ${e.message}`);
    }
  }

  return mkErr(`Unknown tool: ${name}`);
}

function mkText(text) {
  return { content: [{ type: 'text', text }] };
}
function mkErr(msg) {
  return { content: [{ type: 'text', text: `⚠️ ${msg}` }], isError: true };
}

/** Call a GitNexus tool (shortcut) */
async function callGN(tool, args) {
  if (!gnProcess) { const started = startGitNexusMCP(); if (!started) throw new Error('GN not available'); await new Promise(r => setTimeout(r, 2000)); }
  const result = await callGitNexusTool(tool, args);
  return result;
}

// ═══════════════════════════════════════════════════
//  MCP Server Loop
// ═══════════════════════════════════════════════════

const serverInfo = { name: 'archnav', version: '2.0.0' };

// Start GitNexus in background (non-blocking)
try { startGitNexusMCP(); } catch (e) {}

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
    try {
      request = JSON.parse(trimmed);
    } catch {
      sendError(null, ERRORS.INVALID_REQUEST);
      continue;
    }

    const id = request.id;
    const method = request.method;

    try {
      switch (method) {
        case 'initialize':
          send(id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo,
          });
          break;

        case 'tools/list':
          send(id, { tools: TOOLS });
          break;

        case 'tools/call': {
          const toolName = request.params?.name;
          const args = request.params?.arguments || {};
          const result = await handleToolCall(toolName, args);
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

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function sendError(id, error) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error }) + '\n');
}

const ERRORS = {
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
};

process.stderr.write(`[archnav] Dual-engine MCP: ${TOOLS.length} tools (${Object.keys(GN_TOOL_MAP).length} via GitNexus)\n`);
