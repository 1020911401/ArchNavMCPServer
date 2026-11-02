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
      // build output must not be scanned: on the real uni-app pair a hit was attributed
      // to `unpackage/dist/dev/mp-weixin/pages/…` — the same read counted twice, once
      // from source and once from the bundle
      if (/^(node_modules|vendor|\.git|storage|bootstrap|unpackage|dist|build|coverage|\.hbuilderx|\.svn)$/.test(e.name)) continue;
      walk(p, out, depth - 1);
    } else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * Array/collection/string members — never response fields: `res.data.length` is the
 * payload's own length, `res.data.map(...)` a method (guarded separately). Measured on
 * the real pair: `length` was reported as a "missing field" for two handlers before
 * this list existed (2026-11-01).
 */
const NON_FIELD = new Set([
  'length', 'size', 'constructor', 'map', 'filter', 'find', 'findIndex', 'includes',
  'slice', 'concat', 'sort', 'join', 'reverse', 'reduce', 'reduceRight', 'some',
  'every', 'indexOf', 'lastIndexOf', 'flat', 'flatMap', 'keys', 'values', 'entries',
  'push', 'pop', 'shift', 'unshift', 'splice', 'isArray', 'toString', 'charAt',
]);

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
 *
 * Every `return` contributes (early `return ['id' => …]` branches are real shapes the
 * client can read), and a return we cannot expand (an expression, a collection, a
 * variable with no `[…]` assignments) marks the result `partial`: the union is then a
 * lower bound, not the truth — the caller must not compare it as if it were the shape.
 */
function localShape(body) {
  const stmts = returnStatements(body);
  if (!stmts.length) return null;
  const keys = new Set();
  let partial = false;
  for (const st of stmts) {
    const bracket = keysInBracket(st.text);
    if (bracket.length) { for (const k of bracket) keys.add(k); continue; }

    // `compact('list','count','codeUrl')` — keys come from variable NAMES, so every
    // literal-key reader misses them (measured 2026-11-02: `codeUrl` was reported as
    // missing while `DivisionService` returns exactly that via compact()).
    const compacted = compactKeys(st.text);
    if (compacted.length) { for (const k of compacted) keys.add(k); continue; }

    const returned = st.text.match(/\$([A-Za-z_]\w*)/);
    if (returned) {
      const varName = returned[1];
      const assigns = [...body.matchAll(new RegExp(`\\$${escapeRe(varName)}\\s*\\[\\s*['"]([^'"]+)['"]\\s*\\]`, 'g'))]
        .map((m) => m[1]);
      if (assigns.length) { for (const k of assigns) keys.add(k); continue; }
      partial = true;                 // returns a variable we cannot expand into keys
      continue;
    }
    partial = true;                   // returns an expression (collection / object / call chain)
  }
  if (!keys.size) return null;
  return { keys: [...keys], ...(partial ? { partial: true } : {}) };
}

/**
 * No return path at all, but `throw` statements: a stub / degraded endpoint. The client's
 * success handler is unreachable, so nothing may be reported about the fields it reads.
 */
function isThrowingStub(body) {
  if (returnStatements(body).length > 0) return false;
  return /\bthrow\b/.test(body);
}

/**
 * `compact('a','b')` / `compact(['a','b'])` — PHP builds the response keys from the
 * variable NAMES, so neither a bracket reader nor a `$v['k']` reader sees them.
 * Measured 2026-11-02: `DivisionService` returns `compact('list','count','codeUrl')`.
 */
