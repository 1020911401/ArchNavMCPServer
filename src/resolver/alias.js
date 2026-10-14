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
 *   2. `@/x/y` → `<repoDir>/x/y` — the default alias, applied even when a config
 *      exists (a config-defined `@/*` mapping takes precedence).
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

function loadConfig(repoDir, fromFile) {
  const dirs = [];
  if (fromFile) {
    let d = path.dirname(fromFile);
    for (;;) {
      dirs.push(d);
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  if (repoDir) dirs.push(repoDir);
  const seen = new Set();
  for (const d of dirs) {
    if (seen.has(d)) continue;
    seen.add(d);
    for (const name of ['jsconfig.json', 'tsconfig.json']) {
      const p = path.join(d, name);
      if (!fs.existsSync(p)) continue;
      const json = readJson(p);
      const co = json && json.compilerOptions;
      if (co && (co.paths || co.baseUrl)) {
        return { baseUrl: path.resolve(d, co.baseUrl || '.'), paths: co.paths || {} };
      }
    }
  }
  return null;
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
  const atStar = matchAlias('@/*', spec);
  if (atStar !== null) attempts.push(path.resolve(repoDir, atStar));

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
