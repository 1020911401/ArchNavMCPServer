#!/usr/bin/env node
// bench/run_bench.mjs
//
// Reproducible benchmark: runs the SAME query set against three engines
//   * archnav  — this repo's own CLI        (node src/index.js …)
//   * codegraph — external CLI              (codegraph …)
//   * gitnexus — external CLI               (gitnexus …)
// over the two fixtures bench/php-app and bench/vue-app, prints a Markdown
// table to stdout and writes JSON details to bench/report.json.
//
// Usage:   node bench/run_bench.mjs [--fresh] [--no-prepare] [--engines=a,b,c]
//            --fresh        force re-index even if an index already exists
//            --no-prepare   skip all indexing/analyze steps
//            --engines=…    restrict to some engines (default: all three)
//
// Robustness contract: the script NEVER throws. A missing engine, a non-zero
// exit, or a query exceeding 180 s produces a `n/a (reason)` cell and a record
// with the error string. It always finishes by writing bench/report.json.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groundTruth } from './gen_ground_truth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // bench/
const REPO_ROOT = path.resolve(HERE, '..'); // archnav repo root
const REPORT_PATH = path.join(HERE, 'report.json');

const QUERY_TIMEOUT_MS = 180_000; // per query, per the spec
const PREPARE_TIMEOUT_MS = 900_000; // indexing may be slow

const argv = process.argv.slice(2);
const FRESH = argv.includes('--fresh');
const NO_PREPARE = argv.includes('--no-prepare');
const engArg = argv.find((a) => a.startsWith('--engines='));
const ONLY_ENGINES = engArg
  ? new Set(engArg.slice('--engines='.length).split(',').map((s) => s.trim()).filter(Boolean))
  : null;

const ALL_ENGINES = ['archnav', 'codegraph', 'gitnexus'];
const ENGINES = ALL_ENGINES.filter((e) => !ONLY_ENGINES || ONLY_ENGINES.has(e));

const REPOS = [
  {
    name: 'php-app',
    dir: path.join(HERE, 'php-app'),
    alias: 'archnav-bench-php-app',
    queries: [
      { id: 'callers departments', kind: 'callers', symbol: 'departments' },
      { id: 'callers showSelectOptions', kind: 'callers', symbol: 'showSelectOptions',
        files: ['app/Presenters/DepartmentPresenter.php', 'app/Presenters/DiseasePresenter.php',
                'app/Presenters/GroupPresenter.php', 'app/Presenters/HospitalPresenter.php',
                'app/Presenters/NavigationPresenter.php', 'app/Presenters/PermissionPresenter.php',
                'app/Presenters/RolePresenter.php', 'app/Presenters/UserPresenter.php'] },
      { id: 'status', kind: 'status' },
    ],
  },
  {
    name: 'vue-app',
    dir: path.join(HERE, 'vue-app'),
    alias: 'archnav-bench-vue-app',
    queries: [
      { id: 'callers orderTake', kind: 'callers', symbol: 'orderTake',
        files: ['api/order.js', 'api/activity.js'] },
      { id: 'callers getUserInfo', kind: 'callers', symbol: 'getUserInfo', files: ['api/user.js'] },
      { id: 'status', kind: 'status' },
    ],
  },
];

// --------------------------------------------------------------------------
// process helper — never throws
// --------------------------------------------------------------------------
function run(cmd, { cwd = REPO_ROOT, timeout = QUERY_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  let res;
  try {
    res = spawnSync(cmd, {
      cwd,
      shell: true,
      timeout,
      encoding: 'utf8',
      // stdin must NOT be inherited: a child that probes for a TTY (several CLIs
      // do) makes the whole script exit 1 with `stdin is not a tty` when run from
      // a background job / cron / piped shell, even though every query succeeded.
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024, // archnav analyze prints multi-MB JSON
      windowsHide: true,
    });
  } catch (e) {
    return { out: '', wall: Date.now() - t0, status: null, error: `spawn failed: ${e.message}` };
  }
  const wall = Date.now() - t0;
  const out = `${res.stdout ?? ''}${res.stderr ? '\n' + res.stderr : ''}`;
  let error = null;
  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') error = `timeout ${Math.round(timeout / 1000)}s`;
    else if (res.error.code === 'ENOENT') error = 'command not found';
    else error = res.error.message || String(res.error.code);
  } else if (typeof res.status === 'number' && res.status !== 0) {
    error = `exit ${res.status}`;
  }
  return { out, wall, status: res.status, error };
}

