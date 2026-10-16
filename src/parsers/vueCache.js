/**
 * Shared, bounded parse cache for the SFC / module-graph layer.
 *
 * Why this exists: one `analyze` run parses every `.vue` file twice — once for
 * symbols (`src/analyzer.js` → `parsers/vueSymbols.js`) and once for call/import
 * edges (`src/resolver/index.js` → `scanModules`). Both passes hand the *same*
 * `<script>` body to `resolver/vue-sfc.js`, so a process-wide cache turns the
 * second parse into a lookup (~5s of a ~17s run on the 269-SFC uni-app bench).
 *
 * ── Keying ───────────────────────────────────────────────────────────────────
 *   script blocks → (absolute path, size, mtimeMs). A file edited on disk
 *                   re-keys itself, so no pass is ever served a stale block
 *                   list; the key is absolute, so two repos with the same
 *                   relative path can never collide.
 *   parsed ASTs   → the script body text itself. This is a content key: V8
 *                   hashes the string, so identical content is a hit and *any*
 *                   difference — including a same-size edit — is a miss. Two
 *                   different files can therefore share an entry only when their
 *                   bytes are identical, in which case the AST is identical by
 *                   construction. (Nothing mutates these trees: collectCalls()
 *                   and collectBlockSymbols() never annotate a node, no hidden
 *                   `.parent` links are attached, so handing the same tree to
 *                   both passes is safe.)
 *
 * ── Bounded ──────────────────────────────────────────────────────────────────
 * Both caches evict oldest-first once they hit their entry OR byte budget, so a
 * long-lived process (the MCP server) cannot grow without limit. The budgets sit
 * far above a real corpus — the uni-app bench is ~2.5 MB of script across 333
 * module files — so a normal run keeps the whole graph resident; a pathological
 * repo just loses cache hits instead of memory.
 */
import fs from 'fs';
import path from 'path';

export const CACHE_LIMITS = {
  /** script-block entries (one per file) */
  blocksEntries: 1024,
  /** raw text held by the block cache */
  blocksBytes: 48 * 1024 * 1024,
  /** parsed ASTs (one per distinct script body) */
  astEntries: 2048,
  /** script-body bytes held by the AST cache */
  astBytes: 8 * 1024 * 1024,
};

const stats = {
  /** script bodies actually handed to a parser */
  parses: 0,
  /** parse requests answered from the AST cache */
  astHits: 0,
  /** script-block requests answered from the block cache */
  blocksHits: 0,
  /** script-block requests that had to be (re)split — cache misses */
  blocksMisses: 0,
  /** entries dropped to stay within a budget */
  evictions: 0,
};

export function cacheStats() {
  return { ...stats };
}

export function cacheSizes() {
  return {
    blocks: blocks.size,
    blocksBytes: blocks.bytes,
    ast: astPlain.size + astJsx.size,
    astBytes: astPlain.bytes + astJsx.bytes,
    bytes: blocks.bytes + astPlain.bytes + astJsx.bytes,
  };
}

export function clearParseCache() {
  blocks.clear();
  astPlain.clear();
  astJsx.clear();
}

/**
 * Map with LRU insertion order + an entry and a byte budget.
 * `get()` re-inserts the entry so the eviction order really is oldest-used-first.
 */
class Lru {
  constructor(entryLimit, byteLimit) {
    this.map = new Map();
    this.entryLimit = entryLimit;
    this.byteLimit = byteLimit;
    this.bytes = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key, value, size = 0) {
    const prev = this.map.get(key);
    if (prev !== undefined) {
      this.map.delete(key);
      this.bytes -= prev.size;
    }
    this.map.set(key, { value, size });
    this.bytes += size;
    while (this.map.size > this.entryLimit || (this.bytes > this.byteLimit && this.map.size > 1)) {
      const oldest = this.map.keys().next().value;
      const dropped = this.map.get(oldest);
      this.map.delete(oldest);
      this.bytes -= dropped.size;
      stats.evictions++;
    }
  }

  get size() { return this.map.size; }

  clear() { this.map.clear(); this.bytes = 0; }
}

const blocks = new Lru(CACHE_LIMITS.blocksEntries, CACHE_LIMITS.blocksBytes);
const astPlain = new Lru(CACHE_LIMITS.astEntries, CACHE_LIMITS.astBytes);
const astJsx = new Lru(CACHE_LIMITS.astEntries, CACHE_LIMITS.astBytes);

/**
 * Script blocks of a file, split at most once per (path, size, mtimeMs).
 *
 * @param {string} filePath  absolute (or resolvable) path of the file
 * @param {string} [content] the file's text when the caller already has it —
 *        it is authoritative: if it differs from what the cache holds for that
 *        path, the blocks are rebuilt from it.
 * @param {(filePath: string, raw: string) => Array} split  block splitter
 */
export function getCachedBlocks(filePath, content, split) {
  const key = path.resolve(filePath);

  let st = null;
  try { st = fs.statSync(key); } catch { st = null; }

  const cached = blocks.get(key);
  if (cached) {
    const entry = cached.value;
    if (typeof content === 'string') {
      if (entry.raw === content) { stats.blocksHits++; return entry.blocks; }
      // a caller-supplied body that disagrees with the cache wins: fall through
    } else if (st && entry.size === st.size && entry.mtimeMs === st.mtimeMs) {
      stats.blocksHits++;
      return entry.blocks;
    }
  }

  // Miss — read (or trust the supplied text), split, memoise.
  const raw = typeof content === 'string' ? content : fs.readFileSync(key, 'utf8');
  stats.blocksMisses++;
  const value = split(key, raw);
  const entry = { size: st ? st.size : -1, mtimeMs: st ? st.mtimeMs : -1, raw, blocks: value };
  blocks.set(key, entry, raw.length);
  return value;
}

/**
 * Parse a script body at most once per distinct content (per `jsx` flag).
 *
 * @param {*} source             script text; non-strings bypass the cache
 * @param {boolean} jsx
 * @param {(source: any, jsx: boolean) => object|null} parse  the real parser
 */
export function getCachedAst(source, jsx, parse) {
  if (typeof source !== 'string') return parse(source, jsx);

  const cache = jsx ? astJsx : astPlain;
  const hit = cache.get(source);
  if (hit !== undefined) {
    stats.astHits++;
    return hit.value;
  }

  stats.parses++;
  const ast = parse(source, jsx);
  cache.set(source, ast, source.length);
  return ast;
}
