/**
 * response-shape.mjs — M1 of docs/shape-check.md: how much of a handler's response
 * shape can be recovered, and when it honestly cannot.
 *
 * Measured before this existed (2026-10-30, real pair CRMEB/uni-app <-> laravel_crmeb,
 * 49 matched API pairs): only 3/49 (6%) keep literal keys in the controller, while
 * 34/49 (69%) delegate the shape to `app('json')->success($this->service->…)`.
 * So a shape check worth running has to follow one hop into the service — and then
 * stop, rather than guess through repositories/ORMs.
 *
 * Contract (charter §3.2):
 *   level: 'local'      the controller itself states the keys
 *          'service'    the controller delegates; the service states the keys
 *          'unresolved' nothing literal — caller must report 未核对, never a pass
 *   keys:  top-level response keys (depth-1 array keys / $var['k'] assignments)
 *   via:   every file consulted, so an unresolved result can explain itself
 *
 * Depth cap is 2 (controller -> service). A service that delegates again stops the
 * walk: inventing keys we cannot see is the false-positive class this refuses to make.
 */
import fs from 'node:fs';
import path from 'node:path';

const norm = (p) => String(p || '').replace(/\\/g, '/');
const MAX_FILES = 4000;
const MAX_DEPTH = 6;

function walk(dir, out = [], depth = MAX_DEPTH) {
  if (out.length > MAX_FILES || depth < 0) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/^(node_modules|vendor|\.git|storage|bootstrap)$/.test(e.name)) continue;
      walk(p, out, depth - 1);
    } else if (e.isFile()) out.push(p);
  }
  return out;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The raw body of `function <action>(...) { ... }`, brace-matched with quotes and
 * comments treated as opaque. Returns { body, startLine } or null.
 */
export function methodBody(src, action) {
  const sig = new RegExp(`\\bfunction\\s+${escapeRe(action)}\\s*\\(`);
  const m = sig.exec(src);
  if (!m) return null;

  // 1. walk the parameter list (a `;` or `{` may appear inside a default value's string)
  let i = m.index + m[0].length;
  let depth = 1;
  let quote = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth === 0) break; }
  }

  // 2. the opening brace, then brace-match to the closing one
  const open = src.indexOf('{', i);
  if (open < 0) return null;
  depth = 0;
  quote = null;
  let j = open;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (quote) {
      if (ch === '\\') { j += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && src[j + 1] === '/') { const nl = src.indexOf('\n', j); if (nl < 0) break; j = nl; continue; }
    if (ch === '/' && src[j + 1] === '*') { const close = src.indexOf('*/', j); if (close < 0) break; j = close + 1; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { j += 1; break; } }
  }
  return { body: src.slice(open + 1, j - 1), startLine: src.slice(0, open).split('\n').length };
}

/**
 * Every `return <stmt>;` from a method body. The statement ends at the first `;` at
 * bracket/paren depth 0, quotes opaque — a `;` inside a string stays inside the
 * statement, which is what keeps `'a;b' => 1` from truncating an array.
 */
function returnStatements(body) {
  const out = [];
  const re = /\breturn\b/g;
  let m;
  while ((m = re.exec(body))) {
    let depth = 0;
    let quote = null;
    let j = m.index;
    for (; j < body.length; j++) {
      const ch = body[j];
      if (quote) {
        if (ch === '\\') { j += 1; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === '(' || ch === '[') depth += 1;
      else if (ch === ')' || ch === ']') depth -= 1;
      else if (ch === ';' && depth === 0) break;
    }
    out.push({ index: m.index, text: body.slice(m.index, j) });
    re.lastIndex = Math.max(j, m.index + 6);
  }
  return out;
}

/** Top-level (`depth 1`) `'key' =>` entries of the first array literal in `text`. */
function keysInBracket(text) {
  const open = text.indexOf('[');
  if (open < 0) return [];
  let depth = 0;
  const keys = [];
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      // read the quoted segment, then ask whether `=>` follows: only keys are
      // followed by `=>` (values end with `,` or `]`)
      const quote = ch;
      let inner = '';
      let j = i + 1;
      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\') j += 1;
        inner += text[j] ?? '';
        j += 1;
      }
      if (depth === 1 && /=>/.test(text.slice(j + 1, j + 5))) keys.push(inner);
      i = j + 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') { depth -= 1; if (depth === 0) break; }
    i += 1;
  }
  return keys;
}

/**
 * L0 — a shape the method body itself states:
 *   (a) `return [ 'k' => … ]` / `return response()->json([ 'k' => … ])` (depth-1 keys)
 *   (b) `$data['k'] = …` assignments when the returned statement names `$data`
 */
