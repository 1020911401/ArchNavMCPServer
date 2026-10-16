// bench/gen_ground_truth.mjs
//
// Ground-truth scanner for the ArchNav benchmark fixtures.
// Zero dependencies, Node ESM. Replaces the throwaway Python scripts that
// used to live outside the repo (see bench/README.md for provenance).
//
// Exports:
//   scanRepo(repoDir)             -> one-shot raw line data for every source file
//   groundTruth(repoDir, symbol)  -> { defs, callSites, callerFiles }
//
// ---------------------------------------------------------------------------
// DETECTION RULES (kept deliberately simple + line oriented so the numbers are
// reproducible with plain grep; see README for the exact grep equivalents).
//
// Scanned extensions: .php, .js, .mjs, .ts, .vue
//   (.blade.php ends in .php and is therefore covered by the .php rule.)
//
// Skipped directories (anywhere in the tree, matched by basename):
//   node_modules, .git, .codegraph, .gitnexus, .archnav
//
// A line is a COMMENT line when its trimmed text starts with "//" or "*".
// Comment lines are never counted as call sites.
//
// DEFINITION line (a function/method whose body is being declared here):
//   PHP  : ^\s*(?:(?:public|private|protected|static|final|abstract|readonly)\s+)*function\s+NAME\s*\(
//   JS   : ^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*NAME\s*\(
//          ^\s*(?:export\s+)?(?:const|let|var)\s+NAME\s*=\s*(?:async\s+)?(?:function\b|\()
//   (ONE name per line: the first one the pattern captures.)
//
// CALL-SITE line candidate:
//   PHP  : (?:->|::)\s*NAME\s*\(          e.g. $this->departments()  Presenter::render()
//   JS   : (?<![\w.$])NAME\s*\(           bare call, not preceded by a dot / word char / $
//
// groundTruth() then filters line records:
//   defs      = lines whose definition name === symbol
//   callSites = lines that mention symbol as a call candidate AND
//               are NOT comment lines AND are NOT a definition line for symbol.
//   callerFiles = unique posix-relative files of callSites (sorted).
//
// NOTE on imports: a JS `import { orderTake } from ...` line has no "(" after
// the name, so it is not a call candidate and never shows up as a call site.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.codegraph', '.gitnexus', '.archnav',
]);

const SCAN_EXTS = new Set(['.php', '.js', '.mjs', '.ts', '.vue']);

