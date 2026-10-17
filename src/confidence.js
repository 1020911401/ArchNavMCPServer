/**
 * Confidence Module — Staleness detection and confidence scoring
 *
 * Staleness is driven by *content* drift, not by git:
 *   the index records `fileHashes` (see analyzer.js `hashContent`) and this
 *   module diffs the on-disk tree against those hashes.
 *
 * Fast path: a file whose mtime predates the index build (or whose size+mtime
 * are unchanged since the last check in this process) is trusted without being
 * read; only genuinely suspect files are hashed. Verdicts are cached per
 * directory, so repeated checks against 300+ files stay well under a second.
 *
 * The git commit comparison is retained, but only as *additional* metadata
 * (indexedCommit / currentHead) — it no longer decides `stale`.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { makeIgnoreFilter } from './analyzer.js';

// Same extension set the analyzer indexes.
const CODE_EXT =
  /\.(js|ts|tsx|jsx|mjs|cjs|py|go|rs|java|php|c|cpp|cc|cxx|h|hpp|hh|cs|rb|sh|bash|ps1|psm1|psd1)$/i;

// Index keys come from path.relative() (host separators — backslashes on
// Windows) while symbol.file uses forward slashes. Normalise for all lookups.
function normalizeRel(p) {
  return String(p).replace(/\\/g, '/');
}

// Must match analyzer.hashContent exactly: sha256 of the utf-8 text, first 12 hex.
function hashContent(content) {
  return createHash('sha256').update(content).digest('hex').substring(0, 12);
}

// Per-directory verdict cache: normalised rel path -> { size, mtimeMs, changed }.
// Lets repeated checks (same process, e.g. the MCP server) skip re-hashing.
const statCache = new Map(); // dirPath -> { indexMtimeMs, files: Map }

function indexCacheFor(dirPath, indexMtimeMs) {
  let entry = statCache.get(dirPath);
  if (!entry || entry.indexMtimeMs !== indexMtimeMs) {
    entry = { indexMtimeMs, files: new Map() };
    statCache.set(dirPath, entry);
  }
  return entry;
}

function readIndexMeta(dirPath) {
  const indexFile = path.join(dirPath, '.archnav', 'index.json');
  if (!fs.existsSync(indexFile)) {
    return { indexFile: null, index: null, indexMtimeMs: null };
  }
  let indexMtimeMs;
  try {
    indexMtimeMs = fs.statSync(indexFile).mtimeMs;
  } catch {
    return { indexFile, index: null, indexMtimeMs: null };
  }
  let index = null;
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
  } catch {
    index = null;
  }
  return { indexFile, index, indexMtimeMs };
}

function collectDiskFiles(dirPath) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && CODE_EXT.test(e.name)) out.push(full);
    }
  };
  walk(dirPath);
  return out;
}

/**
 * Diff the on-disk tree against `index.fileHashes`.
 *
 * @returns {{details: Array<{file:string,change:string,symbolsAffected:number}>,
 *            total:number, unchanged:number}}
 *   `details[].file` is a forward-slash relative path; `change` is one of
 *   'modified' | 'deleted' | 'added'.
 */
function diffIndex(dirPath, index, indexMtimeMs) {
  const fileHashes = index?.fileHashes || {};
  const keys = Object.keys(fileHashes);
  const normIndex = new Set(keys.map(normalizeRel));

  // symbols per normalised file → "symbolsAffected"
  const symCount = new Map();
  for (const s of index?.symbols || []) {
    const n = normalizeRel(s.file);
    symCount.set(n, (symCount.get(n) || 0) + 1);
  }

  const cache = indexCacheFor(dirPath, indexMtimeMs).files;
  const details = [];
  let unchanged = 0;

  for (const key of keys) {
    const norm = normalizeRel(key);
    const abs = path.resolve(dirPath, key);

    let st = null;
    try {
      st = fs.statSync(abs);
    } catch {
      st = null;
    }

    if (!st) {
      details.push({ file: norm, change: 'deleted', symbolsAffected: symCount.get(norm) || 0 });
      continue;
    }

    let changed;
    const hit = cache.get(norm);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      // size+mtime unchanged since last verification → reuse verdict, no I/O.
      changed = hit.changed;
    } else if (st.mtimeMs < indexMtimeMs) {
      // File predates the index build → it cannot have changed since indexing.
      changed = false;
      cache.set(norm, { size: st.size, mtimeMs: st.mtimeMs, changed: false });
    } else {
      // Suspect: verify content. Newer-but-identical (touch/git) → not changed.
      let hash = null;
      try {
        hash = hashContent(fs.readFileSync(abs, 'utf-8'));
      } catch {
        hash = null;
      }
      changed = hash === null ? true : hash !== fileHashes[key];
      cache.set(norm, { size: st.size, mtimeMs: st.mtimeMs, changed });
    }

    if (changed) {
      details.push({ file: norm, change: 'modified', symbolsAffected: symCount.get(norm) || 0 });
    } else {
      unchanged++;
    }
  }

  // Newly added code files that the index never saw (honour the index's own
  // `ignore` list: a file excluded at analyze time must not read as "added").
  const ignored = makeIgnoreFilter(index?.ignore || []);
  let added = 0;
  for (const abs of collectDiskFiles(dirPath)) {
    const rel = normalizeRel(path.relative(dirPath, abs));
    if (ignored(rel)) continue;
    if (!normIndex.has(rel)) {
      details.push({ file: rel, change: 'added', symbolsAffected: 0 });
      added++;
    }
  }

  return { details, total: keys.length + added, unchanged };
}

