#!/usr/bin/env node
/**
 * ArchNav MCP Server — Model Context Protocol stdio server
 * 
 * Exposes ArchNav's architecture navigation, line-level locate,
 * read-verification, impact analysis, and call tracing as MCP tools.
 * 
 * Compatible with: Claude Code, Hermes, Cursor, Codex, etc.
 */
import path from 'path';
import { archNav } from './navigation.js';
import { readCode } from './reader.js';
import { analyze, saveIndex, getIndex } from './analyzer.js';

// ═══════════════════════════════════════════════════
//  MCP Protocol helpers (JSON-RPC 2.0 over stdio)
// ═══════════════════════════════════════════════════

function mcpError(code, message) {
  return { code, message };
}

const ERRORS = {
  INVALID_REQUEST: mcpError(-32600, 'Invalid Request'),
  METHOD_NOT_FOUND: mcpError(-32601, 'Method not found'),
  INVALID_PARAMS: mcpError(-32602, 'Invalid params'),
  INTERNAL_ERROR: mcpError(-32603, 'Internal error'),
  TOOL_NOT_FOUND: mcpError(-32001, 'Tool not found'),
};

// ═══════════════════════════════════════════════════
//  Tool Definitions
// ═══════════════════════════════════════════════════

const TOOLS = [
  {
    name: 'archnav_locate',
    description: 'Locate a symbol (function, class, method) in the codebase — returns file path, exact line range, and confidence score',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name to locate (e.g. "getOrderById", "UserService")' },
        projectDir: { type: 'string', description: 'Project root directory (default: cwd)' },
        all: { type: 'boolean', description: 'Show all matches, not just the best' },
      },
      required: ['name'],
    },
  },
  {
    name: 'archnav_read',
    description: 'Read a symbol\'s actual source code from disk (verification pattern) — use this BEFORE modifying code to ensure accuracy',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name to read' },
        projectDir: { type: 'string', description: 'Project root directory' },
        lines: { type: 'boolean', description: 'Show line numbers in output' },
      },
      required: ['name'],
    },
  },
  {
    name: 'archnav_arch',
    description: 'Show the layered architecture map of the project (API → Service → Repository etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: { type: 'string', description: 'Project root directory' },
      },
    },
  },
  {
    name: 'archnav_trace',
    description: 'Trace the shortest call path between two symbols through the architecture layers',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Starting symbol name' },
        to: { type: 'string', description: 'Target symbol name' },
        projectDir: { type: 'string', description: 'Project root directory' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'archnav_impact',
    description: 'Analyze blast radius — what breaks if this symbol changes (direct + indirect callers, test files)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol to analyze' },
        projectDir: { type: 'string', description: 'Project root directory' },
      },
      required: ['name'],
    },
  },
  {
    name: 'archnav_calls',
    description: 'Show what a symbol calls (outgoing dependencies)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name' },
        projectDir: { type: 'string', description: 'Project root directory' },
      },
      required: ['name'],
    },
  },
  {
    name: 'archnav_callers',
    description: 'Show who calls a symbol (incoming dependencies)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name' },
        projectDir: { type: 'string', description: 'Project root directory' },
      },
      required: ['name'],
    },
  },
  {
    name: 'archnav_status',
    description: 'Show staleness status of the code index vs current code on disk',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: { type: 'string', description: 'Project root directory' },
      },
    },
  },
  {
    name: 'archnav_analyze',
    description: 'Analyze a codebase and build/update the architecture knowledge graph',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: { type: 'string', description: 'Project root directory' },
      },
      required: ['projectDir'],
    },
  },
];

// ═══════════════════════════════════════════════════
//  Tool Handlers
// ═══════════════════════════════════════════════════