const PHP_DEF_RE =
  /^\s*(?:(?:public|private|protected|static|final|abstract|readonly)\s+)*function\s+([A-Za-z_]\w*)\s*\(/;
const PHP_CALL_RE = /(?:->|::)\s*([A-Za-z_]\w*)\s*\(/g;

const JS_DEF_FN_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/;
const JS_DEF_ASSIGN_RE =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\()/;
const JS_CALL_RE = /(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g;
// Object/class method shorthand — `getUserInfo(code) {` inside a Vue component's
// `methods:{}` or a plain object. Without this, such a *definition* line is
// miscounted as a call site (verified on components/Authorize.vue,
// libs/routine.js, pages/users/scan_login/index.vue).
const JS_DEF_METHOD_RE =
  /^\s*(?:(?:async|static|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*\{/;

const TEXT_CAP = 200;

/** Control-flow keywords that look like `name(...) {` but are not methods. */
const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'do', 'else', 'with',
]);

function langOf(ext) {
  if (ext === '.php') return 'php';
  if (ext === '.js' || ext === '.mjs' || ext === '.ts' || ext === '.vue') return 'js';
  return null;
}

/** Recursively collect scannable files. Returns posix-relative paths. */
function listSourceFiles(repoDir) {
  const out = [];
  const walk = (absDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable dir: skip, never crash the scan
    }
    for (const ent of entries) {
      const abs = path.join(absDir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(abs);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!SCAN_EXTS.has(ext)) continue;
        const rel = path.relative(repoDir, abs).split(path.sep).join('/');
        out.push({ abs, rel, ext });
      }
    }
  };
  walk(repoDir);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** Classify a single source line: definition name, call candidates, comment flag. */
function classifyLine(text, lang) {
  const trimmed = text.trim();
  const isComment = trimmed.startsWith('//') || trimmed.startsWith('*');

  let defName = null;
  let methodDefName = null;
  const callNames = [];

  if (lang === 'php') {
    const d = PHP_DEF_RE.exec(text);
    if (d) defName = d[1];
    PHP_CALL_RE.lastIndex = 0;
    let m;
    while ((m = PHP_CALL_RE.exec(text)) !== null) callNames.push(m[1]);
  } else {
    const d1 = JS_DEF_FN_RE.exec(text);
    const d2 = d1 ? null : JS_DEF_ASSIGN_RE.exec(text);
    if (d1) defName = d1[1];
    else if (d2) defName = d2[1];
    if (!defName) {
      const d3 = JS_DEF_METHOD_RE.exec(text);
      // `if (...)` / `for (...)` style keywords are not method definitions
      if (d3 && !JS_KEYWORDS.has(d3[1])) methodDefName = d3[1];
    }
    JS_CALL_RE.lastIndex = 0;
    let m;
    while ((m = JS_CALL_RE.exec(text)) !== null) callNames.push(m[1]);
  }

  return {
    isComment,
    defName,
    methodDefName,
    callNames: [...new Set(callNames)],
  };
}

/**
 * One-shot scan of every .php/.js/.mjs/.ts/.vue file under repoDir.
 * Returns { root, files: [{ rel, ext, lang, lines: [{ line, text, isComment, defName, callNames }] }] }
 * `text` is the trimmed line, truncated to TEXT_CAP chars.
 */
export function scanRepo(repoDir) {
  const root = path.resolve(repoDir);
  const files = [];
  for (const { abs, rel, ext } of listSourceFiles(root)) {
    const lang = langOf(ext);
    let raw;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch {
      try {
        raw = fs.readFileSync(abs, 'latin1');
      } catch {
        continue;
      }
    }
    const lines = [];
    const split = raw.split(/\r\n|\r|\n/);
    for (let i = 0; i < split.length; i++) {
      const rawLine = split[i];
      const trimmed = rawLine.trim();
      if (trimmed === '') {
        // keep the slot so line numbers stay true, but store nothing useful
        lines.push({ line: i + 1, text: '', isComment: false, defName: null, methodDefName: null, callNames: [] });
        continue;
      }
      const c = classifyLine(rawLine, lang);
      lines.push({
        line: i + 1,
        text: trimmed.length > TEXT_CAP ? trimmed.slice(0, TEXT_CAP) : trimmed,
        isComment: c.isComment,
        defName: c.defName,
        methodDefName: c.methodDefName,
        callNames: c.callNames,
      });
    }
    files.push({ rel, ext, lang, lines });
  }
  return { root, files };
}

/**
 * Ground truth for one symbol.
 *
 * Definition lines are never call sites: PHP `function x(` / JS `function x(` /
 * `const x = (` / object-method shorthand `x(...) {` are all excluded, for the
 * same reason the analyzer would not report them as callers.
 *
 * @returns {{ defs: {file,line}[], methodDefs: {file,line,text}[],
 *             callSites: {file,line,text}[], callerFiles: string[] }}
 */
export function groundTruth(repoDir, symbol) {
  const scan = scanRepo(repoDir);
  const defs = [];
  const methodDefs = [];
  const callSites = [];

  for (const f of scan.files) {
    for (const ln of f.lines) {
      if (ln.defName === symbol) {
        defs.push({ file: f.rel, line: ln.line });
        continue; // a definition line is never a call site of itself
      }
      if (ln.methodDefName === symbol) {
        // Shorthand method definition (`getUserInfo() {`): it declares a local
        // symbol, it does not call the one under test.
        methodDefs.push({ file: f.rel, line: ln.line, text: ln.text });
        continue;
      }
      if (ln.isComment) continue;
      if (ln.callNames.includes(symbol)) {
        callSites.push({ file: f.rel, line: ln.line, text: ln.text });
      }
    }
  }

  const byPos = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter((x) => {
      const k = `${x.file}:${x.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const sortedDefs = dedupe(defs).sort(byPos);
  const sortedMethodDefs = dedupe(methodDefs).sort(byPos);
  const sortedCalls = dedupe(callSites).sort(byPos);
  const callerFiles = [...new Set(sortedCalls.map((c) => c.file))].sort();

  return {
    defs: sortedDefs,
    methodDefs: sortedMethodDefs,
    callSites: sortedCalls,
    callerFiles,
  };
}

export default groundTruth;
