#!/usr/bin/env node
/**
 * ArchNav — Architecture-Aware Code Navigation for AI Agents
 * 
 * Combines GitNexus-style deep analysis with Graphify-style visualization,
 * adding architecture-level navigation and confidence-based staleness tracking.
 */

import { Command } from 'commander';
import { analyze, saveIndex } from './analyzer.js';
import { archNav } from './navigation.js';
import { readCode } from './reader.js';
import { collectVersionInfo } from './version-info.js';
import { readFile } from 'fs/promises';
import path from 'path';

const pkg = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf-8')
);

const program = new Command();

program
  .name('archnav')
  .description('ArchNav — Architecture-Aware Code Navigation for AI Agents')
  .version(pkg.version);

// === analyze ===
program
  .command('analyze [dir]')
  .description('Analyze a codebase and build architecture knowledge graph')
  .option('--json', 'Output raw JSON')
  .option('--no-cluster', 'Skip community detection')
  .option('--ignore <globs>', 'Comma-separated gitignore-ish globs to exclude (e.g. "bench/** , **/vendor/**"); recorded in the index so status honours them')
  .option('--no-gitignore', 'Do not read the repo .gitignore (by default its lines are added to the ignore list)')
  .action(async (dir, options) => {
    const target = dir || process.cwd();
    const result = await analyze(path.resolve(target), options);
    saveIndex(path.resolve(target), result._raw || result);
    console.log(JSON.stringify(result, null, options.json ? 2 : undefined));
    
    if (!options.json) {
      console.log(`\n📊 ArchNav Analysis Complete`);
      console.log(`   Files: ${result.files}`);
      console.log(`   Symbols: ${result.symbols}`);
      console.log(`   Layers: ${result.architecture?.layers?.length || 0}`);
      console.log(`   Dependencies: ${result.dependencies}`);
      console.log(`\n   Try: archnav arch .        (show architecture map)`);
      console.log(`        archnav locate <name>  (find a symbol)`);
      console.log(`        archnav read <name>    (read a symbol's code)`);
      console.log(`        archnav trace <a> <b>  (trace call path)`);
    }
  });

// === arch ===
program
  .command('arch [dir]')
  .description('Show architecture map (layers, modules, dependencies)')
  .option('--json', 'Output raw JSON')
  .action(async (dir, options) => {
    const target = dir || process.cwd();
    const result = await archNav.architecture(path.resolve(target));
    outputResult(result, options.json);
  });

// === locate ===
program
  .command('locate <name>')
  .description('Locate a symbol (function, class, variable) with line numbers')
  .option('--dir <dir>', 'Project directory', process.cwd())
  .option('--json', 'Output raw JSON')
  .option('--all', 'Show all matches, not just the best')
  .option('--file <file>', 'Disambiguate by file path (exact, suffix or substring match)')
  .option('--kind <kind>', 'Disambiguate by symbol kind (e.g. function, class, method)')
  .action(async (name, options) => {
    const result = await archNav.locate(name, path.resolve(options.dir), {
      all: options.all,
      file: options.file,
      kind: options.kind,
    });
    outputResult(result, options.json);
  });

// === read ===
program
  .command('read <name>')
  .description("Read a symbol's actual source code from disk (verification pattern)")
  .option('--dir <dir>', 'Project directory', process.cwd())
  .option('--lines', 'Show line numbers')
  .option('--json', 'Output raw JSON')
  .action(async (name, options) => {
    const result = await readCode(name, path.resolve(options.dir), { lines: options.lines });
    outputResult(result, options.json);
  });

// === trace ===
program
  .command('trace <from> <to>')
  .description('Trace shortest call path between two symbols through architecture layers')
  .option('--dir <dir>', 'Project directory', process.cwd())
  .option('--json', 'Output raw JSON')
  .action(async (from, to, options) => {
    const result = await archNav.trace(from, to, path.resolve(options.dir));
    outputResult(result, options.json);
  });

