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
import { resolveHandlerShape, shapeIsComparable, collectFrontendReads, searchResponseKey } from './response-shape.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const JSON_OUT = process.argv.includes('--json');
// `--depth3` adds the M4 section (charter §2.3): would a THIRD hop resolve the
// depth-cap cases, and — the gate's actual question — do those keys agree with what
// the client reads? Report only; the gate stays closed on this evidence.
const DEPTH3 = process.argv.includes('--depth3');
// `--stage2` adds the M5 section (charter §2.4): of the pairs the gate refuses, how many
// frontend reads resolve — and of those fields, how many are declared NOWHERE in the
// backend (confirmed defect) vs declared in another handler (pairing question)?
const STAGE2 = process.argv.includes('--stage2');
const FRONT = path.resolve(args[0] || '');
const BACK = path.resolve(args[1] || '');

if (!args[0] || !args[1] || !fs.existsSync(FRONT) || !fs.existsSync(BACK)) {
  console.error('usage: node scripts/shape-coverage.mjs <frontendDir> <backendDir> [--json] [--depth3] [--stage2]');
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

// `--depth3` — the M4 section (charter §2.3): does a THIRD hop resolve the depth-cap
// cases, and — the gate's real question — do those keys agree with what the client
// reads? Agreement is the only evidence that could open the gate; without it the hop
// stays outside `COMPARABLE_LEVELS` no matter how many pairs it resolves.
let m4 = null;
if (DEPTH3) {
  m4 = {
    depthCapAt2: 0, repoAt3: 0, readable: 0,
    fullAgreement: 0, partialAgreement: 0, noAgreement: 0,
    fieldsTotal: 0, fieldsMatched: 0, stopReasons: {}, samples: [],
  };
  for (const p of pairs) {
    const d2 = resolveHandlerShape({ root: BACK, controller: p.be.controller, action: p.be.action });
    if (!(d2.level === 'unresolved' && d2.reason === 'depth-cap')) continue;
    m4.depthCapAt2 += 1;
    const d3 = resolveHandlerShape({ root: BACK, controller: p.be.controller, action: p.be.action, maxDepth: 3 });
    if (d3.level !== 'repo') {
      m4.stopReasons[d3.reason || '?'] = (m4.stopReasons[d3.reason || '?'] || 0) + 1;
      continue;
    }
    m4.repoAt3 += 1;
    const reads = collectFrontendReads({ root: FRONT, method: p.fe.method, path: p.fe.path });
    if (reads.level !== 'resolved') continue;
    m4.readable += 1;
    const keySet = new Set(d3.keys);
    const fields = [...new Set(reads.reads.map((r) => r.field))];
    const hit = fields.filter((f) => keySet.has(f)).length;
    m4.fieldsTotal += fields.length;
    m4.fieldsMatched += hit;
    if (hit === fields.length) m4.fullAgreement += 1;
    else if (hit > 0) m4.partialAgreement += 1;
    else m4.noAgreement += 1;
    m4.samples.push({
      endpoint: `${p.fe.method} ${p.fe.path}`,
      handler: `${p.be.controller}@${p.be.action}`,
      keys: d3.keys.slice(0, 8), reads: fields.slice(0, 8),
      agreement: `${hit}/${fields.length}`, via: d3.via,
    });
  }
}

// `--stage2` — the M5 section (charter §2.4): of the pairs the gate refuses, which
// frontend reads resolve, and does the field exist anywhere in the backend at all?
let stage2 = null;
if (STAGE2) {
  stage2 = {
    comparablePairs: 0, refusedWithReads: 0, refusedNoReads: 0,
    confirmed: [], declaredElsewhere: [], scannedFiles: 0,
  };
  for (const p of pairs) {
    const shape = resolveHandlerShape({ root: BACK, controller: p.be.controller, action: p.be.action });
    if (shapeIsComparable(shape)) { stage2.comparablePairs += 1; continue; }
    const reads = collectFrontendReads({ root: FRONT, method: p.fe.method, path: p.fe.path });
    if (reads.level !== 'resolved') { stage2.refusedNoReads += 1; continue; }
    stage2.refusedWithReads += 1;
    for (const field of [...new Set(reads.reads.map((x) => x.field))]) {
      const decl = searchResponseKey({ root: BACK, field });
      stage2.scannedFiles = decl.scannedFiles;
      const base = {
        endpoint: `${p.fe.method} ${p.fe.path}`,
        handler: `${p.be.controller}@${p.be.action}`,
        field,
        readAt: reads.reads.find((x) => x.field === field),
        shapeReason: shape.reason || shape.level,
      };
      if (decl.declared === 0) stage2.confirmed.push(base);
      else stage2.declaredElsewhere.push({ ...base, sites: decl.sites.slice(0, 2) });
    }
  }
}

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
  ...(m4 ? { depth3: m4 } : {}),
  ...(stage2 ? { stage2 } : {}),
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

  if (m4) {
    console.log(`\n--- M4 / depth 3 (charter §2.3) ---`);
    console.log(`depth-cap at depth 2:      ${m4.depthCapAt2}`);
    console.log(`resolved by a 3rd hop:     ${m4.repoAt3}`);
    console.log(`…with readable frontend:   ${m4.readable}   <- agreement needs at least one of these`);
    if (m4.readable) {
      const pct = Math.round((m4.fullAgreement * 100) / m4.readable);
      console.log(`full agreement:            ${m4.fullAgreement}/${m4.readable} = ${pct}%  (partial=${m4.partialAgreement}, none=${m4.noAgreement})`);
      console.log(`field agreement:           ${m4.fieldsMatched}/${m4.fieldsTotal}`);
      for (const s of m4.samples.slice(0, 5)) {
        console.log(`  ${s.endpoint}  agreement=${s.agreement}`);
        console.log(`     keys:  ${s.keys.join(', ')}`);
        console.log(`     reads: ${s.reads.join(', ')}`);
      }
    } else {
      console.log('agreement evidence: NONE — the gate cannot be opened on this data (§2.3)');
    }
    console.log('other depth-cap pairs stay unresolved because:');
    for (const [k, v] of Object.entries(m4.stopReasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
  }

  if (stage2) {
    console.log(`\n--- M5 / second stage (charter §2.4) ---`);
    console.log(`gate could compare:        ${stage2.comparablePairs}`);
    console.log(`gate refused, reads ok:    ${stage2.refusedWithReads}   <- declaration search applies`);
    console.log(`gate refused, no reads:    ${stage2.refusedNoReads}`);
    console.log(`confirmed (0 declarations in ${stage2.scannedFiles} php files): ${stage2.confirmed.length}`);
    for (const c of stage2.confirmed.slice(0, 8)) {
      console.log(`  ${c.endpoint}  ->  ${c.handler}  field=${c.field}   (shape: ${c.shapeReason})`);
      console.log(`     read at ${c.readAt.file}:${c.readAt.line}`);
    }
    console.log(`declared elsewhere (pairing question): ${stage2.declaredElsewhere.length}`);
    for (const d of stage2.declaredElsewhere.slice(0, 6)) {
      console.log(`  ${d.endpoint}  field=${d.field}  declared at ${d.sites.map((s) => `${s.file}:${s.line}`).join(', ')}`);
    }
  }
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
