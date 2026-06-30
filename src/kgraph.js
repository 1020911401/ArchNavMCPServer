/**
 * Knowledge Graph Module — graph, flow, export commands for ArchNav
 * 
 * Works with the knowledgeGraph from analyzer.js which has:
 *   nodes: [{ id, type, name, ... }]
 *   edges: [{ from, to, type, ... }]
 */
import fs from 'fs';
import path from 'path';
import { getIndex } from './analyzer.js';

/**
 * Query the knowledge graph
 * If query is provided, find matching nodes and BFS traverse;
 * if empty, show graph summary
 */
export async function graphQuery(query, dirPath, options = {}) {
  const index = getIndex(dirPath);
  if (!index) return { type: 'graph', error: 'No index. Run "archnav analyze ." first' };

  const kg = index.knowledgeGraph || { nodes: [], edges: [] };
  const { nodes, edges } = kg;

  if (!query) {
    // Show summary
    return summarizeGraph(nodes, edges);
  }

  // Search: find nodes matching the query
  const q = query.toLowerCase();
  const matched = nodes.filter(n =>
    n.name?.toLowerCase().includes(q) ||
    n.type?.toLowerCase().includes(q) ||
    n.id?.toLowerCase().includes(q)
  );

  if (matched.length === 0) {
    // Try by type
    const byType = nodes.filter(n => n.type === query);
    if (byType.length > 0) {
      return listNodesByType(byType, nodes, edges, options);
    }
    return { type: 'graph', error: `No nodes matching "${query}"` };
  }

  // BFS from matched nodes
  const visitedIds = new Set();
  const resultNodes = [];
  const resultEdges = [];
  const edgeIds = new Set();

  function edgeKey(e) { return `${e.from}→${e.to}:${e.type}`; }

  // Build adjacency for forward + reverse traversal
  const adj = {};
  const radj = {};
  for (const e of edges) {
    (adj[e.from] = adj[e.from] || []).push(e);
    (radj[e.to] = radj[e.to] || []).push(e);
  }

  const depth = options.depth || 2;
  const queue = matched.map(n => ({ node: n, dist: 0 }));
  for (const m of matched) visitedIds.add(m.id);

  while (queue.length > 0) {
    const { node, dist } = queue.shift();
    resultNodes.push(node);

    if (dist >= depth) continue;

    // Forward edges
    for (const e of (adj[node.id] || [])) {
      const target = nodes.find(n => n.id === e.to);
      if (target && !visitedIds.has(target.id)) {
        visitedIds.add(target.id);
        queue.push({ node: target, dist: dist + 1 });
      }
      if (!edgeIds.has(edgeKey(e))) {
        edgeIds.add(edgeKey(e));
        resultEdges.push(e);
      }
    }
    // Reverse edges
    for (const e of (radj[node.id] || [])) {
      const source = nodes.find(n => n.id === e.from);
      if (source && !visitedIds.has(source.id)) {
        visitedIds.add(source.id);
        queue.push({ node: source, dist: dist + 1 });
      }
      if (!edgeIds.has(edgeKey(e))) {
        edgeIds.add(edgeKey(e));
        resultEdges.push(e);
      }
    }
  }

  return {
    type: 'graph',
    query,
    matched: matched.length,
    total: resultNodes.length,
    nodes: resultNodes,
    edges: resultEdges,
    nodeCount: resultNodes.length,
    edgeCount: resultEdges.length,
  };
}

/**
 * Show data flows
 */
export async function showFlows(flowName, dirPath) {
  const index = getIndex(dirPath);
  if (!index) return { type: 'flow', error: 'No index' };

  const kg = index.knowledgeGraph || { nodes: [], edges: [] };
  const flows = index.flows || [];

  if (!flows.length) return { type: 'flow', error: 'No data flows detected' };

  if (!flowName) {
    return {
      type: 'flow',
      flows: flows.map(f => ({
        name: f.name,
        path: f.path,
        steps: f.path?.length || 0,
      })),
    };
  }

  // Find specific flow
  const flow = flows.find(f => f.name.toLowerCase().includes(flowName.toLowerCase()));
  if (!flow) return { type: 'flow', error: `Flow "${flowName}" not found` };

  // Build enriched flow with architecture layers
  const layerMap = index.layerMap || {};
  const enriched = flow.path.map(step => {
    const symbolName = step.split(' ')[0];
    return {
      step,
      layer: layerMap[symbolName] || 'unknown',
    };
  });

  return {
    type: 'flow',
    name: flow.name,
    steps: enriched,
  };
}

/**
 * Export knowledge graph to various formats
 */
export async function exportGraph(format, dirPath, outputPath) {
  const index = getIndex(dirPath);
  if (!index) return { error: 'No index' };

  const kg = index.knowledgeGraph || { nodes: [], edges: [] };

  switch (format) {
    case 'json': {
      const out = outputPath || path.join(dirPath, '.archnav', 'knowledge-graph.json');
      fs.writeFileSync(out, JSON.stringify(kg, null, 2));
      return { path: out };
    }

    case 'graph.html': {
      const out = outputPath || path.join(dirPath, 'archnav-graph.html');
      const html = generateGraphHTML(kg, path.basename(dirPath));
      fs.writeFileSync(out, html);
      return { path: out };
    }

    default:
      return { error: `Unknown export format: ${format}. Supported: json, graph.html` };
  }
}

// ═══════════════════════════════════════════════
//  Formatting Helpers
// ═══════════════════════════════════════════════