function compactKeys(text) {
  const out = [];
  for (const m of String(text).matchAll(/\bcompact\s*\(([^)]*)\)/g)) {
    for (const q of m[1].matchAll(/['"]([A-Za-z_]\w*)['"]/g)) out.push(q[1]);
  }
  return out;
}

/**
 * The call expression starting at `start`, plus its own `.then/.catch/.finally` chain —
 * string- and paren-aware. Replaces the fixed 600-char window, which crossed into the
 * NEXT call and attributed that call's reads to this endpoint (measured 2026-11-02:
 * `res.data.downloadBase64` belongs to `getInvoiceLink()`, but landed inside
 * `getOrderList()`'s window).
 *
 * Trade-off, deliberately taken: `const res = await api(); …res.data.x` has no chain, so
 * its reads are not collected — the pair stays unresolved and the declaration-search
 * stage answers instead. A narrow window with an honest fallback beats a wide window
 * that invents findings.
 */
function callWindow(src, start) {
  const closeOf = (openIdx) => {
    let depth = 0;
    for (let i = openIdx; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === '`') {
        i += 1;
        while (i < src.length && src[i] !== ch) { if (src[i] === '\\') i += 1; i += 1; }
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') { depth -= 1; if (depth === 0) return i; }
    }
    return -1;
  };
  const open = src.indexOf('(', start);
  if (open < 0) return src.slice(start, start + 600);
  let end = closeOf(open);
  if (end < 0) return src.slice(start, start + 600);
  for (;;) {
    const rest = src.slice(end + 1);
    const m = /^\s*\.\s*(?:then|catch|finally)\s*\(/.exec(rest);
    if (!m) break;
    const open2 = end + m[0].length;
    const end2 = closeOf(open2);
    if (end2 < 0) break;
    end = end2;
  }
  return src.slice(start, end + 1);
}

/**
 * The service call that PRODUCES the response: `$this->service->foo(...)` or
 * `FooService::foo(...)`.
 *
 * `return` statements win over the rest of the body. Measured 2026-11-02: a handler
 * shaped like
 *     if ($err = $this->service->verifySmsCode(...)) { return fail($err); }
 *     return success($this->service->phoneLogin(...));
 * had its *guard* call read as the shape source, so the resolver described
 * `verifySmsCode`'s body instead of the response builder — and with a stub service that
 * turned a "always throws" endpoint into a "no literal shape" one.
 */
function delegate(body) {
  const pick = (text) => {
    if (!text) return null;
    const svc = /\$this->(\w+)->(\w+)\s*\(/.exec(text);
    if (svc) return { receiver: svc[1], method: svc[2] };
    const stat = /\b([A-Z][A-Za-z0-9_]*(?:Service|Repository))::(\w+)\s*\(/.exec(text);
    if (stat) return { receiver: null, method: stat[2] };
    return null;
  };
  const fromReturns = returnStatements(body).map((s) => s.text).join('\n');
  return pick(fromReturns) || pick(body);
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
        const window = callWindow(src, m.index);   // this call + its own .then/.catch chain
        for (const r of window.matchAll(/(?:res|response|result|\br\b|x|d)\.data\.([A-Za-z_]\w*)/g)) {
          // The window can CUT an identifier at its edge: a read at abs 2272 inside a
          // window ending at 2289 turned `res.data.customer_url` into a phantom field
          // `customer` (measured on the real pair, 2026-11-01 — the whole file contained
          // no bare `.data.customer`). Re-assemble the tail from the full source first.
          const absStart = m.index + r.index;
          const absEnd = absStart + r[0].length;
          const tail = (src.slice(absEnd).match(/^[A-Za-z0-9_]*/) || [''])[0];
          const field = r[1] + tail;
          // `res.data.map(...)` / `.filter(...)` are method calls on the payload, not
          // fields — a lookahead inside the window does not work (`\w*` backtracks:
          // `map` fails, `ma` succeeds), so ask explicitly once the name is whole.
          if (/^\s*\(/.test(src.slice(absEnd + tail.length, absEnd + tail.length + 12))) continue;
          if (NON_FIELD.has(field)) continue;          // payload members (length, map…) are not fields
          const key = `${field}@${f}`;
          if (seen.has(key)) continue;
          seen.add(key);
          reads.push({
            field,
            file: norm(path.relative(root, f)),
            line: src.slice(0, absStart).split('\n').length,
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
  if (local) return { level: 'local', keys: local.keys, ...(local.partial ? { partial: true } : {}), via, depth: 1 };

  if (isThrowingStub(picked.body.body)) return stop('handler-throws');

  const del = delegate(picked.body.body);
  if (!del) return stop('no-literal-shape-no-delegate');
  if (maxDepth < 2) return stop('depth-cap');

  // Depth-1 delegate: pick the service the CONTROLLER actually injected (constructor
  // type-hint), not "the first *Service.php that happens to declare a method this
  // name". Measured 2026-11-01: `KefuV2Controller` injects `V2KefuService`, while 8+
  // services declare `record()` — name order picked a stranger, and its keys
  // (`list, count`) became the "backend shape" for an endpoint whose real handler
  // returns `serviceList`. The hint comes from the CLASS source (picked.src): a method
  // body never contains `__construct`, which is why every earlier hint attempt fell
  // silently back to name order.
  const hintedClass = constructorTypeOf(picked.src, del.receiver);
  let serviceFile = null;
  let usedHint = false;
  if (hintedClass) {
    const candidate = findPhpFileByClass(root, hintedClass, index);
    if (candidate) {
      const src = read(candidate);
      if (src && methodBody(src, del.method)) { serviceFile = candidate; usedHint = true; }
    }
  }
  if (!serviceFile) serviceFile = findMethodFile({ root, method: del.method, index, preferService: true });
  if (!serviceFile) return stop('service-method-not-found');
  via.push(`${norm(path.relative(root, serviceFile))}::${del.method}${usedHint ? ` [ctor hint: ${hintedClass}]` : ''}`);

  const serviceSrc = read(serviceFile);
  const second = serviceSrc && methodBody(serviceSrc, del.method);
  if (!second) return stop('service-method-not-found');

  const local2 = localShape(second.body);
  if (local2) return { level: 'service', keys: local2.keys, ...(local2.partial ? { partial: true } : {}), via, depth: 2 };

  // A service body with NO return path but `throw` statements is a deliberate stub /
  // degraded endpoint ("旧 xxx → 一律失败"). Its success handler cannot run, so neither
  // shape comparison nor declaration search may report against the client's dead branch.
  // Measured 2026-11-02: `V2AuthService`'s five auth methods all throw, and they produced
  // 4 of the 6 "confirmed" missing-field findings.
  if (isThrowingStub(second.body)) return stop('handler-throws');

  const del2 = delegate(second.body);
  if (!del2) return stop('service-has-no-literal-shape');
  if (maxDepth < 3) return stop('depth-cap');

  // M4 (charter §5): one more hop into the dependency the service injected. Evidence
  // first — the constructor type-hint tells us which class `$this->repository` actually
  // is — then the file that declares the method. Returned as level `repo`, which the
  // comparability gate only accepts once the measured agreement between these keys and
  // what clients read supports it (docs/shape-check.md §2.3).
  const hinted = constructorTypeOf(serviceSrc, del2.receiver);
  const hop3File = (hinted && findPhpFileByClass(root, hinted, index))
    || findMethodFile({ root, method: del2.method, index, preferService: false });
  if (!hop3File || norm(hop3File) === norm(serviceFile)) return stop('depth-cap');
  via.push(`${norm(path.relative(root, hop3File))}::${del2.method}`);

  const hop3Src = read(hop3File);
  const third = hop3Src && methodBody(hop3Src, del2.method);
  if (!third) return stop('depth-cap');

  const local3 = localShape(third.body);
  if (local3) return { level: 'repo', keys: local3.keys, ...(local3.partial ? { partial: true } : {}), via, depth: 3 };
  if (delegate(third.body)) return stop('depth-cap');
  return stop('repo-has-no-literal-shape');
}

/** `__construct(UserRepository $repository)` → `UserRepository` for `$this->repository`. */
function constructorTypeOf(body, prop) {
  const ctor = /__construct\s*\(([^)]*)\)/s.exec(body);
  if (!ctor) return null;
  const hint = new RegExp(`([A-Z][A-Za-z0-9_]*)\\s+\\$${escapeRe(prop)}\\b`).exec(ctor[1]);
  return hint ? hint[1] : null;
}

/** `<Class>` → its PHP file (index class symbol first, basename walk after). */
function findPhpFileByClass(root, className, index) {
  const short = String(className || '').split('\\').pop();
  if (!short) return null;
  const sym = (index?.symbols || []).find((s) => s.kind === 'class' && s.name === short);
  if (sym) return path.join(root, sym.file);
  return findPhpFiles(root, false).find((f) => path.basename(f) === `${short}.php`) || null;
}

/**
 * The ONE comparability predicate — every consumer (review-rules' shape check,
 * `shape-coverage`, any future caller) must use it, because the guards were written
 * inline in three places and the copies drifted twice while this was being verified
 * (a measurement mirror without the guards reported 3 findings the rule would refuse).
 *
 * A backend shape is comparable only when we actually read it:
 *   - `unresolved`    we never saw a shape (controller/service/depth-cap failures)
 *   - level whitelist `repo` is deliberately NOT in it: hop-3 (repository layer) keys are
 *     only admitted after the measured agreement between those keys and what clients
 *     read supports calling them response keys (docs/shape-check.md §2.3)
 *   - `partial`       some return branch could not be expanded — the key union is a
 *                     lower bound, not the response shape
 *   - `data` key      classic wrapper payload; `res.data.x` may read the nested object
 *                     we never opened
 * Anything else is not compared: the checklist says 未核对, no field is declared missing.
 */
const COMPARABLE_LEVELS = new Set(['local', 'service']);   // 'repo' on evidence only

export function shapeIsComparable(shape) {
  return Boolean(shape)
    && COMPARABLE_LEVELS.has(shape.level)
    && !shape.partial
    && Array.isArray(shape.keys)
    && !shape.keys.includes('data');
}

/**
 * A stub / degraded endpoint: the handler or its service never returns and always
 * throws, so the client's success branch is unreachable. Nothing may be reported about
 * the fields read there — not by the rule, not by `shape-coverage`, not by any mirror.
 */
export function shapeIsStub(shape) {
  return Boolean(shape) && shape.reason === 'handler-throws';
}

/**
 * M5 (charter §2.4) — the second stage: when the shape gate refuses to compare, do not
 * fall silent. Ask the declaration question instead: does this key exist ANYWHERE in
 * the backend (`'k' =>`, `$v['k']`, `"k":`)?
 *
 * Measured 2026-11-01 on the real pair: `bindName` has **0 declarations in 1099 PHP
 * files** — a true defect the gate was hiding as 未核对 — while `serviceList` has 3
 * array-key declarations plus a contract test, i.e. "declared elsewhere", which is a
 * pairing question, not a missing field.
 *
 * The index is built once per root and memoised: the rule asks for many fields.
 */
const DECL_CACHE = new Map();
const MAX_SITES_PER_KEY = 5;
const DECL_SKIP = /\/(vendor|node_modules|tests|test|storage|bootstrap|public|resources|\.git)\//;

export function backendDeclarationIndex(root) {
  const key = path.resolve(root);
  const cached = DECL_CACHE.get(key);
  if (cached) return cached;

  const sites = new Map();
  let scanned = 0;
  const add = (field, rel, line) => {
    const list = sites.get(field);
    if (!list) { sites.set(field, [{ file: rel, line }]); return; }
    if (list.length < MAX_SITES_PER_KEY) list.push({ file: rel, line });
  };

  const files = walk(key, [], MAX_DEPTH).filter((f) => /\.php$/i.test(f) && !DECL_SKIP.test(norm(f)));
  for (const f of files) {
    const src = read(f);
    if (!src) continue;
    scanned += 1;
    const rel = norm(path.relative(key, f));
    src.split(/\r?\n/).forEach((line, i) => {
      // `'k' => …` / `"k" => …` (array literals) and `$v['k'] = …` (assignments)
      for (const m of line.matchAll(/['"]([A-Za-z_]\w*)['"]\s*=>/g)) add(m[1], rel, i + 1);
      for (const m of line.matchAll(/\$\w+\s*\[\s*['"]([A-Za-z_]\w*)['"]\s*\]/g)) add(m[1], rel, i + 1);
      // `compact('a','b')` declares keys too — without this, a handler returning
      // `compact('list','count','codeUrl')` looked like it declared nothing, and the
      // second stage reported `codeUrl` as missing (measured 2026-11-02).
      for (const k of compactKeys(line)) add(k, rel, i + 1);
    });
  }

  const index = { root: key, keys: sites, scannedFiles: scanned };
  DECL_CACHE.set(key, index);
  return index;
}

/**
 * Is `<field>` declared as a response key anywhere in the backend?
 * Returns `{declared, sites, scannedFiles}` — `declared: 0` is the strong claim the
 * second stage reports, and it is honest about its own limit: a key built dynamically
 * (`$row[$col]`, a serializer, a DB column mapping) leaves no static declaration.
 */
export function searchResponseKey({ root, field }) {
  const index = backendDeclarationIndex(root);
  const sites = index.keys.get(field) || [];
  return { declared: sites.length, sites: sites.slice(0, 3), scannedFiles: index.scannedFiles };
}
