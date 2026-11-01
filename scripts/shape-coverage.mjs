#!/usr/bin/env node
/**
 * shape-coverage.mjs — how much of the response shape does resolveHandlerShape get on
 * a real front/back pair? (docs/shape-check.md §4.3)
 *
 *   node scripts/shape-coverage.mjs <frontendDir> <backendDir>
 *
 * Read-only: extracts frontend calls with review-rules' own extractor, backend routes
 * with the Laravel route parser, and resolves each matched pair. Numbers must be
 * stamped with a date + route count: the pair measured here is live production code and
 * moved 145 -> 155 routes inside one session (2026-10-30), which is why the charter
 * quotes a timestamp next to every coverage figure.
 *
 * Exit 0 always — this reports, it does not gate. `--json` for machines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { extractFrontCalls, pathMatches } from './review-rules.mjs';
import { extractLaravelRoutes } from '../src/parsers/laravelRoutes.js';
import { resolveHandlerShape, shapeIsComparable } from './response-shape.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const JSON_OUT = process.argv.includes('--json');
const FRONT = path.resolve(args[0] || '');
const BACK = path.resolve(args[1] || '');

if (!args[0] || !args[1] || !fs.existsSync(FRONT) || !fs.existsSync(BACK)) {
  console.error('usage: node scripts/shape-coverage.mjs <frontendDir> <backendDir> [--json]');
  process.exit(2);
}

// `extractLaravelRoutes` lives in the parser module, not review-rules
const routes = extractLaravelRoutes(BACK).routes;

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const files = walk(FRONT, [], 8).filter((f) => /\.(vue|js|ts)$/i.test(f));
const calls = extractFrontCalls(files, read);
const uniq = [...new Map(calls.map((c) => [`${c.method} ${c.path}`, c])).values()];

const pairs = uniq
  .map((fe) => ({ fe, be: routes.find((r) => (r.method === fe.method || r.method === 'ANY') && pathMatches(r.uri, fe.path)) }))
  .filter((p) => p.be);

const counts = { local: 0, service: 0, unresolved: 0 };
const reasons = {};
const refused = { partial: 0, wrapper: 0 };
let comparable = 0;
const detail = [];
for (const p of pairs) {
  const r = resolveHandlerShape({ root: BACK, controller: p.be.controller, action: p.be.action });
  counts[r.level] += 1;
  if (r.level === 'unresolved') reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  // the SAME predicate the rule uses — a coverage number the rule cannot act on is noise
  if (shapeIsComparable(r)) comparable += 1;
  else if (r.partial) refused.partial += 1;
  else if (r.keys && r.keys.includes('data')) refused.wrapper += 1;
  detail.push({ pair: `${p.fe.method} ${p.fe.path}`, handler: `${p.be.controller}@${p.be.action}`, level: r.level, comparable: shapeIsComparable(r), partial: !!r.partial, keys: r.keys, via: r.via, reason: r.reason });
}

const total = pairs.length;
const resolved = counts.local + counts.service;
const report = {
  when: new Date().toISOString(),
  frontend: FRONT,
  backend: BACK,
  backendRoutes: routes.length,
  matchedPairs: total,
  local: counts.local,
  service: counts.service,
  unresolved: counts.unresolved,
  resolvedPct: total ? Math.round((resolved * 100) / total) : 0,
  // what `fe-be-shape-field-missing` can actually check backend-side (the frontend has
  // to resolve too, so the rule's number is this one minus frontend-unresolved pairs)
  comparable,
  comparablePct: total ? Math.round((comparable * 100) / total) : 0,
  refused,
  reasons,
};

if (JSON_OUT) {
  console.log(JSON.stringify({ ...report, detail }, null, 2));
} else {
  console.log(`=== shape coverage — ${report.when}, ${routes.length} backend routes ===`);
  console.log(`pair: ${BACK}  <-  ${FRONT}`);
  console.log(`matched pairs: ${total}   unique static frontend paths: ${new Set(calls.filter((c) => !c.dynamic).map((c) => c.path)).size}`);
  console.log(`local      ${counts.local}  (${((counts.local * 100) / total).toFixed(0)}%)`);
  console.log(`service    ${counts.service}  (${((counts.service * 100) / total).toFixed(0)}%)`);
  console.log(`unresolved ${counts.unresolved}  (${((counts.unresolved * 100) / total).toFixed(0)}%)`);
  console.log(`resolved   ${resolved}/${total} = ${report.resolvedPct}%   <- resolver coverage (docs §2.1)`);
  console.log(`comparable ${comparable}/${total} = ${report.comparablePct}%   <- the rule's own bar (shapeIsComparable)`);
  console.log(`refused by guard: partial=${refused.partial}  wrapper-data=${refused.wrapper}`);
  console.log('\nunresolved reasons:');
  for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
}
process.exit(0);

function walk(dir, out = [], depth = 8) {
  if (out.length > 12000 || depth < 0) return out;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/node_modules|vendor|^\.git$|^dist$|unpackage/.test(e.name)) continue;
      walk(p, out, depth - 1);
    } else if (e.isFile()) out.push(p);
  }
  return out;
}