function summarizeGraph(nodes, edges) {
  const types = {};
  for (const n of nodes) {
    types[n.type] = (types[n.type] || 0) + 1;
  }
  const edgeTypes = {};
  for (const e of edges) {
    edgeTypes[e.type] = (edgeTypes[e.type] || 0) + 1;
  }

  return {
    type: 'graph',
    summary: true,
    totalNodes: nodes.length,
    totalEdges: edges.length,
    nodesByType: types,
    edgesByType: edgeTypes,
    text: `📊 Knowledge Graph: ${nodes.length} nodes, ${edges.length} edges\n` +
      Object.entries(types).map(([t, c]) => `   ${t}: ${c}`).join('\n'),
  };
}

function listNodesByType(nodes, allNodes, allEdges, options) {
  const byName = {};
  for (const n of nodes) {
    const container = byName[n.type] || (byName[n.type] = []);
    const incoming = allEdges.filter(e => e.to === n.id).length;
    const outgoing = allEdges.filter(e => e.from === n.id).length;
    container.push({ name: n.name, id: n.id, incoming, outgoing });
  }
  return {
    type: 'graph',
    nodesByType: byName,
  };
}

// ═══════════════════════════════════════════════
//  Interactive HTML Graph Visualization
// ═══════════════════════════════════════════════

function generateGraphHTML(kg, projectName) {
  const { nodes, edges } = kg;

  // Build D3-compatible data
  const colors = {
    file: '#4fc3f7',
    directory: '#81c784',
    layer: '#ffb74d',
    community: '#ce93d8',
    flow: '#ef5350',
    symbol: '#7c4dff',
    package: '#26c6da',
    variable: '#78909c',
    route: '#ff7043',
    anonymous: '#a1887f',
    export: '#66bb6a',
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ArchNav — ${projectName}</title>
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: system-ui, -apple-system, sans-serif; background: #0d1117; color: #c9d1d9; }
#header { padding: 16px 24px; background: #161b22; border-bottom: 1px solid #30363d; }
#header h1 { font-size: 18px; font-weight: 600; }
#header span { color: #8b949e; font-size: 14px; margin-left: 12px; }
#graph { width: 100vw; height: calc(100vh - 56px); }
.node circle { stroke: #fff; stroke-width: 1.5px; cursor: pointer; }
.node text { font-size: 11px; fill: #c9d1d9; pointer-events: none; }
.link { stroke: #30363d; stroke-opacity: 0.6; }
.link-label { font-size: 9px; fill: #8b949e; }
#tooltip { position: absolute; display: none; background: #161b22; border: 1px solid #30363d;
  border-radius: 8px; padding: 10px 14px; font-size: 13px; max-width: 300px; pointer-events: none; }
#tooltip .tt-name { font-weight: 600; margin-bottom: 4px; }
#tooltip .tt-meta { color: #8b949e; font-size: 12px; }
.legend { position: absolute; bottom: 16px; right: 16px; background: #161b22; border: 1px solid #30363d;
  border-radius: 8px; padding: 12px; font-size: 12px; display: flex; flex-direction: column; gap: 6px; }
.legend-item { display: flex; align-items: center; gap: 8px; }
.legend-dot { width: 12px; height: 12px; border-radius: 50%; }
</style>
</head>
<body>
<div id="header">
  <h1>🏗️ ${projectName} <span>${nodes.length} nodes · ${edges.length} edges</span></h1>
</div>
<div id="graph"></div>
<div id="tooltip"></div>
<div class="legend">
  ${Object.entries(colors).map(([k, v]) =>
    `<div class="legend-item"><div class="legend-dot" style="background:${v}"></div>${k}</div>`
  ).join('')}
</div>
<script>
const nodes = ${JSON.stringify(nodes.map(n => ({
  id: n.id, name: n.name, type: n.type,
  fileCount: n.fileCount, priority: n.priority, path: n.path
})))};

const edges = ${JSON.stringify(edges.map(e => ({
  source: e.from, target: e.to, type: e.type, weight: e.weight || 1
})))};

const colors = ${JSON.stringify(colors)};

const width = window.innerWidth, height = window.innerHeight - 56;

const svg = d3.select('#graph').append('svg')
  .attr('width', width).attr('height', height)
  .call(d3.zoom().on('zoom', (e) => g.attr('transform', e.transform)));

const g = svg.append('g');

const sim = d3.forceSimulation(nodes)
  .force('link', d3.forceLink(edges).id(d => d.id).distance(80))
  .force('charge', d3.forceManyBody().strength(-200))
  .force('center', d3.forceCenter(width/2, height/2))
  .force('collision', d3.forceCollide(30));

const link = g.append('g').selectAll('line').data(edges).join('line')
  .attr('class', 'link').attr('stroke-width', d => Math.min(d.weight * 2, 4));

const node = g.append('g').selectAll('g').data(nodes).join('g').attr('class', 'node')
  .call(d3.drag().on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
    .on('end', (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

node.append('circle').attr('r', 8).attr('fill', d => colors[d.type] || '#888');

node.append('text').text(d => d.name.length > 20 ? d.name.slice(0, 18) + '..' : d.name)
  .attr('x', 12).attr('y', 4);

const tip = d3.select('#tooltip');
node.on('mouseover', (e, d) => {
  tip.style('display', 'block')
    .html('<div class="tt-name">' + d.name + '</div><div class="tt-meta">Type: ' + d.type +
      (d.path ? '<br>Path: ' + d.path : '') +
      (d.fileCount ? '<br>Files: ' + d.fileCount : '') +
      (d.priority ? '<br>Priority: ' + d.priority : '') + '</div>')
    .style('left', (e.pageX + 12) + 'px').style('top', (e.pageY - 10) + 'px');
}).on('mouseout', () => tip.style('display', 'none'));

sim.on('tick', () => {
  link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
  node.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
});
</script>
</body>
</html>`;
}
