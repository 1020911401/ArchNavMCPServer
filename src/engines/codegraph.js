/**
 * CodeGraph engine adapter (external CLI: `codegraph` 1.6.x).
 *
 * Unified caller interface (shared with gitnexus.js and the archnav engine):
 *   callers(symbol, options) -> {
 *     symbol: string,
 *     callers: [{ file, line, enclosing, engine, source_kind }],
 *     raw,                 // raw CLI output (parsed object for JSON, string for text)
 *     error?: string       // only set on failure; never throws
 *   }
 *
 * Known limitation (transparently passed through, never hidden): CodeGraph's
 * static index misses call sites that live inside nested `.vue` callbacks, so a
 * symbol can legitimately come back with zero callers. Results are always
 * labelled with `engine` + `source_kind` so the fusion layer can weigh them.
 *
 *   source_kind: 'ast'    -> a real call edge (method/function caller)
 *                'import' -> a file-level import edge
 *                'template'-> reserved for template/handler-derived edges
 *                'heuristic'-> low-confidence/derived edges
 */
import { DEFAULT_TIMEOUT_MS, runCli, tryParseJson, safeRun } from './exec.js';

export const ENGINE = 'codegraph';
export const BIN = 'codegraph';

const CALLER_KINDS = 'method|function|file|constant|class|variable|module';

/**
 * Parse `codegraph callers <sym>` TEXT output.
 * Shape: a `<kind> <name>[ [imports]]` line immediately followed by an indented
 * `<file>:<line>` line.
 */
export function parseCallersText(raw, symbol) {
  const text = String(raw || '');
  const lines = text.split(/\r?\n/);
  const callers = [];
  const header = text.match(/Callers of "(.*?)"/);
  const nameRe = new RegExp(`^(${CALLER_KINDS})\\s+(\\S+)(?:\\s+\\[([^\\]]+)\\])?\\s*$`);
  const locRe = /^\s+(.+):(\d+)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(nameRe);
    if (!m) continue;
    const [, kind, callerName, tag] = m;
    let lineNo = null;
    let file = null;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      const loc = lines[j].match(locRe);
      if (loc) { file = loc[1].trim(); lineNo = Number.parseInt(loc[2], 10); }
      break;
    }
    if (!file) continue;
    callers.push({
      file,
      line: lineNo,
      enclosing: kind === 'file' ? null : callerName,
      engine: ENGINE,
      source_kind: tag === 'imports' ? 'import' : 'ast',
    });
  }
  return { symbol: header ? header[1] : symbol, callers, raw: text };
}

/** Normalise `codegraph callers --json` output. */
export function parseCallersJson(json, symbol, raw) {
  const callers = [];
  const rows = Array.isArray(json?.callers) ? json.callers : [];
  for (const c of rows) {
    const rels = Array.isArray(c.relationships) ? c.relationships : [];
    const isFile = c.kind === 'file';
    callers.push({
      file: c.filePath,
      line: c.startLine ?? null,
      enclosing: isFile ? null : (c.name ?? null),
      engine: ENGINE,
      // Provenance follows the relationship tag (matching the text parser):
      // an `imports` edge is an import; a file-level `calls` edge is still ast.
      source_kind: rels.includes('imports') ? 'import' : 'ast',
    });
  }
  return { symbol: json?.symbol ?? symbol, callers, raw: raw ?? json };
}

function knownJson(json) {
  return json && typeof json === 'object' && (Array.isArray(json.callers) || Array.isArray(json.definitions));
}

/**
 * Find callers of `symbol`.
 * options: { file, limit, projectDir, timeoutMs, runner }
 */
export async function callers(symbol, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = options.projectDir || options.cwd || process.cwd();
  const runner = options.runner || runCli;

  const base = ['callers', symbol];
  if (options.file) base.push('-f', options.file);
  if (options.limit) base.push('-l', String(options.limit));
  if (options.projectDir) base.push('-p', options.projectDir);

  // 1) prefer JSON
  const jsonRun = await safeRun(runner, BIN, [...base, '-j'], { cwd, timeoutMs });
  if (jsonRun.error && jsonRun.error !== 'cli_error') {
    return { symbol, callers: [], raw: jsonRun.stdout, error: jsonRun.error, stderr: jsonRun.stderr };
  }
  const parsedJson = tryParseJson(jsonRun.stdout);
  if (parsedJson && knownJson(parsedJson)) {
    return parseCallersJson(parsedJson, symbol, parsedJson);
  }

  // 2) fall back to text (and re-run without -j when the JSON run produced nothing usable)
  let textRun = jsonRun;
  if (!parsedJson || !String(jsonRun.stdout).trim()) {
    textRun = await safeRun(runner, BIN, base, { cwd, timeoutMs });
    if (textRun.error && !textRun.stdout) {
      return { symbol, callers: [], raw: textRun.stdout, error: textRun.error, stderr: textRun.stderr };
    }
  }
  const fromText = parseCallersText(textRun.stdout, symbol);
  if (fromText.callers.length > 0 || /Callers of/.test(textRun.stdout) || /no callers/.test(textRun.stdout)) {
    return fromText;
  }

  // 3) nothing usable → parse_failed, but keep every raw artifact
  const raw = jsonRun.stdout || textRun.stdout;
  const parseFailed = { symbol, callers: [], raw, error: 'parse_failed' };
  if (jsonRun.error) parseFailed.error = jsonRun.error;
  return parseFailed;
}

export default { ENGINE, BIN, callers, parseCallersText, parseCallersJson };