async function handleToolCall(name, args) {
  const dir = path.resolve(args.projectDir || process.cwd());

  switch (name) {
    case 'archnav_locate': {
      const result = await archNav.locate(args.name, dir, { all: args.all });
      if (result.error) return { content: [{ type: 'text', text: `⚠️ ${result.error}\n\nRun "archnav analyze ${dir}" first.` }], isError: true };
      const sym = result.symbol;
      return {
        content: [{
          type: 'text',
          text: `📌 ${sym.name}
  Kind: ${sym.kind || 'symbol'}
  File: ${sym.file}
  Lines: ${sym.line_start}–${sym.line_end}
  Signature: ${sym.signature || 'N/A'}
  Layer: ${result.layer || '(unknown)'}
  Confidence: ${(result.confidence * 100).toFixed(0)}%`,
        }],
      };
    }

    case 'archnav_read': {
      const result = await readCode(args.name, dir, { lines: args.lines });
      if (result.error) return { content: [{ type: 'text', text: `⚠️ ${result.error}` }], isError: true };
      const code = result.lines ? result.code : `\`\`\`\n${result.code}\n\`\`\``;
      return {
        content: [{
          type: 'text',
          text: `${code}\n\n📍 ${result.file}:${result.line_start}–${result.line_end}\nConfidence: ${(result.confidence * 100).toFixed(0)}%${result.signature_confirmed === false ? '\n⚠️ Signature mismatch — verify carefully!' : ''}`,
        }],
      };
    }

    case 'archnav_arch': {
      const result = await archNav.architecture(dir);
      if (result.error) return { content: [{ type: 'text', text: `⚠️ ${result.error}` }], isError: true };
      let text = `🏗️ Architecture Map: ${result.projectName}\n\n`;
      for (const layer of result.layers) {
        const indicator = layer.violations > 0 ? '⚠️' : '✅';
        text += `${indicator} ${layer.name}\n`;
        text += `   Files: ${layer.files}, Symbols: ${layer.symbols}\n`;
        if (layer.dependencies?.length) text += `   Depends on: ${layer.dependencies.join(', ')}\n`;
        if (layer.violations > 0) text += `   ⚠️ ${layer.violations} violation(s)\n`;
      }
      if (result.flows?.length) {
        text += '\n🔀 Data Flows:\n';
        for (const flow of result.flows) text += `   ${flow.name}: ${flow.path.join(' → ')}\n`;
      }
      if (result.violations?.length) {
        text += '\n❌ Architecture Violations:\n';
        for (const v of result.violations) text += `   • ${v.layer}: ${v.details}\n`;
      }
      text += `\nConfidence: ${(result.confidence * 100).toFixed(0)}%`;
      return { content: [{ type: 'text', text }] };
    }

    case 'archnav_trace': {
      const result = await archNav.trace(args.from, args.to, dir);
      if (result.error) return { content: [{ type: 'text', text: `⚠️ ${result.error}` }], isError: true };
      if (!result.path?.length) return { content: [{ type: 'text', text: `No path found from "${args.from}" to "${args.to}"` }] };
      let text = `🔍 Trace: ${args.from} → ${args.to}\n\n`;
      for (let i = 0; i < result.path.length; i++) {
        const step = result.path[i];
        const p = i === 0 ? '┌─' : i === result.path.length - 1 ? '└─' : '├─';
        const cf = step.confidence < 1 ? ` ⚠️${(step.confidence * 100).toFixed(0)}%` : '';
        text += `${p} ${step.symbol} (${step.file}:${step.line}) [${step.layer}]${cf}\n`;
        if (i < result.path.length - 1) text += `│  ↓ ${step.call_type || 'calls'}\n`;
      }
      if (result.crossesLayers) text += `\n🏗️ Crosses layers: ${result.crossesLayers.join(' → ')}`;
      return { content: [{ type: 'text', text }] };
    }

    case 'archnav_impact': {
      const result = await archNav.impact(args.name, dir);
      if (result.error) return { content: [{ type: 'text', text: `⚠️ ${result.error}` }], isError: true };
      let text = `💥 Impact Analysis: ${args.name}\n   Layer: ${result.layer}\n   File: ${result.file}:${result.line_start}\n`;
      if (result.direct_impact?.length) {
        text += '\n🔴 Direct impact (will break):\n';
        for (const i of result.direct_impact) text += `   ${i.symbol} → ${i.file}:${i.line}\n`;
      }
      if (result.indirect_impact?.length) {
        text += '\n🟡 Indirect impact (may break):\n';
        for (const i of result.indirect_impact) text += `   ${i.symbol} → ${i.file}:${i.line}\n`;
      }
      if (result.suggested_tests?.length) {
        text += '\n🧪 Test files to update:\n';
        for (const t of result.suggested_tests) text += `   ${t}\n`;
      }
      text += `\nConfidence: ${(result.confidence * 100).toFixed(0)}%`;
      return { content: [{ type: 'text', text }] };
    }

    case 'archnav_calls':
    case 'archnav_callers': {
      const fn = name === 'archnav_calls' ? archNav.calls : archNav.callers;
      const result = await fn(args.name, dir);
      if (result.error) return { content: [{ type: 'text', text: `⚠️ ${result.error}` }], isError: true };
      const direction = name === 'archnav_calls' ? 'calls' : 'called by';
      let text = `${direction === 'calls' ? '🔽' : '🔼'} ${result.symbol} ${direction}:\n`;
      if (!result.relations?.length) text += '\n   (none)';
      else for (const r of result.relations) text += `\n   ${r.symbol} → ${r.file}:${r.line} [${r.layer}]`;
      return { content: [{ type: 'text', text }] };
    }

    case 'archnav_status': {
      const result = await archNav.status(dir);
      let text = `📊 Index Status: ${result.project}\n\n`;
      if (result.stale) {
        text += `⚠️ Index is STALE (${result.changedFiles} file(s) changed)\n`;
        text += `Indexed: ${result.indexedCommit?.substring(0, 8) || 'N/A'}\n`;
        text += `HEAD:    ${result.currentHead?.substring(0, 8) || 'N/A'}\n`;
        text += `Age:     ${result.indexAge || 'N/A'}\n`;
        text += `Confidence: ${(result.overallConfidence * 100).toFixed(0)}%\n`;
        if (result.changedDetails?.length) {
          text += '\nChanged files:\n';
          for (const f of result.changedDetails) text += `   ${f.file}\n`;
        }
      } else {
        text += '✅ Index is fresh\n';
      }
      return { content: [{ type: 'text', text }] };
    }

    case 'archnav_analyze': {
      const result = await analyze(dir, {});
      saveIndex(dir, result._raw || result);
      return {
        content: [{
          type: 'text',
          text: `✅ Analysis complete: ${result.files} files, ${result.symbols} symbols, ${result.layers} layers, ${result.analysisTime}`,
        }],
      };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

// ═══════════════════════════════════════════════════
//  MCP Server Loop
// ═══════════════════════════════════════════════════

const serverInfo = {
  name: 'archnav',
  version: '1.0.0',
};

process.stdin.setEncoding('utf-8');
let buffer = '';

process.stdin.on('data', async (chunk) => {
  buffer += chunk;

  // MCP uses newline-delimited JSON
  const lines = buffer.split('\n');
  buffer = lines.pop(); // keep incomplete last line

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
        case 'initialize': {
          send(id, {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo,
          });
          break;
        }

        case 'tools/list': {
          send(id, { tools: TOOLS });
          break;
        }

        case 'tools/call': {
          const toolName = request.params?.name;
          const args = request.params?.arguments || {};
          const result = await handleToolCall(toolName, args);
          send(id, { content: result.content, isError: result.isError });
          break;
        }

        case 'notifications/initialized': {
          // Client confirmed initialization — no response needed
          break;
        }

        default:
          sendError(id, ERRORS.METHOD_NOT_FOUND);
      }
    } catch (e) {
      console.error(`[archnav-mcp] Error handling ${method}:`, e.message);
      sendError(id, { ...ERRORS.INTERNAL_ERROR, message: e.message });
    }
  }
});

function send(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
  process.stdout.write(msg);
}

function sendError(id, error) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error }) + '\n';
  process.stdout.write(msg);
}

// Help message if started directly (not via MCP)
const isDirectRun = process.argv.includes('--help') || process.argv.includes('-h');
if (isDirectRun || !process.stdin.isTTY) {
  // Running in MCP mode (stdin piped)
}

console.error(`[archnav-mcp] MCP server started — ${TOOLS.length} tools available`);
console.error(`[archnav-mcp] Tools: ${TOOLS.map(t => t.name).join(', ')}`);