function localShape(body) {
  for (const st of returnStatements(body)) {
    const bracket = keysInBracket(st.text);
    if (bracket.length) return { keys: [...new Set(bracket)] };

    const returned = st.text.match(/\$([A-Za-z_]\w*)/);
    if (returned) {
      const varName = returned[1];
      const assigns = [...body.matchAll(new RegExp(`\\$${escapeRe(varName)}\\s*\\[\\s*['"]([^'"]+)['"]\\s*\\]`, 'g'))]
        .map((m) => m[1]);
      if (assigns.length) return { keys: [...new Set(assigns)] };
    }
  }
  return null;
}

/** A shape the method delegates: `$this->service->foo(...)` or `FooService::foo(...)`. */
function delegate(body) {
  const svc = body.match(/\$this->(\w+)->(\w+)\s*\(/);
  if (svc) return { receiver: svc[1], method: svc[2] };
  const stat = body.match(/\b([A-Z][A-Za-z0-9_]*(?:Service|Repository))::(\w+)\s*\(/);
  if (stat) return { receiver: stat[1], method: stat[2] };
  return null;
}

function findPhpFiles(root, preferService) {
  const appRoot = path.join(root, 'app');
  const files = walk(fs.existsSync(appRoot) ? appRoot : root).filter((f) => /\.php$/i.test(f));
  return preferService
    ? [...files.filter((f) => /Service\.php$/i.test(f)), ...files.filter((f) => !/Service\.php$/i.test(f))]
    : files;
}

/**
 * `<controller short name>` → every file that could hold it (index first, basename
 * walk after). Multiple hits are kept: the real repo has two `ThemeController`s in
 * different modules, and picking the first one made five handlers report
 * `method-not-found` while `System/Http/Controllers/ThemeController` declared them
 * all. The caller picks by evidence — which candidate actually declares the action.
 */
function candidateControllerFiles({ root, controller, index }) {
  const raw = String(controller || '').trim();
  if (!raw) return [];
  const short = raw.split('\\').pop();
  const namespacePath = raw.replace(/^\\/, '').split('\\').slice(0, -1).join('/');
  const symbols = index?.symbols || [];
  const out = [];
  const seen = new Set();
  const push = (abs) => {
    const k = norm(abs);
    if (!seen.has(k)) { seen.add(k); out.push(abs); }
  };

  const fromIndex = symbols
    .filter((s) => s.kind === 'class' && (s.name === short || s.name === raw))
    .map((s) => path.join(root, s.file));
  for (const f of fromIndex) push(f);

  for (const f of findPhpFiles(root, false)) {
    if (path.basename(f) === `${short}.php`) push(f);
  }

  // a namespace in the route (`…\System\Http\Controllers\ThemeController`) is real
  // evidence about where the class lives — sort those first instead of guessing
  if (namespacePath) {
    const needle = norm(namespacePath).toLowerCase();
    out.sort((a, b) => Number(norm(b).toLowerCase().includes(needle)) - Number(norm(a).toLowerCase().includes(needle)));
  }
  return out.slice(0, 8);
}

/** `<method>` → its defining PHP file, services first (index first, walk after). */
function findMethodFile({ root, method, index, preferService }) {
  const symbols = index?.symbols || [];
  const sym = symbols.find((s) => s.name === method && /\.php$/i.test(norm(s.file)));
  if (sym && (!preferService || /Service\.php$/i.test(norm(sym.file)))) return path.join(root, sym.file);
  const escape = escapeRe(method);
  for (const f of findPhpFiles(root, preferService)) {
    const re = new RegExp(`\\bfunction\\s+${escape}\\s*\\(`);
    let src = null;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (re.test(src)) return f;
  }
  return null;
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * M2 (charter §3.3) — the frontend side: which response fields does the client read
 * for `<method> <path>`?
 *
 * Two hops: (1) the call site in the api layer gives us a *binding* (`orders: () =>
 * request.get(...)`, `export const orders = …`), (2) callers of that binding are where
 * `res.data.<field>` is read — the api file itself usually only forwards.
 * Returns `{level: 'resolved', reads:[{field,file,line}], via}` or
 * `{level:'unresolved', reason}` — never guesses: no caller, no reads, no answer.
 */
export function collectFrontendReads({ root, method, path: endpoint }) {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const verbRe = new RegExp(`\\brequest\\s*\\.\\s*${String(method).toLowerCase()}\\s*\\(\\s*['"]${escapeRe(endpoint)}['"]`);
  const files = walk(root, [], 8).filter((f) => /\.(vue|js|ts|mjs|cjs)$/i.test(f));
  const hosts = [];
  for (const f of files) {
    const src = read(f);
    if (!src || !verbRe.test(src)) continue;
    // (1) binding: the nearest `name: () =>` / `function name` / `export const name` above the call.
    // Captured with a group — re-matching `\\w*` over the whole match returned `export`
    // for `export const coupons = () =>` and no caller was ever found.
    const at = verbRe.exec(src);
    const head = src.slice(0, at.index);
    const fromDecl = [...head.matchAll(/(?:export\s+)?(?:const|let|var|function)\s+([A-Za-z_]\w*)\s*(?:=|\()/g)];
    const fromProp = [...head.matchAll(/([A-Za-z_]\w*)\s*:\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>/g)];
    const name = fromDecl.length ? fromDecl[fromDecl.length - 1][1] : (fromProp.length ? fromProp[fromProp.length - 1][1] : null);
    hosts.push({ file: f, name, src });
  }
  if (!hosts.length) return { level: 'unresolved', reason: 'endpoint-not-found', reads: [], via: [] };

  const via = hosts.map((h) => norm(path.relative(root, h.file)));
  const reads = [];
  const seen = new Set();
  const callRe = (name) => new RegExp(`\\b${escapeRe(name)}\\s*\\(`, 'g');   // `g` or exec() loops forever
  for (const h of hosts) {
    if (!h.name) continue;
    for (const f of files) {
      const src = read(f);
      if (!src) continue;
      let m;
      const re = callRe(h.name);
      while ((m = re.exec(src))) {
        const window = src.slice(m.index, m.index + 600);   // the call + its handler chain
        for (const r of window.matchAll(/(?:res|response|result|\br\b|x|d)\.data\.([A-Za-z_]\w*)/g)) {
          const key = `${r[1]}@${f}`;
          if (seen.has(key)) continue;
          seen.add(key);
          reads.push({
            field: r[1],
            file: norm(path.relative(root, f)),
            line: src.slice(0, m.index + r.index).split('\n').length,
          });
        }
      }
    }
  }
  if (!reads.length) return { level: 'unresolved', reason: 'no-callsite-reads', reads: [], via };
  return { level: 'resolved', reads, via: [...new Set([...via, ...reads.map((r) => r.file)])] };
}

/**
 * How much of the response shape is recoverable for `<controller>@<action>`?
 *
 * @param {{root: string, controller: string, action: string, index?: object, maxDepth?: number}} args
 * @returns {{level: 'local'|'service'|'unresolved', keys: string[], via: string[], depth?: number, reason?: string}}
 */
export function resolveHandlerShape({ root, controller, action, index = null, maxDepth = 2 }) {
  const via = [];
  const stop = (reason) => ({ level: 'unresolved', keys: [], via, reason });

  // pick the candidate controller file that actually declares `action` — ambiguity is
  // resolved by evidence (see candidateControllerFiles)
  const candidates = candidateControllerFiles({ root, controller, index });
  if (!candidates.length) return stop('controller-not-found');
  let picked = null;
  for (const file of candidates) {
    const src = read(file);
    const body = src && methodBody(src, action);
    if (body) { picked = { file, src, body }; break; }
    via.push(`${norm(path.relative(root, file))}:no ${action}()`);
  }
  if (!picked) return stop('method-not-found');
  via.push(`${norm(path.relative(root, picked.file))}::${action}`);

  const local = localShape(picked.body.body);
  if (local) return { level: 'local', keys: local.keys, via, depth: 1 };

  const del = delegate(picked.body.body);
  if (!del) return stop('no-literal-shape-no-delegate');
  if (maxDepth < 2) return stop('depth-cap');

  const serviceFile = findMethodFile({ root, method: del.method, index, preferService: true });
  if (!serviceFile) return stop('service-method-not-found');
  via.push(`${norm(path.relative(root, serviceFile))}::${del.method}`);

  const serviceSrc = read(serviceFile);
  const second = serviceSrc && methodBody(serviceSrc, del.method);
  if (!second) return stop('service-method-not-found');

  const local2 = localShape(second.body);
  if (local2) return { level: 'service', keys: local2.keys, via, depth: 2 };

  // a service that delegates again: beyond the charter's depth cap — say so instead of
  // inventing keys from a layer we were not asked to model
  if (delegate(second.body)) return stop('depth-cap');
  return stop('service-has-no-literal-shape');
}