// === calls ===
program
  .command('calls <name>')
  .description('Show what a symbol calls (outgoing dependencies)')
  .option('--dir <dir>', 'Project directory', process.cwd())
  .option('--json', 'Output raw JSON')
  .action(async (name, options) => {
    const result = await archNav.calls(name, path.resolve(options.dir));
    outputResult(result, options.json);
  });

// === callers ===
program
  .command('callers <name>')
  .description('Show who calls a symbol (incoming dependencies)')
  .option('--dir <dir>', 'Project directory', process.cwd())
  .option('--json', 'Output raw JSON')
  .option('--file <file>', 'Disambiguate by file path (exact, suffix or substring match)')
  .option('--kind <kind>', 'Disambiguate by symbol kind (e.g. function, class, method)')
  .action(async (name, options) => {
    const result = await archNav.callers(name, path.resolve(options.dir), {
      file: options.file,
      kind: options.kind,
    });
    outputResult(result, options.json);
  });

// === impact ===
program
  .command('impact <symbol>')
  .description('Analyze blast radius: what breaks if this symbol changes')
  .option('--dir <dir>', 'Project directory', process.cwd())
  .option('--json', 'Output raw JSON')
  .option('--file <file>', 'Disambiguate by file path (exact, suffix or substring match)')
  .option('--kind <kind>', 'Disambiguate by symbol kind (e.g. function, class, method)')
  .action(async (symbol, options) => {
    const result = await archNav.impact(symbol, path.resolve(options.dir), {
      file: options.file,
      kind: options.kind,
    });
    outputResult(result, options.json);
  });

// === whereami ===
program
  .command('whereami <file> [line]')
  .description('Show what symbol is at a specific file:line position')
  .option('--dir <dir>', 'Project directory', process.cwd())
  .option('--json', 'Output raw JSON')
  .action(async (file, line, options) => {
    const result = await archNav.whereami(
      path.resolve(options.dir, file),
      line ? parseInt(line) : undefined
    );
    outputResult(result, options.json);
  });

// === status ===
program
  .command('status [dir]')
  .description('Show staleness status of the index vs current code')
  .option('--json', 'Output raw JSON')
  .action(async (dir, options) => {
    const target = dir || process.cwd();
    const result = await archNav.status(path.resolve(target));
    outputResult(result, options.json);
  });

// === version ===
program
  .command('version [dir]')
  .description('Version information of the target repository: git HEAD/branch/tag/dirty, manifest versions, and what the index was built from')
  .option('--json', 'Output raw JSON')
  .action(async (dir, options) => {
    const target = dir || process.cwd();
    const info = await collectVersionInfo(target, { toolVersion: pkg.version });
    if (options.json) {
      console.log(JSON.stringify(info, null, 2));
      return;
    }
    printVersionInfo(info);
  });

// === changes ===
program
  .command('changes [dir]')
  .description('Change-impact analysis: map a diff (or content drift) to the symbols it touches and what breaks')
  .option('--scope <scope>', 'unstaged | staged | all | compare | corpus', 'unstaged')
  .option('--base <ref>', 'Base ref for --scope compare (e.g. main)')
  .option('--json', 'Output raw JSON')
  .action(async (dir, options) => {
    const target = dir || process.cwd();
    const result = await archNav.changes(path.resolve(target), {
      scope: options.scope,
      base: options.base,
    });
    outputResult(result, options.json);
  });

// === mcp ===
program
  .command('mcp')
  .description('Start MCP server (Model Context Protocol — stdio). Use this for Claude Code / Hermes integration')
  .action(async () => {
    const { default: mcpServer } = await import('./mcp-server.js');
  });

// === graph ===
program
  .command('graph [query]')
  .description('Query the knowledge graph — show nodes and relationships')
  .option('--dir <dir>', 'Project directory', process.cwd())
  .option('--json', 'Output raw JSON')
  .option('--depth <n>', 'Traversal depth', '2')
  .action(async (query, options) => {
    const { graphQuery } = await import('./kgraph.js');
    const result = await graphQuery(query, path.resolve(options.dir), { depth: parseInt(options.depth), json: options.json });
    outputResult(result, options.json);
  });