function safeJson(text) {
  // tolerate engines that print a banner/noise before the JSON body
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function toRel(p, repoDir) {
  if (!p) return null;
  let s = String(p);
  if (path.isAbsolute(s)) {
    const r = path.relative(repoDir, s);
    if (r && !r.startsWith('..')) s = r;
  }
  return s.replace(/\\/g, '/').replace(/^\.\//, '');
}

const SRC_RE = /[\w./@-]+\.(?:php|vue|js|mjs|ts)?/g;

function filesFromJson(text, pick, repoDir) {
  const json = safeJson(text);
  if (!json) return null;
  const raw = [];
  try {
    pick(json, (f) => f && raw.push(f));
  } catch {
    return null;
  }
  const set = new Set();
  for (const r of raw) {
    const rel = toRel(r, repoDir);
    if (rel && /\.(php|vue|js|mjs|ts)$/.test(rel)) set.add(rel);
  }
  return set;
}

function filesFromText(text) {
  const set = new Set();
  for (const m of text.matchAll(SRC_RE)) set.add(m[0].replace(/\\/g, '/').replace(/^\.\//, ''));
  return set;
}

// --------------------------------------------------------------------------
// engine adapters
// --------------------------------------------------------------------------
const ADAPTERS = {
  archnav: {
    probe: () => run('node src/index.js --version', { timeout: 60_000 }),
    needsPrepare: (repo) => FRESH || !fs.existsSync(path.join(repo.dir, '.archnav', 'index.json')),
    prepare: (repo) =>
      run(`node src/index.js analyze ${q(repo.dir)}`, { timeout: PREPARE_TIMEOUT_MS }),
    callers: (repo, symbol, file) =>
      run(
        `node src/index.js callers ${symbol} --dir ${q(repo.dir)}${file ? ` --file ${q(file)}` : ''} --json`,
      ),
    status: (repo) => run(`node src/index.js status ${q(repo.dir)} --json`),
    extractCallerFiles: (out, repo) =>
      filesFromJson(out, (j, push) => {
        for (const r of j.relations || []) push(r.file);
      }, repo.dir),
    checkError: (out) => {
      const j = safeJson(out);
      if (!j) return null;
      if (j.error) return String(j.error);
      // archnav refuses to pick between several same-named definitions
      if (j.ambiguous) return 'ambiguous symbol';
      return null;
    },
    statusDetail: (out) => {
      const j = safeJson(out);
      if (!j) return trim1(out);
      if (j.type === 'status') {
        return `stale=${j.stale} confidence=${j.overallConfidence} symbols=${j.symbols}`;
      }
      return trim1(JSON.stringify(j));
    },
  },

  codegraph: {
    probe: () => run('codegraph --version', { timeout: 60_000 }),
    needsPrepare: (repo) => FRESH || !fs.existsSync(path.join(repo.dir, '.codegraph')),
    prepare: (repo) => {
      // init is idempotent (exit 0 whether or not already initialized)
      const r = run(`codegraph init ${q(repo.dir)}`, { timeout: PREPARE_TIMEOUT_MS });
      return r;
    },
    callers: (repo, symbol, file) =>
      run(
        `codegraph callers ${symbol} -p ${q(repo.dir)} -j -l 1000${file ? ` --file ${q(file)}` : ''}`,
      ),
    status: (repo) => run(`codegraph status ${q(repo.dir)} -j`),
    extractCallerFiles: (out, repo) =>
      filesFromJson(out, (j, push) => {
        for (const def of j.definitions || []) {
          for (const c of def.callers || []) push(c.filePath || c.file);
        }
        for (const c of j.callers || []) push(c.filePath || c.file);
      }, repo.dir),
    checkError: (out) => {
      if (/not initialized/i.test(out || '')) return 'not initialized';
      const j = safeJson(out);
      return j && j.error ? String(j.error) : null;
    },
    statusDetail: (out) => {
      const j = safeJson(out);
      if (!j) return trim1(out);
      if (j.initialized === false) return 'not initialized';
      return `files=${j.fileCount} nodes=${j.nodeCount} edges=${j.edgeCount}`;
    },
  },

  gitnexus: {
    probe: () => run('gitnexus -V', { timeout: 60_000 }),
    // gitnexus indexes into a global registry; we can only cheaply skip when the
    // alias is already registered.
    needsPrepare: (repo) => {
      if (FRESH) return true;
      const r = run('gitnexus list', { timeout: 120_000 });
      return !(r.out || '').includes(repo.alias);
    },
    prepare: (repo) =>
      // fixture has no .git dir => --skip-git; --index-only skips AI context files
      run(`gitnexus analyze ${q(repo.dir)} --skip-git --index-only --name ${repo.alias}`, {
        timeout: PREPARE_TIMEOUT_MS,
      }),
    callers: (repo, symbol, defFile) => {
      // -r is mandatory (gitnexus has several repos registered); -f disambiguates
      // common symbol names using the first ground-truth definition file.
      const f = defFile ? ` -f ${defFile}` : '';
      return run(`gitnexus context ${symbol} -r ${repo.alias}${f}`);
    },
    // `gitnexus status` has no -r flag: it reports the repo of the cwd.
    status: (repo) => run('gitnexus status', { cwd: repo.dir }),
    extractCallerFiles: (out, repo) =>
      filesFromJson(out, (j, push) => {
        const inc = j.incoming || {};
        for (const c of inc.calls || []) push(c.filePath || c.file);
      }, repo.dir),
    checkError: (out) => {
      const j = safeJson(out);
      if (!j) return null;
      if (j.status && j.status !== 'found') return String(j.status); // e.g. ambiguous
      if (j.error) return String(j.error);
      return null;
    },
    statusDetail: (out) => {
      const m = /Status:\s*(.+)/.exec(out || '');
      if (m) return m[1].trim();
      return trim1(out);
    },
  },
};

function q(p) {
  return /\s/.test(p) ? `"${p}"` : p;
}
function trim1(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------
const records = [];
const gtCache = new Map();
function gtFor(repo, symbol) {
  const key = `${repo.name}:${symbol}`;
  if (!gtCache.has(key)) {
    try {
      gtCache.set(key, groundTruth(repo.dir, symbol));
    } catch (e) {
      gtCache.set(key, { defs: [], callSites: [], callerFiles: [], _err: String(e) });
    }
  }
  return gtCache.get(key);
}

// availability
const availability = {};
for (const id of ENGINES) {
  try {
    const p = ADAPTERS[id].probe();
    availability[id] = p.error ? { ok: false, reason: p.error } : { ok: true };
  } catch (e) {
    availability[id] = { ok: false, reason: `probe failed: ${e.message}` };
  }
}

// prepare (index) each engine × repo
const prepareLog = [];
for (const id of ENGINES) {
  if (!availability[id].ok) continue;
  const a = ADAPTERS[id];
  for (const repo of REPOS) {
    if (NO_PREPARE) {
      prepareLog.push(`${id}/${repo.name}: skipped (--no-prepare)`);
      continue;
    }
    let need = true;
    try {
      need = a.needsPrepare(repo);
    } catch {
      need = true;
    }
    if (!need) {
      prepareLog.push(`${id}/${repo.name}: index present, skipped`);
      continue;
    }
    const r = a.prepare(repo);
    prepareLog.push(`${id}/${repo.name}: ${r.error ? `FAILED (${r.error})` : `ok (${r.wall}ms)`}`);
  }
}

// run queries
for (const repo of REPOS) {
  for (const query of repo.queries) {
    const queryId = `${repo.name}: ${query.id}`;

    let gtCount = null;
    if (query.kind === 'callers') {
      gtCount = gtFor(repo, query.symbol).callerFiles.length;
    }

    for (const id of ENGINES) {
      const rec = {
        tool: id,
        query: queryId,
        returned: null,
        ground_truth: gtCount,
        recall: null,
        wall_ms: null,
        error: null,
        detail: null,
      };

      if (!availability[id].ok) {
        rec.error = `not installed (${availability[id].reason})`;
        records.push(rec);
        continue;
      }

      const a = ADAPTERS[id];
      try {
        if (query.kind === 'callers') {
          const gt = gtFor(repo, query.symbol);
          const gtFiles = new Set([...gt.callerFiles].map((f) => String(f).replace(/\\/g, '/')));
          // Multi-definition symbols: query each definition file and union the
          // caller sets. Ground truth stays the whole-symbol caller list.
          const defFiles = (query.files && query.files.length
            ? query.files
            : [gt.defs[0]?.file].filter(Boolean));
          const got = new Set();
          let wall = 0;
          let err = null;
          for (const defFile of defFiles) {
            const r = a.callers(repo, query.symbol, defFile);
            wall += r.wall || 0;
            const payloadErr = r.error ? null : a.checkError?.(r.out);
            if (r.error || payloadErr) { err = r.error || payloadErr; continue; }
            const files = a.extractCallerFiles(r.out, repo) || filesFromText(r.out);
            for (const f of files || []) {
              if (f && String(f).length) got.add(String(f).replace(/\\/g, '/'));
            }
          }
          rec.wall_ms = wall;
          if (err && got.size === 0) {
            rec.error = err;
          } else {
            const inter = [...got].filter((f) => gtFiles.has(f)).length;
            rec.returned = got.size;
            rec.ground_truth = gtFiles.size;
            rec.recall = gtFiles.size ? Number((inter / gtFiles.size).toFixed(3)) : null;
            rec.detail = `matched ${inter} of ${gtFiles.size} caller files`;
          }
        } else {
          const r = a.status(repo);
          rec.wall_ms = r.wall;
          if (r.error) {
            rec.error = r.error;
          } else {
            rec.returned = 1;
            rec.detail = a.statusDetail(r.out);
          }
        }
      } catch (e) {
        rec.error = `internal: ${e.message}`;
      }
      records.push(rec);
    }
  }
}

// write JSON first, so `| head` truncation can never lose it
try {
  fs.writeFileSync(REPORT_PATH, JSON.stringify(records, null, 2));
} catch (e) {
  process.stderr.write(`warning: could not write report.json: ${e.message}\n`);
}

// --------------------------------------------------------------------------
// render Markdown
// --------------------------------------------------------------------------
const n = (v) => (v === null || v === undefined ? 'n/a' : String(v));
function cell(rec, query) {
  if (rec.error) return `n/a (${rec.error})`;
  if (query.kind === 'callers') {
    const pct = rec.recall === null ? '' : ` (${Math.round(rec.recall * 100)}%)`;
    return `${n(rec.returned)}/${n(rec.ground_truth)}${pct} ${rec.wall_ms}ms`;
  }
  return `ok ${rec.wall_ms}ms`;
}

const lines = [];
lines.push('# ArchNav benchmark');
lines.push('');
lines.push(`engines: ${ENGINES.join(', ')}`);
lines.push(
  'metric: for `callers <sym>` cells show `returned/ground_truth (recall%) wall_ms`;',
);
lines.push(
  '`returned`/`ground_truth` are CALLER-FILE counts (see bench/README.md). `n/a (…)` = missing engine / failure / timeout.',
);
lines.push('');
const header = ['repo', 'query', ...ENGINES];
const rows = REPOS.flatMap((repo) =>
  repo.queries.map((query) => {
    const queryId = `${repo.name}: ${query.id}`;
    const cells = ENGINES.map((id) => {
      const rec = records.find((r) => r.tool === id && r.query === queryId);
      return rec ? cell(rec, query) : 'n/a (no record)';
    });
    return [repo.name, query.id, ...cells];
  }),
);
lines.push(`| ${header.join(' | ')} |`);
lines.push(`| ${header.map(() => '---').join(' | ')} |`);
for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
lines.push('');
lines.push('prepare log:');
for (const l of prepareLog) lines.push(`- ${l}`);
lines.push('');
lines.push(`JSON details: ${path.relative(REPO_ROOT, REPORT_PATH).split(path.sep).join('/')}`);

const table = lines.join('\n') + '\n';
process.stdout.on('error', (e) => {
  if (e && e.code === 'EPIPE') process.exit(0);
});
try {
  process.stdout.write(table);
} catch {
  /* ignore EPIPE */
}
