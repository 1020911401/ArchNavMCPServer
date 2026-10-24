/**
 * Module-alias resolution — recall patch.
 *
 * `resolveAlias(spec, options)` turns a raw import specifier into the real,
 * existing path of the target file, as a posix path relative to `repoDir`.
 *
 *   options.repoDir  repository root (default: process.cwd())
 *   options.fromFile absolute path of the importing file, needed to resolve
 *                    `./` and `../` specifiers
 *
 * Resolution order:
 *   1. `compilerOptions.paths` from the nearest jsconfig.json / tsconfig.json
 *      (searched upward from `fromFile`, then `repoDir`), joined with `baseUrl`.
 *   2. `@/x/y` → the importing file's package root first (`<pkg>/src/x/y`, `<pkg>/x/y`),
 *      then `<repoDir>/src/x/y` and `<repoDir>/x/y` — a monorepo configures `@` per
 *      package, so the repo root is only the last guess.
 *   3. `./x` / `../x` → relative to `dirname(fromFile)` (or `repoDir`).
 *   4. absolute paths as-is.
 *
 * A candidate is accepted only if it really exists on disk, trying (in order):
 * the exact path, then `+ .js .mjs .ts .vue .json`, then `/index.<ext>`.
 * Returns `null` when nothing exists — never a fabricated path.
 */
import fs from 'fs';
import path from 'path';

const EXTS = ['.js', '.mjs', '.ts', '.vue', '.json'];
const INDEX_FILES = EXTS.map(e => `index${e}`);

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Per-directory memo of the nearest JS/TS config. The previous cache was keyed on the whole
 * ancestor chain and returned `{paths: {}}` on a repeat lookup, so only the *first* file in a
 * directory got its package's `paths` — every later file fell back to the repo root and
 * "failed" to resolve imports that exist (measured: 1 of 2 files in the same directory).
 */
const _cfgCache = new Map();

function configAt(dir) {
  if (_cfgCache.has(dir)) return _cfgCache.get(dir);
  let found = null;
  for (const name of ['jsconfig.json', 'tsconfig.json']) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    const json = readJson(p);
    const co = json && json.compilerOptions;
    if (co && (co.paths || co.baseUrl)) {
      found = { baseUrl: path.resolve(dir, co.baseUrl || '.'), paths: co.paths || {} };
      break;
    }
  }
  _cfgCache.set(dir, found);
  return found;
}

function loadConfig(repoDir, fromFile) {
  const repo = path.resolve(repoDir);
  const chain = [];
  let d = fromFile ? path.dirname(path.resolve(fromFile)) : null;
  while (d) {
    chain.push(d);
    if (d === repo) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  if (!chain.includes(repo)) chain.push(repo);
  for (const dir of chain) {
    const cfg = configAt(dir);
    if (cfg) return cfg;
  }
  return null;
}

/** Nearest ancestor of `fromFile` holding a package.json — the scope `@/` belongs to. */
function nearestPkgRoot(fromFile, repoDir) {
  const repo = path.resolve(repoDir);
  let d = fromFile ? path.dirname(path.resolve(fromFile)) : repo;
  for (;;) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d;
    const up = path.dirname(d);
    if (up === d || d === repo) return repo;
    d = up;
  }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function resolveFile(base) {
  if (isFile(base)) return base;
  for (const e of EXTS) {
    const c = base + e;
    if (isFile(c)) return c;
  }
  for (const idx of INDEX_FILES) {
    const c = path.join(base, idx);
    if (isFile(c)) return c;
  }
  return null;
}

/** Match a `paths` pattern (with a single `*`) against a specifier. */
function matchAlias(pattern, spec) {
  const star = pattern.indexOf('*');
  if (star === -1) return spec === pattern ? '' : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (spec.length < prefix.length + suffix.length) return null;
  if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) return null;
  return spec.slice(prefix.length, spec.length - suffix.length);
}

export function resolveAlias(spec, options = {}) {
  if (typeof spec !== 'string' || spec.length === 0) return null;
  const repoDir = path.resolve(options.repoDir || process.cwd());
  const fromFile = options.fromFile ? path.resolve(options.fromFile) : null;
  const cfg = loadConfig(repoDir, fromFile);

  // 1 + 2: alias candidates (config paths first, then the built-in `@/`)
  const attempts = [];
  if (cfg) {
    for (const [pattern, targets] of Object.entries(cfg.paths)) {
      const star = matchAlias(pattern, spec);
      if (star === null) continue;
      for (const t of targets) {
        if (typeof t === 'string') attempts.push(path.resolve(cfg.baseUrl, t.replace(/\*/g, star)));
      }
    }
  }
  const atStar = matchAlias('@/*', spec) ?? matchAlias('~@/*', spec);
  if (atStar !== null) {
    const pkgRoot = nearestPkgRoot(fromFile, repoDir);
    const bases = fromFile
      ? [path.join(pkgRoot, 'src', atStar), path.join(pkgRoot, atStar)]
      : [];
    bases.push(path.join(repoDir, 'src', atStar), path.join(repoDir, atStar));
    for (const b of bases) attempts.push(b);
  }

  if (attempts.length) {
    for (const base of attempts) {
      const hit = resolveFile(base);
      if (hit) return toPosix(path.relative(repoDir, hit));
    }
    return null;
  }

  // 3: relative specifiers
  if (/^\.\.?([/\\]|$)/.test(spec)) {
    const base = path.resolve(fromFile ? path.dirname(fromFile) : repoDir, spec);
    const hit = resolveFile(base);
    return hit ? toPosix(path.relative(repoDir, hit)) : null;
  }

  // 4: absolute specifiers
  if (path.isAbsolute(spec)) {
    const hit = resolveFile(spec);
    return hit ? toPosix(path.relative(repoDir, hit)) : null;
  }

  return null;
}