// === flow ===
program
  .command('flow [name]')
  .description('Show data flows through the architecture layers')
  .option('--dir <dir>', 'Project directory', process.cwd())
  .option('--json', 'Output raw JSON')
  .action(async (name, options) => {
    const { showFlows } = await import('./kgraph.js');
    const result = await showFlows(name, path.resolve(options.dir));
    outputResult(result, options.json);
  });

// === export ===
program
  .command('export <format>')
  .description('Export knowledge graph (graph.html, json)')
  .option('--dir <dir>', 'Project directory', process.cwd())
  .option('--out <path>', 'Output file path')
  .action(async (format, options) => {
    const { exportGraph } = await import('./kgraph.js');
    const result = await exportGraph(format, path.resolve(options.dir), options.out);
    if (result.path) console.log(`\n✅ Exported to ${result.path}`);
    else console.log(result.text || JSON.stringify(result, null, 2));
  });

// === compare ===
program
  .command('compare')
  .description('Run benchmark comparing ArchNav vs GitNexus vs Graphify')
  .action(async () => {
    const { runComparison } = await import('./comparison.js');
    await runComparison();
  });

function outputResult(result, jsonMode) {
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Pretty text output
    if (result.error) {
      console.error(`❌ ${result.error}`);
      process.exit(1);
    }
    printFormatted(result);
  }
}

