/**
 * GitNexus engine adapter (external CLI: `gitnexus` 1.6.x).
 *
 * Same unified caller interface as codegraph.js:
 *   callers(symbol, options) -> { symbol, callers: [...], raw, error? }
 *
 * Repo resolution (mandatory — `gitnexus context` aborts with
 * "Multiple repositories indexed" without `-r`):
 *   options.repo            -> used verbatim
 *   else `gitnexus list` is parsed (memoised) and the entry whose `Path:`
 *   matches options.projectDir/cwd is selected; a single indexed repo is used
 *   as-is, otherwise `error: 'repo_required'` is returned.
 *
 * Ambiguous symbols (several definitions with the same name — e.g. `orderTake`
 * lives in both api/order.js and api/activity.js): options.file disambiguates;
 * options.allDefinitions merges every candidate; otherwise the best-ranked
 * candidate is used and `candidates` is surfaced on the result.
 */
import { DEFAULT_TIMEOUT_MS, runCli, tryParseJson, safeRun } from './exec.js';

export const ENGINE = 'gitnexus';
export const BIN = 'gitnexus';

let repoCache = null;

/** Parse `gitnexus list` (English or Chinese labels) into [{ name, path }]. */
export function parseRepoList(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const repos = [];
  let pending = null;
  const nameRe = /^\s{2}(\S+)(?:\s+\(.*\))?\s*$/;
  const pathRe = /^\s+Path:\s*(.+?)\s*$/;
  for (const line of lines) {
    const p = line.match(pathRe);
    if (p && pending) {
      repos.push({ name: pending, path: p[1] });
      pending = null;
      continue;
    }
    if (pathRe.test(line)) continue;
    const n = line.match(nameRe);
    if (n) pending = n[1];
  }
  return repos;
}

function normaliseDir(p) {
  return String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Resolve the repository to query, or return { error }. */
export async function resolveRepo(options = {}) {
  if (options.repo) return { repo: options.repo, source: 'explicit' };

  const runner = options.runner || runCli;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (repoCache === null) {
    const res = await safeRun(runner, BIN, ['list'], { cwd: options.cwd, timeoutMs });
    if (res.error) return { error: res.error, raw: res.stdout, stderr: res.stderr };
    repoCache = parseRepoList(res.stdout);
  }
  const repos = repoCache;
  if (!repos.length) return { error: 'repo_required' };

  const target = normaliseDir(options.projectDir || options.cwd);
  if (target) {
    const hit = repos.find((r) => normaliseDir(r.path) === target);
    if (hit) return { repo: hit.name, source: 'path_match' };
  }
  if (repos.length === 1) return { repo: repos[0].name, source: 'single' };
  return { error: 'repo_required', repos };
}

function callsToCallers(incoming) {
  const rows = Array.isArray(incoming?.calls) ? incoming.calls : [];
  return rows.map((c) => ({
    file: c.filePath,
    line: c.startLine ?? c.line ?? null,
    enclosing: c.name ?? null,
    engine: ENGINE,
    source_kind: 'ast',
  }));
}

function resultFromFound(json, symbol) {
  return {
    symbol: json.symbol?.name ?? symbol,
    callers: callsToCallers(json.incoming),
    raw: json,
    resolved: json.symbol ? { uid: json.symbol.uid, file: json.symbol.filePath } : undefined,
  };
}

async function contextOnce(symbol, repo, options, extraArgs = []) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = options.projectDir || options.cwd || process.cwd();
  const runner = options.runner || runCli;
  const args = ['context', symbol, '-r', repo, ...extraArgs];
  const res = await safeRun(runner, BIN, args, { cwd, timeoutMs });
  if (res.error && !res.stdout) {
    return { transportError: res.error, stderr: res.stderr, raw: res.stdout };
  }
  const json = tryParseJson(res.stdout);
  if (!json) return { parseError: true, raw: res.stdout, stderr: res.stderr };
  return { json, raw: res.stdout };
}

/**
 * Find callers of `symbol`.
 * options: { repo, file, uid, allDefinitions, projectDir, timeoutMs, runner }
 */
export async function callers(symbol, options = {}) {
  const resolved = await resolveRepo(options);
  if (resolved.error) {
    return { symbol, callers: [], raw: resolved.raw, error: resolved.error, stderr: resolved.stderr, repos: resolved.repos };
  }
  const repo = resolved.repo;

  const extra = [];
  if (options.uid) extra.push('-u', options.uid);
  else if (options.file) extra.push('-f', options.file);

  const first = await contextOnce(symbol, repo, options, extra);
  if (first.transportError) {
    return { symbol, callers: [], raw: first.raw, error: first.transportError, stderr: first.stderr, repo };
  }
  if (first.parseError) {
    return { symbol, callers: [], raw: first.raw, error: 'parse_failed', stderr: first.stderr, repo };
  }

  const json = first.json;
  if (json.status === 'found') {
    return { ...resultFromFound(json, symbol), repo };
  }
  if (json.status === 'ambiguous') {
    const candidates = Array.isArray(json.candidates) ? json.candidates : [];
    if (!candidates.length) {
      return { symbol, callers: [], raw: json, error: 'symbol_not_found', repo };
    }
    // Merge every candidate definition when explicitly requested.
    if (options.allDefinitions) {
      const merged = [];
      for (const c of candidates) {
        const r = await contextOnce(symbol, repo, options, ['-f', c.filePath]);
        if (r.json && r.json.status === 'found') merged.push(...callsToCallers(r.json.incoming));
      }
      return { symbol, callers: merged, raw: json, repo, candidates, resolved_by: 'all_definitions', ambiguous: true };
    }
    // Default: use the best-ranked candidate (GitNexus orders by score desc).
    const choice = candidates[0];
    const r = await contextOnce(symbol, repo, options, ['-f', choice.filePath]);
    if (r.json && r.json.status === 'found') {
      return {
        ...resultFromFound(r.json, symbol),
        repo,
        candidates,
        resolved_by: 'first_candidate',
        ambiguous: true,
      };
    }
    return { symbol, callers: [], raw: json, repo, candidates, error: 'ambiguous_symbol', ambiguous: true };
  }

  return { symbol, callers: [], raw: json, error: 'symbol_not_found', repo };
}

/** Test helper: drop the memoised repo list. */
export function _resetRepoCache() {
  repoCache = null;
}

export default { ENGINE, BIN, callers, resolveRepo, parseRepoList };
