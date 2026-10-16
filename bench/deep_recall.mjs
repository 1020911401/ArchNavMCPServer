#!/usr/bin/env node
/**
 * bench/deep_recall.mjs — depth-2 (indirect) recall test.
 *
 * The 1-hop benchmark (run_bench.mjs) and the width comparison (multi_dim.mjs)
 * both stop at "who calls this symbol directly". Neither ever validated the
 * *content* of the indirect layer — impact was only compared by row count.
 * This harness computes an INDEPENDENT 2-hop ground truth from the working tree
 * and checks each engine's depth-2 output against it.
 *
 * Truth construction (no engine involved):
 *   1. depth1 = groundTruth(repo, sym).callSites        (call-site detection)
 *   2. for each depth-1 call site, scan upward to the nearest definition line
 *      -> the ENCLOSING symbol that makes the call
 *   3. depth2 = union over those enclosing symbols of groundTruth(repo, S).callerFiles
 *      (minus the depth-1 files)
 *   4. route layer: route lines in routes/*.php whose action is an enclosing
 *      symbol ('Ctrl@method' or [Ctrl::class, 'method']) — a route is a real
 *      depth-2 dependant that no call-syntax regex can see.
 *
 * Engine depth-2 extraction:
 *   ArchNav   indirect_impact[] rows with depth === 2
 *   GitNexus  byDepth["2"][]
 *   CodeGraph has NO depth labels — its `affected` is a flat closure, so it is
 *   compared against depth1 ∪ depth2 and reported as unlabelled.
 *
 * Usage: node bench/deep_recall.mjs [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { groundTruth } from './gen_ground_truth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const AS_JSON = process.argv.includes('--json');

function run(cmd, { cwd = ROOT, timeout = 180_000 } = {}) {
  const r = spawnSync(cmd, {
    cwd, shell: true, timeout, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024, windowsHide: true,
  });
  return { out: `${r.stdout ?? ''}${r.stderr ? '\n' + r.stderr : ''}`, err: r.error?.code || (r.status ? `exit ${r.status}` : null) };
}

const posix = (p) => (p ? String(p).replace(/\\/g, '/').replace(/^\.\//, '') : null);
const uniq = (a) => [...new Set(a.filter(Boolean))];

function json(text) {
  if (!text) return null;
  const oi = text.indexOf('{'), ai = text.indexOf('[');
  let s = -1, e = -1;
  if (ai !== -1 && (oi === -1 || ai < oi)) { s = ai; e = text.lastIndexOf(']'); }
  else if (oi !== -1) { s = oi; e = text.lastIndexOf('}'); }
  if (s === -1 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

const DEF_RE = /^\s*(?:(?:public|private|protected|static|final|abstract|readonly)\s+)*function\s+([A-Za-z_]\w*)\s*\(|^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(|^\s*([A-Za-z_]\w*)\s*\([^)]*\)\s*\{|^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s+)?(?:function\b|\()/;
// Control-flow keywords match the method-shorthand branch of DEF_RE. Without this
// blacklist the "innermost enclosing definition" scan returns `if`, and the whole
// depth-2 truth degenerates into "callers of if" (measured: 272 junk files).
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'foreach', 'else', 'do', 'try', 'return', 'function', 'typeof', 'await']);

/** Nearest definition at or above `line` (1-based) in file `rel`. */
function enclosingSymbol(repoDir, rel, line) {
  let text;
  try { text = fs.readFileSync(path.join(repoDir, rel), 'utf8'); } catch { return null; }
  const lines = text.split(/\r?\n/);
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const m = lines[i].match(DEF_RE);
    if (!m) continue;
    const name = m[1] || m[2] || m[3] || m[4];
    if (!name || KEYWORDS.has(name)) continue;
    return { name, at: i + 1 };
  }
  return null;
}

/** All source files under repoDir (posix, repo-relative). */
function walkRepo(dir, base = dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkRepo(full, base, out);
    else if (/\.(php|vue|js|mjs|ts)$/i.test(e.name)) out.push(posix(path.relative(base, full)));
  }
  return out;
}

/**
 * Route hops: a route line whose (controller, action) resolves to a file that is
 * a depth-1 caller. This is an unambiguous 2-hop chain —
 *   departments <- member(AnalysesController) <- "GET /analysis/member"
 * — that no call-syntax regex can see, and it is precise (no name collisions).
 */