/**
 * Check staleness of the index vs current code on disk.
 *
 * Backwards-compatible return shape:
 *   { stale, overallConfidence, indexedCommit, currentHead, changedFiles,
 *     indexAge, changedDetails, warnings? }
 * `changedDetails[].symbolsAffected` is preserved; each entry also carries
 * `change` ('modified' | 'deleted' | 'added').
 */
export async function checkStaleness(dirPath) {
  const result = {
    stale: false,
    overallConfidence: 1.0,
    indexedCommit: null,
    currentHead: null,
    changedFiles: 0,
    indexAge: null,
    changedDetails: [],
  };

  const { index, indexMtimeMs } = readIndexMeta(dirPath);

  // ── Index age (works with or without git) ────────────────────────────────
  if (indexMtimeMs != null) {
    const ageMs = Date.now() - indexMtimeMs;
    const ageHours = ageMs / 3600000;
    result.indexAge =
      ageHours < 1
        ? `${Math.round(ageMs / 60000)}m`
        : ageHours < 24
          ? `${Math.round(ageHours)}h`
          : `${Math.round(ageHours / 24)}d`;
  }

  // ── Additional (informational) git info ──────────────────────────────────
  try {
    const gitDir = path.join(dirPath, '.git');
    const headFile = path.join(gitDir, 'HEAD');
    const archnavCommitFile = path.join(dirPath, '.archnav', 'commit');
    if (fs.existsSync(headFile) && fs.existsSync(archnavCommitFile)) {
      const headContent = fs.readFileSync(headFile, 'utf-8').trim();
      let currentCommit = headContent;
      if (headContent.startsWith('ref: ')) {
        currentCommit = fs.readFileSync(path.join(gitDir, headContent.substring(5)), 'utf-8').trim();
      }
      result.indexedCommit = fs.readFileSync(archnavCommitFile, 'utf-8').trim();
      result.currentHead = currentCommit;
    }
  } catch {
    /* git metadata is purely informational */
  }

  // ── Content comparison — the real staleness signal ──────────────────────
  if (index && index.fileHashes && Object.keys(index.fileHashes).length > 0) {
    let diff;
    try {
      diff = diffIndex(dirPath, index, indexMtimeMs);
    } catch (e) {
      result.warnings = [`Content comparison failed: ${e.message}`];
      diff = null;
    }

    if (diff) {
      const changedFiles = diff.details.length;
      result.changedFiles = changedFiles;
      result.changedDetails = diff.details;
      result.stale = changedFiles > 0;

      if (changedFiles > 0) {
        // Fresh == exactly 1.0. Any drift caps confidence at 0.9 (so a stale
        // index is never rounded up to "100% fresh") and scales down with how
        // much of the tree drifted, down to a 0.2 floor.
        const ratio = changedFiles / Math.max(1, diff.total);
        const severity = Math.min(1, ratio * 2);
        result.overallConfidence = Number(Math.max(0.2, 0.9 - 0.7 * severity).toFixed(4));
      }
    }
  } else if (index) {
    result.warnings = ['Index has no fileHashes — content-level staleness unavailable'];
  }

  return result;
}

/**
 * Per-symbol confidence.
 *
 * Returns 1.0 when the symbol's file still matches the indexed hash and a
 * graduated value in [0.28, 0.5] when it has changed (lower as the index gets
 * older); 0.1 when the file is gone.
 *
 * @param {{file?:string}|string} symbol  symbol object or its file path
 * @param {object} index                  the loaded .archnav/index.json
 * @param {string} dirPath                project root the index belongs to
 */
export function symbolConfidence(symbol, index, dirPath) {
  const file = typeof symbol === 'string' ? symbol : symbol?.file;
  if (!file) return 1.0;

  const fileHashes = index?.fileHashes || {};
  const norm = normalizeRel(file);

  let indexedHash = fileHashes[file];
  if (indexedHash === undefined) {
    for (const k of Object.keys(fileHashes)) {
      if (normalizeRel(k) === norm) {
        indexedHash = fileHashes[k];
        break;
      }
    }
  }

  let content = null;
  try {
    content = fs.readFileSync(path.resolve(dirPath || '.', file), 'utf-8');
  } catch {
    content = null; // file removed
  }

  if (content === null) return 0.1; // gone — worst case
  if (indexedHash === undefined) return 1.0; // not indexed → cannot judge
  if (hashContent(content) === indexedHash) return 1.0; // unchanged

  // Changed: graduate 0.5 → 0.28 as the index ages (0h → 72h+).
  let severity = 0;
  const { indexMtimeMs } = readIndexMeta(dirPath || '.');
  if (indexMtimeMs != null) {
    severity = Math.min(1, (Date.now() - indexMtimeMs) / (72 * 3600000));
  }
  return Number(Math.max(0.28, 0.5 - 0.22 * severity).toFixed(4));
}

/**
 * Compute confidence for a specific symbol/file (backwards-compatible wrapper).
 * Kept for callers such as navigation.js locate().
 */
export function computeConfidence(symbolFile, fileHashes, freshness, dirPath) {
  return symbolConfidence({ file: symbolFile }, { fileHashes: fileHashes || {} }, dirPath);
}
