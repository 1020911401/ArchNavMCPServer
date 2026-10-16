#!/usr/bin/env node
/**
 * bench/multi_dim.mjs — multi-dimensional comparison: ArchNav vs CodeGraph vs GitNexus.
 *
 * Every command below was verified against the installed CLI's --help and a live
 * run (see bench/README.md). Where an engine has no equivalent command the
 * closest one is used and the cell is marked `~` so the table stays honest.
 *
 *   dimension   ArchNav              CodeGraph            GitNexus
 *   ---------   ------------------   ------------------   -------------------
 *   locate      locate               query                context (closest)
 *   callers     callers              callers              context (closest)
 *   impact      impact               impact               impact
 *   read        read                 node                 context --content
 *   trace       trace                explore (closest)    query (closest)
 *   arch        arch                 status               status
 *   status      status               status               status
 *
 * Usage: node bench/multi_dim.mjs [--no-index] [--engines=a,b,c]
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const NO_INDEX = argv.includes('--no-index');
const engArg = argv.find((a) => a.startsWith('--engines='));
const ONLY = engArg ? new Set(engArg.slice(10).split(',').map((s) => s.trim())) : null;

const T = { QUERY: 180_000, INDEX: 900_000 };

function run(cmd, { cwd = ROOT, timeout = T.QUERY } = {}) {
  const t0 = Date.now();
  let res;
  try {
    res = spawnSync(cmd, {
      cwd, shell: true, timeout, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, windowsHide: true,
    });
  } catch (e) {
    return { out: '', wall: Date.now() - t0, error: `spawn failed: ${e.message}` };
  }
  const wall = Date.now() - t0;
  const out = `${res.stdout ?? ''}${res.stderr ? '\n' + res.stderr : ''}`;
  let error = null;
  if (res.error) {
    error = res.error.code === 'ETIMEDOUT' ? `timeout ${Math.round(timeout / 1000)}s`
      : res.error.code === 'ENOENT' ? 'command not found' : (res.error.message || String(res.error.code));
  } else if (typeof res.status === 'number' && res.status !== 0) {
    error = `exit ${res.status}`;
  }
  return { out, wall, status: res.status, error };
}

/** Parse the first JSON object OR array in a noisy stream (CLIs print banners). */
function json(text) {
  if (!text) return null;
  const oi = text.indexOf('{'), ai = text.indexOf('[');
  let start = -1, end = -1;
  if (ai !== -1 && (oi === -1 || ai < oi)) { start = ai; end = text.lastIndexOf(']'); }
  else if (oi !== -1) { start = oi; end = text.lastIndexOf('}'); }
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

const posix = (p) => (p ? String(p).replace(/\\/g, '/').replace(/^\.\//, '') : null);
const SRC = /\.(php|vue|js|mjs|ts)$/i;
const isSrc = (p) => SRC.test(p || '');
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

/** Recursive source-file walk (skips dot-dirs and node_modules). */
function walk(dir, base = dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (isSrc(e.name)) out.push(posix(path.relative(base, full)));
  }
  return out;
}

/** Ground truth: source files that literally mention `sym` (definition files excluded).
 *  Pure Node on purpose — spawnSync(shell:true) uses cmd.exe on Windows, where
 *  `grep` does not exist and the old version silently reported gt≈0 everywhere. */
function gtFiles(repoDir, sym, defFiles = []) {
  const out = new Set();
  for (const rel of walk(repoDir)) {
    const full = path.join(repoDir, rel);
    try { if (fs.readFileSync(full, 'utf8').includes(sym)) out.add(rel); } catch { /* unreadable */ }
  }
  for (const d of defFiles) out.delete(posix(d));
  return out;
}

/** How many returned caller files actually contain the symbol (precision proxy). */
function verify(repoDir, files, sym) {
  return files.filter((f) => {
    const full = path.join(repoDir, f);
    if (!fs.existsSync(full)) return false;
    try { return fs.readFileSync(full, 'utf8').includes(sym); } catch { return false; }
  });
}

// ── fixtures ────────────────────────────────────────────────────────────────

const REPOS = [
  {
    name: 'php-app',
    dir: path.join(HERE, 'php-app'),
    alias: 'archnav-bench-php-app',
    locate: [
      { symbol: 'departments', file: 'app/Http/Controllers/Controller.php', expect: 'app/Http/Controllers/Controller.php' },
      { symbol: 'showSelectOptions', file: 'app/Presenters/DepartmentPresenter.php', expect: 'app/Presenters/DepartmentPresenter.php' },
    ],
    callers: [
      { symbol: 'departments', file: 'app/Http/Controllers/Controller.php' },
      { symbol: 'showSelectOptions', file: 'app/Presenters/DepartmentPresenter.php' },
    ],
    impact: [{ symbol: 'departments', file: 'app/Http/Controllers/Controller.php' }],
    read: [{ symbol: 'departments', file: 'app/Http/Controllers/Controller.php' }],
    trace: [{ from: 'departments', to: 'showSelectOptions' }],
  },
  {
    name: 'vue-app',
    dir: path.join(HERE, 'vue-app'),
    alias: 'archnav-bench-vue-app',
    locate: [
      { symbol: 'goPay', file: 'components/payment/index.vue', expect: 'components/payment/index.vue' },
      { symbol: 'orderPay', file: 'api/order.js', expect: 'api/order.js' },
    ],
    callers: [
      { symbol: 'orderTake', file: 'api/order.js' },
      { symbol: 'getUserInfo', file: 'api/user.js' },
      { symbol: 'goPay', file: 'components/payment/index.vue' },
    ],
    impact: [{ symbol: 'goPay', file: 'components/payment/index.vue' }],
    read: [{ symbol: 'goPay', file: 'components/payment/index.vue' }],
    trace: [{ from: 'goPay', to: 'orderPay' }],
  },
];

// ── engines ─────────────────────────────────────────────────────────────────

const ENGINES = {
  archnav: {
    label: 'ArchNav',
    index: (repo) => run(`node src/index.js analyze ${JSON.stringify(repo.dir)}`, { timeout: T.INDEX }),
    locate: (repo, t) => {
      const r = run(`node src/index.js locate ${t.symbol} --dir ${JSON.stringify(repo.dir)} --json`);
      const j = json(r.out);
      if (!j) return { ok: false, d: 'no json', wall: r.wall };
      if (j.error) return { ok: false, d: j.error, wall: r.wall };
      if (j.ambiguous) return { ok: true, d: `ambiguous (${j.candidates?.length ?? '?'} defs)`, wall: r.wall, partial: true };
      const file = posix(j.file || j.symbol?.file);
      const line = j.line_start || j.symbol?.line_start;
      if (!file) return { ok: false, d: 'no file', wall: r.wall };
      const hit = !t.expect || file.includes(t.expect);
      return { ok: hit, d: `${file}:${line}`, wall: r.wall };
    },
    callers: (repo, t) => {
      // --file wants a repo-relative path or suffix; an absolute path silently
      // filters everything out (measured: 6 relations -> 0).
      const f = t.file ? ` --file ${t.file}` : '';
      const r = run(`node src/index.js callers ${t.symbol} --dir ${JSON.stringify(repo.dir)}${f} --json`);
      const j = json(r.out);
      if (!j) return { ok: false, d: 'no json', wall: r.wall };
      if (j.error) return { ok: false, d: j.error, wall: r.wall };
      const files = uniq((j.relations || []).map((x) => posix(x.file)).filter(isSrc));
      const gt = gtFiles(repo.dir, t.symbol, [t.file]);
      const good = verify(repo.dir, files, t.symbol);
      return { ok: files.length > 0, d: `${files.length} files (${good.length} verified), gt≈${gt.size}`, wall: r.wall, n: files.length, gt: gt.size, precision: files.length ? good.length / files.length : null };
    },
    impact: (repo, t) => {
      // --file is required to pick between same-named definitions; without it a
      // component method can come back as 0 direct / 0 indirect.
      const f = t.file ? ` --file ${t.file}` : '';
      const r = run(`node src/index.js impact ${t.symbol} --dir ${JSON.stringify(repo.dir)}${f} --json`);
      const j = json(r.out);
      if (!j) return { ok: false, d: 'no json', wall: r.wall };
      if (j.error) return { ok: false, d: j.error, wall: r.wall };
      const d = (j.direct_impact || j.direct || []).length;
      const i = (j.indirect_impact || j.indirect || []).length;
      return { ok: d + i > 0, d: `${d} direct + ${i} indirect`, wall: r.wall };
    },
    read: (repo, t) => {
      const r = run(`node src/index.js read ${t.symbol} --dir ${JSON.stringify(repo.dir)}`);
      const ok = r.out.length > 80 && !/not found|Error:/i.test(r.out);
      return { ok, d: ok ? `${r.out.length} chars` : `fail: ${r.out.replace(/\s+/g, ' ').slice(0, 70)}`, wall: r.wall };
    },
    trace: (repo, t) => {
      const r = run(`node src/index.js trace ${t.from} ${t.to} --dir ${JSON.stringify(repo.dir)}`);
      const ok = /→|->|Trace/i.test(r.out) && !/no path|not found/i.test(r.out);
      return { ok, d: ok ? r.out.split('\n').filter(Boolean).slice(0, 3).join(' / ').slice(0, 90) : 'no path', wall: r.wall };
    },
    arch: (repo) => {
      // `arch` takes the dir positionally — `--dir` is rejected ("unknown option").
      // Output format is "✅ API (Controller)" lines, not arrows.
      const r = run(`node src/index.js arch ${JSON.stringify(repo.dir)}`);
      const n = (r.out.match(/^\s*[✅⚠️]/gm) || []).length;
      return { ok: n > 0, d: `${n} layers detected`, wall: r.wall };
    },
    status: (repo) => {
      const r = run(`node src/index.js status ${JSON.stringify(repo.dir)} --json`);
      const j = json(r.out);
      if (!j) return { ok: false, d: 'no json', wall: r.wall };
      return { ok: true, d: `stale=${j.stale} conf=${j.overallConfidence ?? j.confidence ?? '?'} syms=${j.symbols ?? '?'}`, wall: r.wall };
    },
  },

  codegraph: {
    label: 'CodeGraph',
    // `init` is a no-op when .codegraph already exists (measured 1.0s) — use
    // `index`, which rebuilds from scratch, so the timing is a real build.
    index: (repo) => run(`codegraph index ${JSON.stringify(repo.dir)}`, { timeout: T.INDEX }),
    locate: (repo, t) => {
      const r = run(`codegraph query ${t.symbol} -p ${JSON.stringify(repo.dir)} -j`);
      const j = json(r.out);
      const arr = Array.isArray(j) ? j : (j?.results || j?.nodes || []);
      if (!arr.length) return { ok: false, d: 'no results', wall: r.wall };
      const n = arr[0].node || arr[0];
      const file = posix(n.filePath || n.file);
      const hit = !t.expect || file.includes(t.expect);
      return { ok: hit, d: `${file}:${n.startLine ?? '?'}`, wall: r.wall };
    },
    callers: (repo, t) => {
      const f = t.file ? ` -f ${JSON.stringify(t.file)}` : '';
      const r = run(`codegraph callers ${t.symbol} -p ${JSON.stringify(repo.dir)} -j -l 1000${f}`);
      const j = json(r.out);
      if (!j) return { ok: false, d: 'no json', wall: r.wall };
      const defs = j.definitions || [];
      const files = uniq(defs.flatMap((d) => (d.callers || []).map((c) => posix(c.filePath || c.file))).filter(isSrc));
      const gt = gtFiles(repo.dir, t.symbol, [t.file]);
      const good = verify(repo.dir, files, t.symbol);
      return { ok: files.length > 0, d: `${files.length} files (${good.length} verified), gt≈${gt.size}`, wall: r.wall, n: files.length, gt: gt.size, precision: files.length ? good.length / files.length : null };
    },
    impact: (repo, t) => {
      const r = run(`codegraph impact ${t.symbol} -p ${JSON.stringify(repo.dir)} -j`);
      const j = json(r.out);
      if (!j) return { ok: false, d: 'no json', wall: r.wall };
      const defs = j.definitions || [];
      const n = defs.reduce((a, d) => a + ((d.callers || []).length + (d.affected || []).length), 0) || (j.total ?? 0);
      return { ok: n > 0, d: `${n} affected`, wall: r.wall };
    },
    read: (repo, t) => {
      const r = run(`codegraph node ${t.symbol} -p ${JSON.stringify(repo.dir)}`);
      const ok = r.out.length > 80 && !/not found/i.test(r.out);
      return { ok, d: ok ? `${r.out.length} chars` : `fail: ${r.out.replace(/\s+/g, ' ').slice(0, 70)}`, wall: r.wall };
    },
    trace: (repo, t) => {
      const r = run(`codegraph explore ${t.from} ${t.to} -p ${JSON.stringify(repo.dir)}`);
      const ok = /found \d+ symbol/i.test(r.out) || /→|->/.test(r.out);
      return { ok, d: `~ ${r.out.split('\n').filter(Boolean).slice(0, 2).join(' / ').slice(0, 90)}`, wall: r.wall, approx: true };
    },
    arch: (repo) => {
      const r = run(`codegraph status ${JSON.stringify(repo.dir)} -j`);
      const j = json(r.out);
      if (!j) return { ok: false, d: 'no json', wall: r.wall };
      return { ok: (j.nodeCount ?? 0) > 0, d: `~ ${j.nodeCount} nodes (no layer model)`, wall: r.wall, approx: true };
    },
    status: (repo) => {
      const r = run(`codegraph status ${JSON.stringify(repo.dir)} -j`);
      const j = json(r.out);
      if (!j) return { ok: false, d: 'no json', wall: r.wall };
      const pend = j.pendingChanges || {};
      return { ok: true, d: `nodes=${j.nodeCount} edges=${j.edgeCount} pending=${(pend.added || 0) + (pend.modified || 0) + (pend.removed || 0)}`, wall: r.wall };
    },
  },

  gitnexus: {
    label: 'GitNexus',
    index: (repo) => run(`gitnexus analyze ${JSON.stringify(repo.dir)} --skip-git`, { timeout: T.INDEX }),
    locate: (repo, t) => {
      const f = t.file ? ` -f ${JSON.stringify(t.file)}` : '';
      const r = run(`gitnexus context ${t.symbol} -r ${repo.alias}${f}`);
      const j = json(r.out);
      if (j?.status === 'ambiguous') {
        const c = j.candidates?.[0];
        const file = posix(c?.filePath);
        const hit = !t.expect || (file || '').includes(t.expect);
        return { ok: hit, d: `~ ambiguous, top: ${file}:${c?.line ?? '?'}`, wall: r.wall, approx: true };
      }
      const sym = j?.symbol || j?.target || j;
      const file = posix(sym?.filePath || sym?.file);
      if (!file) return { ok: false, d: 'no file', wall: r.wall };
      const hit = !t.expect || file.includes(t.expect);
      return { ok: hit, d: `~ ${file}:${sym.line ?? sym.startLine ?? '?'}`, wall: r.wall, approx: true };
    },
    callers: (repo, t) => {
      const f = t.file ? ` -f ${JSON.stringify(t.file)}` : '';
      const r = run(`gitnexus context ${t.symbol} -r ${repo.alias}${f}`);
      const j = json(r.out);
      if (!j) return { ok: false, d: 'no json', wall: r.wall };
      if (j.status === 'ambiguous') return { ok: false, d: `ambiguous (${j.candidates?.length ?? '?'} candidates)`, wall: r.wall };
      // `gitnexus context` groups incoming edges by relation: incoming.calls[].
      const callers = Array.isArray(j.incoming?.calls) ? j.incoming.calls : [];
      const files = uniq(callers.map((c) => posix(c.filePath || c.file || c.symbol?.filePath)).filter(isSrc));
      const gt = gtFiles(repo.dir, t.symbol, [t.file]);
      const good = verify(repo.dir, files, t.symbol);
      return { ok: files.length > 0, d: `~ ${files.length} files (${good.length} verified), gt≈${gt.size}`, wall: r.wall, n: files.length, gt: gt.size, approx: true, precision: files.length ? good.length / files.length : null };
    },
    impact: (repo, t) => {
      const f = t.file ? ` -f ${JSON.stringify(t.file)}` : '';
      const r = run(`gitnexus impact ${t.symbol} -r ${repo.alias}${f}`);
      const j = json(r.out);
      // GitNexus impact JSON: impactedCount / risk / summary.direct / byDepthCounts.
      const n = j?.impactedCount ?? 0;
      const direct = j?.summary?.direct ?? 0;
      const risk = j?.risk ? ` risk=${j.risk}` : '';
      const ok = n > 0 || (r.out.length > 40 && !/error|not found/i.test(r.out));
      return { ok, d: j ? `${n} impacted (${direct} direct)${risk}` : `${r.out.length} chars (text)`, wall: r.wall, approx: true };
    },
    read: (repo, t) => {
      const f = t.file ? ` -f ${JSON.stringify(t.file)}` : '';
      const r = run(`gitnexus context ${t.symbol} -r ${repo.alias} --content${f}`);
      const j = json(r.out);
      const code = j?.symbol?.content || j?.content || '';
      const ok = code.length > 80;
      return { ok, d: `~ ${ok ? `${code.length} chars of source` : 'no content in context output'}`, wall: r.wall, approx: true };
    },
    trace: (repo, t) => {
      const r = run(`gitnexus query ${JSON.stringify(t.from + ' ' + t.to)} -r ${repo.alias}`);
      const ok = r.out.length > 60 && !/not found|error/i.test(r.out);
      return { ok, d: `~ flows for "${t.from} ${t.to}"`, wall: r.wall, approx: true };
    },
    arch: (repo) => {
      const r = run(`gitnexus status`, { cwd: repo.dir });
      const ok = /索引|索引时间|index/i.test(r.out);
      return { ok, d: `~ clusters only, no layer model`, wall: r.wall, approx: true };
    },
    status: (repo) => {
      const r = run(`gitnexus status`, { cwd: repo.dir });
      const m = r.out.match(/状态:\s*(.+)/);
      return { ok: !r.error, d: m ? m[1].trim().slice(0, 50) : (r.error || 'ok'), wall: r.wall };
    },
  },
};

// ── run ─────────────────────────────────────────────────────────────────────

const engines = Object.keys(ENGINES).filter((e) => !ONLY || ONLY.has(e));
const results = [];
const row = (...cells) => `| ${cells.join(' | ')} |`;

if (!NO_INDEX) {
  console.log('\n## Index build (fresh)\n');
  console.log(row('engine', 'php-app', 'vue-app', 'note'));
  console.log('|--------|---------|---------|------|');
  for (const e of engines) {
    const cells = [];
    let note = '';
    for (const repo of REPOS) {
      const r = ENGINES[e].index(repo);
      cells.push(`${(r.wall / 1000).toFixed(1)}s${r.error ? ' ⚠️' : ''}`);
      if (r.error) note = r.error.replace(/\s+/g, ' ').slice(0, 60);
      results.push({ dim: 'index', engine: e, repo: repo.name, wall: r.wall, ok: !r.error, d: r.error || 'ok' });
    }
    console.log(row(ENGINES[e].label, cells[0], cells[1], note));
  }
}

const DIMS = ['locate', 'callers', 'impact', 'read', 'trace', 'arch', 'status'];
for (const repo of REPOS) {
  for (const dim of DIMS) {
    const tests = dim === 'arch' || dim === 'status' ? [{}] : repo[dim];
    if (!tests?.length) continue;
    console.log(`\n## ${repo.name} — ${dim}\n`);
    console.log(row('engine', 'result', 'detail', 'wall'));
    console.log('|--------|--------|--------|------|');
    for (const e of engines) {
      for (const t of tests) {
        let r;
        try { r = ENGINES[e][dim](repo, t); } catch (err) { r = { ok: false, d: `threw: ${err.message}`, wall: 0 }; }
        const mark = r.ok ? (r.approx ? '~ ✅' : '✅') : '❌';
        const name = t.symbol ? `${ENGINES[e].label} (${t.symbol})` : ENGINES[e].label;
        console.log(row(name, mark, String(r.d).replace(/\|/g, '/').slice(0, 80), `${r.wall}ms`));
        results.push({ dim, engine: e, repo: repo.name, target: t.symbol || t.from || '-', ok: !!r.ok, approx: !!r.approx, wall: r.wall, d: r.d, n: r.n, gt: r.gt, precision: r.precision });
      }
    }
  }
}

console.log('\n## Summary (exact matches only; ~ = closest-equivalent command)\n');
console.log(row('dimension', 'ArchNav', 'CodeGraph', 'GitNexus'));
console.log('|-----------|---------|-----------|----------|');
for (const dim of ['index', ...DIMS]) {
  const cells = [];
  for (const e of engines) {
    const items = results.filter((x) => x.dim === dim && x.engine === e);
    if (!items.length) { cells.push('—'); continue; }
    if (dim === 'index') {
      const p = items.find((x) => x.repo === 'php-app');
      const v = items.find((x) => x.repo === 'vue-app');
      cells.push(`${(p.wall / 1000).toFixed(1)}s / ${(v.wall / 1000).toFixed(1)}s`);
    } else {
      const exact = items.filter((x) => x.ok && !x.approx).length;
      const approx = items.filter((x) => x.ok && x.approx).length;
      const avg = Math.round(items.reduce((a, x) => a + x.wall, 0) / items.length);
      cells.push(`${exact}/${items.length}${approx ? ` (+${approx}~)` : ''} · ${avg}ms`);
    }
  }
  console.log(row(dim, cells[0], cells[1], cells[2]));
}

const callers = results.filter((x) => x.dim === 'callers' && x.n != null);
if (callers.length) {
  console.log('\n## callers recall (returned vs files that literally mention the symbol)\n');
  console.log('NOTE: `gt` is an UPPER BOUND — it counts any file containing the string (route names,');
  console.log('comments, templates included), so recall here is conservative, not exact.\n');
  console.log(row('engine', 'repo / symbol', 'returned', 'mentions', 'recall'));
  console.log('|--------|---------------|----------|----------|--------|');
  for (const c of callers) {
    const rec = c.gt ? `${Math.round((c.n / c.gt) * 100)}%` : 'n/a';
    console.log(row(ENGINES[c.engine].label, `${c.repo} / ${c.target}`, String(c.n), String(c.gt), rec));
  }
}

const out = path.join(HERE, 'multi_dim_report.json');
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`\nJSON: ${out}`);