function routeHops(repoDir, d1) {
  const byFile = new Map();
  for (const s of d1) {
    if (!byFile.has(s.file)) byFile.set(s.file, new Set());
    byFile.get(s.file).add(s.name);
  }
  const all = walkRepo(repoDir);
  const ctrlFile = (name) =>
    all.find((f) => /app\/Http\/Controllers\//.test(f) && path.basename(f, '.php') === name) || null;
  const out = [];
  const rdir = path.join(repoDir, 'routes');
  let files = [];
  try { files = fs.readdirSync(rdir).filter((f) => f.endsWith('.php')); } catch { return out; }
  const hit = (ctrlRelPath, action, line, routeFile, text) => {
    if (!ctrlRelPath || !byFile.has(ctrlRelPath) || !byFile.get(ctrlRelPath).has(action)) return;
    out.push({ file: routeFile, line, action, via: `${path.basename(ctrlRelPath, '.php')}@${action}`, text: text.trim().slice(0, 70) });
  };
  for (const f of files) {
    const routeFile = `routes/${f}`;
    const text = fs.readFileSync(path.join(rdir, f), 'utf8');
    text.split(/\r?\n/).forEach((ln, i) => {
      if (!/Route::/.test(ln)) return;
      for (const m of ln.matchAll(/'([A-Za-z_]\w*)@([A-Za-z_]\w*)'/g)) hit(ctrlFile(m[1]), m[2], i + 1, routeFile, ln);
      for (const m of ln.matchAll(/\[\s*([A-Za-z_]\w*)::class\s*,\s*'([A-Za-z_]\w*)'/g)) hit(ctrlFile(m[1]), m[2], i + 1, routeFile, ln);
      const res = ln.match(/Route::resource\s*\(\s*'[^']*'\s*,\s*([A-Za-z_]\w*)::class/);
      if (res) {
        const cf = ctrlFile(res[1]);
        if (cf && byFile.has(cf)) {
          for (const a of ['index', 'create', 'store', 'show', 'edit', 'update', 'destroy']) {
            if (byFile.get(cf).has(a)) hit(cf, a, i + 1, routeFile, ln);
          }
        }
      }
    });
  }
  return out;
}

/**
 * Component hops: files that import the file defining a depth-1 caller
 * (uni-app: `@/components/payment/index.vue`). Also precise — matched on the
 * import path, not on a generic method name.
 */
function componentHops(repoDir, d1) {
  // A file at `<dir>/index.vue` is imported as `@/<dir>` — the `/index` suffix is
  // dropped (measured: `import payment from '@/components/payment'`). Emitting both
  // forms is what makes this hop detectable at all.
  const stems = [];
  for (const s of uniq(d1.map((x) => x.file))) {
    const noExt = s.replace(/\.(vue|js|mjs|ts)$/i, '');
    stems.push(noExt);
    if (/\/index$/.test(noExt)) stems.push(noExt.replace(/\/index$/, ''));
  }
  const out = new Set();
  for (const rel of walkRepo(repoDir)) {
    let text;
    try { text = fs.readFileSync(path.join(repoDir, rel), 'utf8'); } catch { continue; }
    if (!/import|require|components\s*:/.test(text)) continue;
    for (const stem of stems) {
      if (rel.startsWith(stem)) continue;
      const quoted = `['"\`][^'"\`]*${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/[A-Za-z_][\\w-]*)?(\\.vue|\\.js)?['"\`]`;
      if (new RegExp(quoted).test(text)) { out.add(rel); break; }
    }
  }
  return [...out];
}

/** Independent 2-hop truth for one symbol (structured relations only). */
function deepTruth(repoDir, sym) {
  const d1 = groundTruth(repoDir, sym);
  const d1Files = new Set(d1.callerFiles.map(posix));
  const enclosing = [];
  for (const site of d1.callSites) {
    const e = enclosingSymbol(repoDir, site.file, site.line);
    if (e && e.name !== sym) enclosing.push({ ...e, file: posix(site.file) });
  }
  const routes = routeHops(repoDir, enclosing);
  const components = componentHops(repoDir, enclosing);
  const d2Files = new Set([...routes.map((r) => r.file), ...components]);
  return {
    depth1: { files: [...d1Files].sort(), count: d1Files.size },
    depth2: { files: [...d2Files].sort(), routes, components, enclosing: uniq(enclosing.map((e) => e.name)) },
  };
}

// ── engine depth-2 extraction ───────────────────────────────────────────────

function archnavDepth2(repoDir, sym, file) {
  const f = file ? ` --file ${file}` : '';
  const j = json(run(`node src/index.js impact ${sym} --dir ${JSON.stringify(repoDir)}${f} --json`).out);
  if (!j) return { files: [], labelled: true, err: 'no json' };
  const rows = [...(j.direct_impact || []), ...(j.indirect_impact || [])];
  const d2 = rows.filter((r) => r.depth === 2);
  return { files: uniq(d2.map((r) => posix(r.file))), labelled: true, rows: d2 };
}

function gitnexusDepth2(repoDir, alias, sym, file) {
  const f = file ? ` -f ${JSON.stringify(file)}` : '';
  const j = json(run(`gitnexus impact ${sym} -r ${alias}${f} --depth 2`).out);
  if (!j) return { files: [], labelled: true, err: 'no json' };
  const d2 = j.byDepth?.['2'] || [];
  return { files: uniq(d2.map((r) => posix(r.filePath))), labelled: true, rows: d2 };
}

function codegraphDepth2(repoDir, sym) {
  const j = json(run(`codegraph impact ${sym} -p ${JSON.stringify(repoDir)} -j -d 2`).out);
  if (!j) return { files: [], labelled: false, err: 'no json' };
  const defs = j.definitions || [];
  const all = uniq(defs.flatMap((d) => (d.affected || []).map((a) => posix(a.filePath || a.file))));
  return { files: all, labelled: false, rows: defs.flatMap((d) => d.affected || []) };
}

// ── cases ───────────────────────────────────────────────────────────────────

const CASES = [
  { repo: 'php-app', dir: path.join(HERE, 'php-app'), alias: 'archnav-bench-php-app', symbol: 'departments', file: 'app/Http/Controllers/Controller.php' },
  { repo: 'vue-app', dir: path.join(HERE, 'vue-app'), alias: 'archnav-bench-vue-app', symbol: 'orderPay', file: 'api/order.js' },
];

const report = [];
for (const c of CASES) {
  const truth = deepTruth(c.dir, c.symbol);
  const expected = new Set(truth.depth2.files);
  console.log(`\n## ${c.repo} — ${c.symbol}: depth-2 (indirect) recall\n`);
  console.log(`truth: depth1 = ${truth.depth1.count} files [${truth.depth1.files.join(', ')}]`);
  console.log(`      enclosing callers = ${truth.depth2.enclosing.join(', ') || '(none)'}`);
  if (truth.depth2.routes.length) {
    console.log(`      route hops = ${truth.depth2.routes.map((r) => `${r.file}:${r.line} ${r.via}`).join(' | ')}`);
  }
  if (truth.depth2.components.length) {
    console.log(`      component hops = ${truth.depth2.components.join(', ')}`);
  }
  console.log(`      depth2 = ${expected.size} files`);
  console.log('');
  console.log('| engine | depth-2 returned | recall | extra rows | labelled |');
  console.log('|--------|------------------|--------|------------|----------|');

  const engines = [
    ['ArchNav', () => archnavDepth2(c.dir, c.symbol, c.file)],
    ['CodeGraph', () => codegraphDepth2(c.dir, c.symbol)],
    ['GitNexus', () => gitnexusDepth2(c.dir, c.alias, c.symbol, c.file)],
  ];
  for (const [name, fn] of engines) {
    const r = fn();
    const got = new Set(r.files);
    const hit = [...got].filter((f) => expected.has(f));
    const extra = [...got].filter((f) => !expected.has(f) && !truth.depth1.files.includes(f));
    const rec = expected.size ? `${hit.length}/${expected.size} (${Math.round((hit.length / expected.size) * 100)}%)` : 'n/a';
    console.log(`| ${name} | ${got.size} | ${rec} | ${extra.length ? extra.slice(0, 3).join(', ') + (extra.length > 3 ? ` +${extra.length - 3}` : '') : '—'} | ${r.labelled ? 'yes' : '**no depth labels**'} |`);
    report.push({ repo: c.repo, symbol: c.symbol, engine: name, returned: got.size, expected: expected.size, hit: hit.length, extra: extra.length, files: [...got], expectedFiles: [...expected], labelled: r.labelled, err: r.err || null });
  }

  // per-row detail for the depth-2 rows each engine actually returned
  const a = archnavDepth2(c.dir, c.symbol, c.file);
  if (a.rows?.length) {
    console.log('\nArchNav depth-2 rows (depth / via / confidence):');
    for (const r of a.rows.slice(0, 12)) console.log(`  - ${r.symbol} @ ${r.file}:${r.line}  via=${r.via} src=${r.source_kind} conf=${r.confidence}`);
  }
}

if (AS_JSON) fs.writeFileSync(path.join(HERE, 'deep_recall_report.json'), JSON.stringify(report, null, 2));
console.log(`\n${AS_JSON ? 'JSON: bench/deep_recall_report.json' : '(pass --json to save)'}`);