function printFormatted(result) {
  if (result.type === 'architecture') {
    printArchitecture(result);
  } else if (result.type === 'locate') {
    printLocate(result);
  } else if (result.type === 'read') {
    printRead(result);
  } else if (result.type === 'trace') {
    printTrace(result);
  } else if (result.type === 'calls' || result.type === 'callers') {
    printCallGraph(result);
  } else if (result.type === 'impact') {
    printImpact(result);
  } else if (result.type === 'whereami') {
    printWhereami(result);
  } else if (result.type === 'status') {
    printStatus(result);
  } else if (result.type === 'compare') {
    printComparison(result);
  } else if (result.type === 'changes') {
    printChanges(result);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

function printArchitecture(r) {
  console.log(`\n🏗️  Architecture Map: ${r.projectName}`);
  console.log('   ───────────────────────────────────────');
  for (const layer of r.layers) {
    const indicator = layer.violations > 0 ? '⚠️' : '✅';
    console.log(`   ${indicator} ${layer.name}`);
    console.log(`      Pattern: ${layer.pattern}`);
    console.log(`      Files: ${layer.files}`);
    console.log(`      Symbols: ${layer.symbols}`);
    if (layer.dependencies?.length) {
      console.log(`      Depends on: ${layer.dependencies.join(', ')}`);
    }
    if (layer.violations > 0) {
      console.log(`      ⚠️  ${layer.violations} architecture violation(s)`);
    }
    console.log('');
  }
  
  if (r.flows?.length) {
    console.log('   🔄 Data Flows:');
    for (const flow of r.flows) {
      console.log(`      ${flow.name}: ${flow.path.join(' → ')}`);
    }
  }
  console.log('');
}

function printChanges(r) {
  const viaLabel = r.via === 'git' ? `git diff (${r.scope}${r.base ? ` vs ${r.base}` : ''})` : 'content drift vs index';
  console.log(`\n🔀 Change impact — ${r.summary.changed_files} file(s) changed via ${viaLabel}`);
  if (r.note) console.log(`   ⚠️  ${r.note}`);

  if (r.changed_symbols.length) {
    console.log('\n   📝 Changed symbols:');
    for (const s of r.changed_symbols) {
      const conf = typeof s.confidence === 'number' ? ` ${Math.round(s.confidence * 100)}%` : '';
      console.log(`      ${s.symbol} (${s.kind || '?'}) → ${s.file}:${s.line_start ?? '?'}${s.layer ? ` [${s.layer}]` : ''}${conf}`);
    }
  } else {
    console.log('\n   📝 No indexed symbol falls inside the changed lines.');
  }

  const direct = r.direct_impact || [];
  console.log(`\n   🔴 Direct impact (${direct.length}) — will break:`);
  for (const x of direct) {
    console.log(`      ${x.symbol} → ${x.file}:${x.line ?? '?'}${x.via ? ` (via ${x.via})` : ''}${x.kind && x.kind !== 'symbol' ? ` [${x.kind}]` : ''}`);
  }
  if (!direct.length) console.log('      (none)');

  const indirect = r.indirect_impact || [];
  console.log(`\n   🟡 Indirect impact (${indirect.length}) — may break:`);
  for (const x of indirect.slice(0, 20)) {
    const conf = typeof x.confidence === 'number' ? ` ${Math.round(x.confidence * 100)}%` : '';
    console.log(`      ${x.symbol} → ${x.file}:${x.line ?? '?'} (depth ${x.depth}, via ${x.via ?? '?'}) [${x.source_kind || x.kind || '?'}]${conf}`);
  }
  if (indirect.length > 20) console.log(`      … ${indirect.length - 20} more`);
  if (!indirect.length) console.log('      (none)');

  if (r.affected_routes?.length) {
    console.log(`\n   🛣️  Affected routes (${r.affected_routes.length}):`);
    for (const x of r.affected_routes) console.log(`      ${x.symbol} → ${x.file}:${x.line ?? '?'}`);
  }
  if (r.affected_pages?.length) {
    console.log(`\n   📄 Affected pages (${r.affected_pages.length}):`);
    for (const x of r.affected_pages) console.log(`      ${x.symbol} → ${x.file}:${x.line ?? '?'}`);
  }
  if (r.unmapped_files?.length) {
    console.log(`\n   ⚪ Changed but unmapped (${r.unmapped_files.length}) — no symbol covers these lines:`);
    for (const f of r.unmapped_files) console.log(`      ${f}`);
  }
  console.log('');
}

function printAmbiguous(r, relations = r.relations) {
  console.log(`\n⚠️  Ambiguous symbol "${r.symbol}" — ${r.candidates.length} definitions found:`);
  for (const c of r.candidates) {
    console.log(`   ${c.name} (${c.kind || '?'}) → ${c.file}:${c.line}`);
  }
  if (r.risk) printRisk(r);
  // The graph already aggregated across every definition — showing the
  // candidates and stopping hid 22 real callers behind a "narrow this down"
  // hint. Print what was found, then say how to narrow it.
  if (relations?.length) {
    console.log(`\n   Aggregated across all ${r.candidates.length} definitions (${relations.length}):`);
    for (const rel of relations) {
      const conf = rel.confidence < 1 ? ` ⚠️${(rel.confidence * 100).toFixed(0)}%` : '';
      console.log(`      ${rel.symbol} → ${rel.file}:${rel.line} [${rel.layer || '?'}]${conf}`);
    }
  }
  console.log(`\n   Narrow it down with --file <path> and/or --kind <kind>`);
  console.log('');
}

function printLocate(r) {
  if (r.ambiguous) return printAmbiguous(r);
  const s = r.symbol;
  if (r.confidence < 0.5) {
    console.log(`⚠️  Low confidence (${(r.confidence * 100).toFixed(0)}%)`);
  }
  console.log(`📌 ${s.name}`);
  if (s.kind) console.log(`   Kind: ${s.kind}`);
  console.log(`   File: ${s.file}`);
  if (s.line_start) console.log(`   Lines: ${s.line_start}–${s.line_end} (${s.line_end - s.line_start + 1} lines)`);
  if (s.signature) console.log(`   Signature: ${s.signature}`);
  if (r.layer) console.log(`   Layer: ${r.layer}`);
  console.log(`   Confidence: ${(r.confidence * 100).toFixed(0)}%`);
  
  if (r.alternatives?.length > 0) {
    console.log(`\n   Also found:`);
    for (const alt of r.alternatives) {
      console.log(`      ${alt.name} → ${alt.file}:${alt.line_start}`);
    }
  }
  console.log('');
}

function printRead(r) {
  if (r.confidence < 0.5) {
    console.log(`⚠️  Low confidence locate — verify accuracy`);
  }
  if (r.code) {
    if (r.lines) {
      const lines = r.code.split('\n');
      const startLine = r.line_start || 1;
      for (let i = 0; i < lines.length; i++) {
        const lineNum = String(startLine + i).padStart(4, ' ');
        console.log(`   ${lineNum}| ${lines[i]}`);
      }
    } else {
      console.log(`${r.code}`);
    }
    console.log(`\n   📍 ${r.file}:${r.line_start}–${r.line_end || '?'}`);
    console.log(`   Confidence: ${(r.confidence * 100).toFixed(0)}%`);
  } else {
    console.log(`❌ Symbol not found in source`);
  }
}

function printTrace(r) {
  console.log(`\n🔍 Trace: ${r.from} → ${r.to}`);
  if (!r.path?.length) {
    console.log('   No path found');
    return;
  }
  
  for (let i = 0; i < r.path.length; i++) {
    const step = r.path[i];
    const prefix = i === 0 ? '┌─' : i === r.path.length - 1 ? '└─' : '├─';
    const conf = step.confidence < 1 ? ` ⚠️${(step.confidence * 100).toFixed(0)}%` : '';
    console.log(`   ${prefix} ${step.symbol} (${step.file}:${step.line}) [${step.layer}]${conf}`);
    if (i < r.path.length - 1) {
      console.log(`   │  ↓ ${step.call_type || 'calls'}`);
    }
  }
  
  if (r.crossesLayers) {
    console.log(`\n   🏗️  Crosses layers: ${r.crossesLayers.join(' → ')}`);
  }
}

function printCallGraph(r) {
  if (r.ambiguous) return printAmbiguous(r);
  const header = r.type === 'calls' ? `🔽 ${r.symbol} calls:` : `🔼 ${r.symbol} is called by:`;
  console.log(`\n${header}`);
  
  if (!r.relations?.length) {
    console.log('   (none)');
    return;
  }
  
  for (const rel of r.relations) {
    const conf = rel.confidence < 1 ? ` ⚠️${(rel.confidence * 100).toFixed(0)}%` : '';
    console.log(`   ${rel.symbol} → ${rel.file}:${rel.line} [${rel.layer}]${conf}`);
  }
}

const RISK_BADGE = { LOW: '🟢', MEDIUM: '🟡', HIGH: '🟠', CRITICAL: '🔴', UNKNOWN: '❔' };

/** Print the four-tier verdict and, crucially, the reasons that produced it. */
function printRisk(r) {
  const risk = r && r.risk;
  if (!risk) return;
  const badge = RISK_BADGE[risk.level] || '•';
  console.log(`   ${badge} Risk: ${risk.level}  (${risk.files} files · ${risk.apps} apps · ${risk.indirect} indirect)`);
  for (const why of risk.reasons || []) console.log(`      · ${why}`);
  if (risk.note) console.log(`      ⚠️ ${risk.note}`);
}

function printImpact(r) {
  if (r.ambiguous) return printAmbiguous(r, r.direct_impact);
  console.log(`\n💥 Impact Analysis: ${r.symbol}`);
  console.log(`   Layer: ${r.layer}`);
  console.log(`   File: ${r.file}:${r.line_start}`);
  printRisk(r);
  
  if (r.direct_impact?.length) {
    console.log(`\n   🔴 Direct impact (will break):`);
    for (const item of r.direct_impact) {
      console.log(`      ${item.symbol} → ${item.file}:${item.line}`);
    }
  }
  
  if (r.indirect_impact?.length) {
    console.log(`\n   🟡 Indirect impact (may break):`);
    for (const item of r.indirect_impact) {
      console.log(`      ${item.symbol} → ${item.file}:${item.line}`);
    }
  }
  
  if (r.suggested_tests?.length) {
    console.log(`\n   🧪 Test files to update:`);
    for (const t of r.suggested_tests) {
      console.log(`      ${t}`);
    }
  }
  
  console.log(`\n   Confidence: ${(r.confidence * 100).toFixed(0)}%`);
}

function printWhereami(r) {
  console.log(`\n📍 ${r.file}:${r.line}`);
  if (r.symbol) {
    console.log(`   Symbol: ${r.symbol} (${r.kind})`);
    console.log(`   Enclosing: ${r.enclosing || '(top-level)'}`);
    console.log(`   Layer: ${r.layer || '(unknown)'}`);
  } else {
    console.log(`   No symbol found at this position`);
  }
}

function printVersionInfo(v) {
  const r = v.repo || {};
  console.log(`\n🏷️  Version info — ${v.repo?.dir || '?'}`);
  console.log(`   ArchNav:        ${v.tool?.version || '?'} (node ${v.tool?.node || '?'})`);
  if (r.is_git) {
    console.log(`   Git HEAD:       ${r.short || '?'}${r.exact_tag ? `  (tag ${r.exact_tag})` : r.tag ? `  (nearest tag ${r.tag})` : ''}`);
    console.log(`   Branch:         ${r.branch || '?'}${r.dirty ? `  ⚠️  ${r.dirty_files} uncommitted file(s)` : '  ✅ clean worktree'}`);
    console.log(`   Last commit:    ${r.date || '?'}  ${r.author || '?'}  ${r.subject || ''}`);
    console.log(`   History:        ${r.commits ?? '?'} commit(s)${r.describe ? `, ${r.describe}` : ''}`);
  } else {
    console.log(`   Git:            (not a git repository — no commit-level version available)`);
  }
  const manifests = Object.entries(v.manifests || {});
  if (manifests.length) {
    console.log(`   Manifests:`);
    for (const [file, m] of manifests) {
      const bits = [m.name, m.version ? `v${m.version}` : null, m.go ? `go ${m.go}` : null].filter(Boolean).join(' ');
      console.log(`      ${file.padEnd(14)} ${bits || '(no version field)'}`);
    }
  }
  if (v.index) {
    const i = v.index;
    console.log(`   Index:          built from ${i.indexed_commit?.substring(0, 8) || 'N/A'} (age ${i.age || '?'})`);
    console.log(`   Index vs HEAD:  ${i.matches_head ? '✅ same commit' : '⚠️  index is from a different commit'}${i.stale ? `, ${i.changed_files} file(s) drifted` : ', content fresh'}`);
  } else {
    console.log(`   Index:          (none — run \`archnav analyze\` first)`);
  }
}

function printStatus(r) {
  console.log(`\n📊 Index Staleness Report: ${r.project}`);
  console.log(`   Indexed commit: ${r.indexedCommit?.substring(0, 8) || 'N/A'}`);
  console.log(`   Current HEAD:   ${r.currentHead?.substring(0, 8) || 'N/A'}`);
  console.log(`   Index age:     ${r.indexAge || 'N/A'}`);
  
  if (r.stale) {
    console.log(`\n   ⚠️  Index is STALE (${r.changedFiles} file(s) changed)`);
    console.log(`   Overall confidence: ${(r.overallConfidence * 100).toFixed(0)}%`);
    
    if (r.changedDetails?.length) {
      console.log(`\n   Changed files:`);
      for (const f of r.changedDetails) {
        console.log(`      ${f.file} — ${
          f.symbolsAffected > 0 ? `${f.symbolsAffected} symbol(s) affected` : 'no symbols changed'
        }`);
      }
    }
  } else {
    console.log(`\n   ✅ Index is fresh`);
    if (r.warnings?.length) {
      for (const w of r.warnings) {
        console.log(`   ⚠️  ${w}`);
      }
    }
  }
}

function printComparison(r) {
  console.log(`\n📊 ArchNav vs GitNexus vs Graphify — Comparison Results`);
  console.log('   ================================================');
  
  for (const test of r.tests) {
    console.log(`\n   📝 ${test.name}`);
    console.log(`      ${test.description}`);
    console.log('');
    
    for (const [tool, result] of Object.entries(test.results)) {
      const statusIcon = result.status === 'pass' ? '✅' : result.status === 'partial' ? '🟡' : '❌';
      console.log(`      ${statusIcon} ${tool}:`);
      console.log(`         ${result.summary}`);
      if (result.details) {
        for (const d of result.details) {
          console.log(`         ${d}`);
        }
      }
    }
  }
}

program.parse(process.argv);
