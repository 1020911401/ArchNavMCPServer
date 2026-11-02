/**
 * Laravel route parser — zero-dependency (regex + hand-written scanner).
 *
 * Purpose: Laravel route files (`routes/*.php`) contribute **0 symbols**, so a
 * Laravel project had no graph edge from an HTTP entry point to the controller
 * method it dispatches. These edges let `impact()` / `callers()` climb from a
 * controller action up to the route(s) that expose it.
 *
 * Supported forms (bench/php-app/routes/web.php is the reference corpus):
 *
 *   Route::get('/patients', 'PatientsController@index');
 *   Route::get('/x', [PatientsController::class, 'index']);      // array action
 *   Route::match(['get','post'], '/y', 'PatientsController@store');
 *   Route::any('/z', 'PatientsController@notice');
 *   Route::resource('patients', 'PatientsController');           // 7 default actions
 *   Route::resource('h', 'HC', ['except' => ['edit','update']]);  // only/except
 *   Route::resource('c', 'CC', [ 'only' => ['index','store'] ]);
 *   Route::apiResource('c', CCController::class);                 // no create/edit
 *   Route::group(['middleware' => 'auth'], function () { ... });   // nested groups
 *   Route::prefix('admin')->name('admin.')->group(function () { ... });  // chained
 *
 * Deliberately *not* turned into edges (no controller action to bind): closures,
 * `Route::view` / `Route::redirect` / `Route::fallback`, `Route::controller`, and
 * vendor macros like `Auth::routes()` / `SomeVendor::routes()`.
 *
 * Anything that looks like a controller route but cannot be resolved is reported
 * in `unresolved` — never dropped silently (the route node is still registered so
 * the HTTP entry point stays visible in the graph).
 *
 * Graph id conventions (must match src/analyzer.js / src/navigation.js):
 *   route node : `route:<METHOD> <uri>`
 *   symbol     : `sym:<the symbol's own file string>::<name>`  (never normalized)
 *   edge       : { from: routeId, to: symId, type: 'DEPENDS_ON', line, source_kind: 'route' }
 */
import fs from 'fs';
import path from 'path';

const DEFAULT_RESOURCE_ACTIONS = ['index', 'create', 'store', 'show', 'edit', 'update', 'destroy'];
const API_RESOURCE_ACTIONS = ['index', 'store', 'show', 'update', 'destroy'];

/** resource action → [verbs, uri suffix relative to the resource name] */
const RESOURCE_URI = {
  index: [['GET'], ''],
  create: [['GET'], '/create'],
  store: [['POST'], ''],
  show: [['GET'], '/{param}'],
  edit: [['GET'], '/{param}/edit'],
  update: [['PUT', 'PATCH'], '/{param}'],
  destroy: [['DELETE'], '/{param}'],
};

/** Route::any(...) — every verb Laravel's router can dispatch. */
const ANY_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** `Route::get(...)` / `->get(...)` — the calls that register a route. */
const VERB_CALL_RE = /(?:Route::|->)\s*(get|post|put|patch|delete|options|any|match|resource|apiResource)\s*\(/;
/** `Route::group(...)` / `->prefix('x')->group(...)` */
const GROUP_CALL_RE = /(?:Route::\s*group|->\s*group)\s*/;

// ═══════════════════════════════════════════════
//  Public entry point
// ═══════════════════════════════════════════════

/**
 * Extract "route → controller action" edges from a Laravel app.
 *
 * @param {string} repoDir  repository root (route files live in `<repoDir>/routes`)
 * @param {Array}  symbols  the analysis symbol list (used to resolve controllers)
 * @returns {{ edges: Array, routes: Array, unresolved: Array }}
 */
export function extractLaravelRoutes(repoDir, symbols = []) {
  const edges = [];
  const routes = [];
  const unresolved = [];
  const resolve = buildControllerResolver(symbols);

  // Prefixes applied by a service provider are invisible in the route file itself, and
  // bootstrap files (`routes/kefuapi.php`) only `require` the real one. Without this,
  // `kefuapi/login` was read as plain `login` and collided with the customer frontend's
  // `POST login` — which then got paired to the kefu handler (measured 2026-11-02).
  const routeFiles = discoverRouteFiles(repoDir);
  const inherited = discoverInheritedPrefixes(repoDir, routeFiles);

  for (const relFile of routeFiles) {
    let src;
    try {
      src = fs.readFileSync(path.join(repoDir, relFile), 'utf-8');
    } catch {
      continue;
    }
    if (!src.includes('Route::')) continue;

    const masked = maskComments(src);
    if (!masked.includes('Route::')) continue;

    const mountPrefix = inherited.get(relFile) || '';
    const state = {
      masked,
      relFile,
      lines: lineStartsOf(masked),
      edges,
      routes,
      unresolved,
      resolve,
      mountPrefix,
    };

    // Top level of the file is just another block, seeded with the provider's prefix.
    visitBlock(state, 0, masked.length, { prefix: mountPrefix });
  }

  return { edges, routes, unresolved };
}

/**
 * Effective `prefix` for every route file, following provider mounts and `require`
 * chains. Three shapes are supported, because they are what real Laravel repos use:
 *
 *   Route::prefix('x')->group(base_path('routes/x.php'))          // literal
 *   Route::group(['prefix' => 'x'], base_path('routes/x.php'))    // array option
 *   foreach (['x' => base_path('routes/x.php')] as $p => $f) {    // variable (this repo)
 *       Route::middleware('api')->prefix($p)->group($f);
 *   }
 *
 * The last one is why a naive "read the prefix literal" cannot work: `$prefix` is a loop
 * variable and its value lives in the array literal above it.
 */
function discoverInheritedPrefixes(repoDir, routeFiles) {
  const mounted = new Map();      // route file -> prefix
  const known = new Set(routeFiles);

  for (const relProvider of discoverProviderFiles(repoDir)) {
    let src;
    try {
      src = fs.readFileSync(path.join(repoDir, relProvider), 'utf-8');
    } catch {
      continue;
    }
    const masked = maskComments(src);

    // ── shape 3: foreach (['prefix' => base_path('file')] as $p => $f) { … } ──
    for (const loop of masked.matchAll(/foreach\s*\(([\s\S]*?)\bas\s+\$(\w+)\s*=>\s*\$(\w+)\s*\)\s*\{/g)) {
      const bodyStart = loop.index + loop[0].length;
      const bodyEnd = matchBrace(masked, bodyStart - 1);
      if (bodyEnd < 0) continue;
      const body = masked.slice(bodyStart, bodyEnd);
      const prefixVar = loop[2];
      const fileVar = loop[3];
      if (!new RegExp(`->\\s*prefix\\s*\\(\\s*\\$${prefixVar}\\s*\\)`).test(body)) continue;
      if (!new RegExp(`->\\s*group\\s*\\(\\s*\\$${fileVar}\\s*\\)`).test(body)) continue;
      for (const entry of arrayEntries(loop[1])) {
        const target = resolveRoutePath(entry.value, relProvider, repoDir);
        if (target && known.has(target)) mounted.set(target, jointPrefix('', entry.key));
      }
    }

    // ── shapes 1 & 2: explicit prefix beside the group() call ──
    // `Route::group(...)` (array option, second arg is a file) and `->group(...)`
    // (chained modifiers) both appear in real providers.
    for (const g of masked.matchAll(/(?:::|->)\s*group\s*\(/g)) {
      const stmtStart = statementStart(masked, g.index);
      const modifiers = masked.slice(stmtStart, g.index);
      const argStart = g.index + g[0].length;
      const argEnd = matchParen(masked, argStart - 1);
      if (argEnd < 0) continue;
      const arg = masked.slice(argStart, argEnd);
      // `->prefix('x')->group(f)` keeps the prefix in the modifiers; the array-option
      // form `Route::group(['prefix' => 'x'], f)` keeps it in the FIRST argument.
      const prefix = chainedArg(modifiers, 'prefix')
        || arrayOption(modifiers, 'prefix')
        || arrayOption(arg, 'prefix');
      if (!prefix || !prefix.ok) continue;
      const target = resolveRoutePath(arg, relProvider, repoDir);
      if (target && known.has(target)) mounted.set(target, jointPrefix('', prefix.value));
    }
  }

  // `require` chains: a bootstrap file passes its prefix down to the files it pulls in.
  const edges = routeIncludes(repoDir, routeFiles, known);
  const effective = new Map();
  const queue = [...mounted.keys()];
  for (const file of queue) effective.set(file, mounted.get(file));
  while (queue.length) {
    const file = queue.shift();
    for (const child of edges.get(file) || []) {
      if (effective.has(child)) continue;          // first mount wins, like Laravel
      effective.set(child, effective.get(file));
      queue.push(child);
    }
  }
  return effective;
}

/** `['k' => base_path('f'), 'k2' => 'f2']` → [{key, value}] (literal keys only). */
function arrayEntries(head) {
  const out = [];
  const body = /\[([\s\S]*)\]/.exec(head);
  if (!body) return out;
  for (const m of body[1].matchAll(/'([^']+)'\s*=>\s*([^,]+?)(?:,|$)/g)) out.push({ key: m[1], value: m[2].trim() });
  return out;
}

/** Resolve `base_path('x')` / `app_path('x')` / `__DIR__.'/x'` / `'x'` to a repo-relative posix path. */
function resolveRoutePath(expr, fromFile, repoDir) {
  const e = String(expr || '').trim();
  let resolved = null;
  let m;
  if ((m = /base_path\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(e))) resolved = m[1];
  else if ((m = /app_path\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(e))) resolved = `app/${m[1]}`;
  else if ((m = /__DIR__\s*\.\s*['"]\/([^'"]+)['"]/.exec(e))) resolved = path.posix.join(path.posix.dirname(fromFile), m[1]);
  else if ((m = /['"]([^'"]+\.php)['"]/.exec(e))) resolved = m[1];
  if (!resolved) return null;
  const norm = path.posix.normalize(resolved.replace(/^\.\//, '')).replace(/\/$/, '');
  return norm.startsWith('routes/') ? norm : null;
}

/** Nested `require`/`include` edges between route files, repo-relative posix. */
function routeIncludes(repoDir, routeFiles, known) {
  const out = new Map();
  for (const rel of routeFiles) {
    let src;
    try { src = fs.readFileSync(path.join(repoDir, rel), 'utf-8'); } catch { continue; }
    const masked = maskComments(src);
    const children = new Set();
    for (const m of masked.matchAll(/\b(?:require|require_once|include|include_once)\b\s*\(?/g)) {
      const after = masked.slice(m.index + m[0].length, m.index + m[0].length + 160);
      const hit = /(__DIR__\s*\.\s*['"]\/?([^'"]+)['"])|(base_path\s*\(\s*['"]([^'"]+)['"]\s*\))/.exec(after);
      if (!hit) continue;
      const raw = hit[2] ? path.posix.join(path.posix.dirname(rel), hit[2]) : hit[4];
      const child = path.posix.normalize(raw);
      if (known.has(child)) children.add(child);
    }
    if (children.size) out.set(rel, [...children]);
  }
  return out;
}

/** Every service provider that might register routes: `*Provider.php`, or any file
 *  under an `Providers/` directory (providers are not always named `*Provider`). */
function discoverProviderFiles(repoDir) {
  const out = [];
  const walk = (abs, rel, depth) => {
    if (depth < 0) return;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (/^(node_modules|vendor|storage)$/.test(entry.name)) continue;
        walk(path.join(abs, entry.name), childRel, depth - 1);
      } else if (entry.isFile() && /\.php$/i.test(entry.name)) {
        if (/Provider\.php$/i.test(entry.name) || /\/Providers\//.test(`/${childRel}`)) out.push(childRel);
      }
    }
  };
  walk(path.join(repoDir, 'app'), 'app', 6);
  return out.sort();
}

/** Index of the `}` matching the `{` at `open` (−1 when unbalanced). */
function matchBrace(src, open) {
  if (src[open] !== '{') return -1;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === "'" || c === '"') { i = skipString(src, i); continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** Index of the `)` matching the `(` at `open` (−1 when unbalanced). */
function matchParen(src, open) {
  if (src[open] !== '(') return -1;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === "'" || c === '"') { i = skipString(src, i); continue; }
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** Start of the statement containing `idx` (after the previous `;`, `{` or line break run). */
function statementStart(src, idx) {
  for (let i = idx; i >= 0; i -= 1) {
    if (src[i] === ';' || src[i] === '{' || src[i] === '}') return i + 1;
  }
  return 0;
}

function jointPrefix(parent, child) {
  return joinUri(parent || '', child || '');
}

// ═══════════════════════════════════════════════
//  Block / statement walking
// ═══════════════════════════════════════════════

/**
 * Walk one `{ ... }` block (or a file) statement by statement, carrying the
 * enclosing group context (`prefix`). Nested groups recurse into their own body.
 */
function visitBlock(state, start, end, ctx) {
  let i = start;
  let guard = 0;
  while (i < end && guard++ < 200000) {
    const stmt = readStatement(state.masked, i, end);
    if (!stmt) break;
    if (stmt.text.includes('Route::')) processStatement(state, stmt, ctx);
    i = stmt.next;
  }
}

/** Handle one statement: a `...group(...)` declaration, or a plain route call. */
function processStatement(state, stmt, ctx) {
  const text = stmt.text;

  // ── group (nested routes) ────────────────────────────────────────────────
  const group = GROUP_CALL_RE.exec(text);
  if (group) {
    const parenRel = group.index + group[0].length;
    if (text[parenRel] === '(') {
      const parenAbs = stmt.start + parenRel;
      const closeAbs = matchBalanced(state.masked, parenAbs);
      if (closeAbs > 0) {
        const argsText = state.masked.slice(parenAbs + 1, closeAbs);
        const modifiersText = text.slice(0, group.index);
        const parts = splitTopLevel(argsText);
        let prefix = null;
        if (parts[0] && parts[0].trim().startsWith('[')) prefix = arrayOption(parts[0], 'prefix');
        if (!prefix) prefix = chainedArg(modifiersText, 'prefix');   // Route::prefix('x')->group(...)
        const next = prefix ? { ...ctx, prefix: joinUri(ctx.prefix, prefix.value) } : ctx;
        const body = closureBody(state.masked, parenAbs, closeAbs);
        if (body) visitBlock(state, body.start + 1, body.end, next);
        return;
      }
    }
  }

  // ── plain route registration ─────────────────────────────────────────────
  const call = VERB_CALL_RE.exec(text);
  if (!call) return;
  const method = call[1];
  const parenAbs = stmt.start + call.index + call[0].length - 1;
  const closeAbs = matchBalanced(state.masked, parenAbs);
  if (closeAbs < 0) return;
  const argsText = state.masked.slice(parenAbs + 1, closeAbs);
  const line = lineOf(state, stmt.start + call.index);
  const low = method.toLowerCase();

  if (low === 'resource' || low === 'apiresource') {
    expandResource(state, stmt, argsText, line, ctx, low === 'apiresource');
    return;
  }

  const parts = splitTopLevel(argsText);
  let methods;
  let uriRaw;
  let actionRaw;
  if (low === 'match') {
    methods = quotedWords(parts[0]).map((v) => v.toUpperCase());
    if (!methods.length) methods = [...ANY_VERBS];
    uriRaw = parts[1];
    actionRaw = parts[2];
  } else if (low === 'any') {
    methods = [...ANY_VERBS];
    uriRaw = parts[0];
    actionRaw = parts[1];
  } else {
    methods = [low.toUpperCase()];
    uriRaw = parts[0];
    actionRaw = parts[1];
  }
  if (uriRaw === undefined || actionRaw === undefined) return;   // no action → nothing to bind

  const spec = parseAction(actionRaw);
  if (spec.kind === 'closure') return;                           // closure route: not a controller action
  const uri = joinUri(ctx.prefix, readLiteral(uriRaw).value);
  for (const verb of methods) record(state, verb, uri, line, spec);
}

/** Expand `Route::resource` / `Route::apiResource` into one route per action. */
function expandResource(state, stmt, argsText, line, ctx, isApi) {
  const parts = splitTopLevel(argsText);
  const name = readLiteral(parts[0] ?? '');
  const controller = cleanController(parts[1] ?? '');

  if (!name.ok || !name.value) {
    state.unresolved.push({
      method: isApi ? 'API-RESOURCE' : 'RESOURCE',
      uri: String(name.value || '').trim(),
      controller: controller || null,
      action: null,
      file: state.relFile,
      line,
      reason: 'dynamic-resource',
    });
    return;
  }

  // `['except' => [...]]` in the argument list, or `->only([...])` chained after it.
  const only = optionList(stmt.text, 'only');
  const except = optionList(stmt.text, 'except');

  let actions = isApi ? [...API_RESOURCE_ACTIONS] : [...DEFAULT_RESOURCE_ACTIONS];
  if (only.length) actions = actions.filter((a) => only.includes(a));
  if (except.length) actions = actions.filter((a) => !except.includes(a));

  const param = singular(name.value);
  for (const action of actions) {
    const shape = RESOURCE_URI[action];
    if (!shape) continue;
    const [verbs, suffix] = shape;
    const uri = joinUri(ctx.prefix, `${name.value}${suffix.replace('{param}', `{${param}}`)}`);
    for (const verb of verbs) {
      record(state, verb, uri, line, { kind: 'action', controller, action: action, dynamic: false });
    }
  }
}

// ═══════════════════════════════════════════════
//  Emit (edge, route node, or loud unresolved entry)
// ═══════════════════════════════════════════════

function record(state, method, uri, line, spec) {
  const id = `route:${method} ${uri}`;
  let symId = null;
  let reason = null;

  if (!spec.controller) {
    reason = spec.dynamic ? 'dynamic-controller' : 'missing-controller';
  } else if (!spec.action) {
    reason = 'missing-action';
  } else if (spec.dynamic) {
    reason = 'dynamic-action';
  } else {
    const hit = state.resolve(spec.controller, spec.action);
    if (hit.ok) symId = hit.symId;
    else reason = hit.reason;
  }

  state.routes.push({
    id,
    name: `${method} ${uri}`,
    method,
    uri,
    file: state.relFile,
    line,
    controller: spec.controller || null,
    action: spec.action || null,
    resolved: Boolean(symId),
  });

  if (symId) {
    state.edges.push({
      from: id,
      to: symId,                       // sym:<controller file as the parser emitted it>::<action>
      type: 'DEPENDS_ON',
      line,
      source_kind: 'route',
      method,
      uri,
      controller: spec.controller,
      action: spec.action,
    });
  } else {
    state.unresolved.push({
      method,
      uri,
      controller: spec.controller || null,
      action: spec.action || null,
      file: state.relFile,
      line,
      reason,
    });
  }
}

// ═══════════════════════════════════════════════
//  Controller resolution
// ═══════════════════════════════════════════════

/**
 * `'PatientsController'` / `App\Http\Controllers\PatientsController` / `Foo::class`
 * → the symbol node id of the action, using the symbol's *own* file string
 * (the PHP/WASM parser emits forward slashes; normalizing here would miss).
 */
function buildControllerResolver(symbols) {
  const filesByClass = new Map();     // class name            → [file, ...] (in symbol order)
  const fileByBasename = new Map();   // 'FooController.php'   → file
  const symByLocation = new Map();    // '<file>::<name>'      → symbol

  for (const sym of symbols || []) {
    if (!sym || !sym.name || !sym.file) continue;
    symByLocation.set(`${sym.file}::${sym.name}`, sym);

    const base = String(sym.file).split('/').pop();
    if (base && !fileByBasename.has(base)) fileByBasename.set(base, sym.file);

    // PHP classes come through the WASM parser as kind:'class'.
    if (sym.name.endsWith('Controller')) {
      const list = filesByClass.get(sym.name);
      if (list) list.push(sym.file);
      else filesByClass.set(sym.name, [sym.file]);
    }
  }

  /** `FooController` → `.../FooController.php` (canonical file) wins over a stray copy. */
  function pickFile(short) {
    const candidates = filesByClass.get(short);
    if (candidates && candidates.length) {
      const canonical = candidates.find((f) => String(f).split('/').pop() === `${short}.php`);
      if (canonical) return canonical;
      return candidates[0];
    }
    return fileByBasename.get(`${short}.php`) || null;
  }

  return function resolve(controller, action) {
    const short = String(controller).split('\\').pop().trim();
    if (!short) return { ok: false, reason: 'unknown-controller' };
    const file = pickFile(short);
    if (!file) return { ok: false, reason: 'unknown-controller' };
    const sym = symByLocation.get(`${file}::${action}`);
    if (!sym) return { ok: false, reason: 'unknown-action' };
    return { ok: true, symId: `sym:${sym.file}::${sym.name}` };
  };
}

// ═══════════════════════════════════════════════
//  Action / literal parsing helpers
// ═══════════════════════════════════════════════

/**
 * `'Controller@method'` | `[C::class, 'method']` | `function () {}` | `$var`
 * → { kind:'action', controller, action, dynamic } | { kind:'closure' } | { kind:'none' }
 */
function parseAction(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { kind: 'none' };

  // closure / arrow function → handled by the caller (no controller)
  if (/^(?:static\s+)?(?:function|fn)\b/.test(text) || text.startsWith('{')) return { kind: 'closure' };

  // [Controller::class, 'method']  (also ['Controller', 'method'])
  if (text.startsWith('[')) {
    const close = text.lastIndexOf(']');
    const inner = close > 0 ? text.slice(1, close) : text.slice(1);
    const items = splitTopLevel(inner);
    const controller = cleanController(items[0] ?? '');
    const second = items[1] !== undefined ? readLiteral(items[1]) : { value: '', ok: false };
    return {
      kind: 'action',
      controller,
      action: second.ok ? second.value.trim() : '',
      dynamic: !second.ok || !controller,
    };
  }

  // 'Controller@method'  |  '\App\Http\Controllers\Controller@method'
  const lit = readLiteral(text);
  if (!lit.ok) return { kind: 'action', controller: '', action: '', dynamic: true };
  const value = lit.value.trim();
  const at = value.lastIndexOf('@');
  if (at < 0) return { kind: 'action', controller: cleanController(value), action: '', dynamic: false };
  return {
    kind: 'action',
    controller: cleanController(value.slice(0, at)),
    action: value.slice(at + 1).trim(),
    dynamic: false,
  };
}

/** `'Foo'` → `Foo`; `Foo::class` → `Foo`; `[Foo::class]` → `Foo`; strips namespaces/brackets. */
function cleanController(raw) {
  let s = String(raw ?? '').trim().replace(/::class\s*$/, '').trim();
  const lit = readLiteral(s);
  s = lit.value.trim();
  return s.replace(/^\[|\]$/g, '').replace(/^\\+/, '').replace(/\s+/g, '');
}

/** `'x'` / `"x"` → { value:'x', ok:true }; anything else → { value:<trimmed>, ok:false } */
function readLiteral(text) {
  const s = String(text ?? '').trim();
  const m = /^'((?:\\.|[^'\\])*)'$/.exec(s) || /^"((?:\\.|[^"\\])*)"$/.exec(s);
  if (m) return { value: m[1], ok: true };
  return { value: s, ok: false };
}

/** all single/double-quoted words inside a snippet, in order */
function quotedWords(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/['"]([^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

/** `['prefix' => 'admin']` → { value:'admin', ok:true } */
function arrayOption(text, key) {
  const re = new RegExp(`['"]${key}['"]\\s*=>\\s*(['"])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`);
  const m = re.exec(String(text ?? ''));
  return m ? { value: m[2], ok: true } : null;
}

/** `Route::prefix('admin')` / `->prefix('admin')` → { value:'admin', ok:true } */
function chainedArg(text, key) {
  const re = new RegExp(`(?:Route::|->)\\s*${key}\\s*\\(\\s*(['"])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`);
  const m = re.exec(String(text ?? ''));
  return m ? { value: m[2], ok: true } : null;
}

/** `['only' => ['index','store']]` or `->only(['index','store'])` → ['index','store'] */
function optionList(statementText, key) {
  const out = [];
  const patterns = [
    new RegExp(`['"]${key}['"]\\s*=>\\s*\\[([^\\]]*)\\]`, 'g'),
    new RegExp(`->\\s*${key}\\s*\\(\\s*\\[([^\\]]*)\\]`, 'g'),
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(statementText))) out.push(...quotedWords(m[1]));
  }
  return out;
}

/** `patients` → `patients`; `categories` → `category`; `status` → `status` */
function singular(name) {
  const n = String(name ?? '').replace(/\/+$/, '');
  if (/ies$/.test(n)) return n.replace(/ies$/, 'y');
  if (/(?:ss|us|is)$/.test(n)) return n;
  return /s$/.test(n) ? n.slice(0, -1) : n;
}

/** Laravel prefix semantics: prefix `admin` + `/dash` → `admin/dash`; prefix + `/` → `admin`. */
function joinUri(prefix, uri) {
  const u = String(uri ?? '');
  if (!prefix) return u;
  if (!u || u === '/') return prefix;
  return u.startsWith('/') ? `${prefix}${u}` : `${prefix}/${u}`;
}

// ═══════════════════════════════════════════════
//  Generic scanners
// ═══════════════════════════════════════════════

/** `routes/**\/*.php`, repo-relative with forward slashes, sorted. */
function discoverRouteFiles(repoDir) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(abs, entry.name), childRel);
      else if (entry.isFile() && /\.php$/i.test(entry.name)) out.push(`routes/${childRel}`);
    }
  };
  walk(path.join(repoDir, 'routes'), '');
  return out.sort();
}

/** Blank out `//`, `#` and `/* *\/` comments (newlines kept so line numbers survive). */
function maskComments(src) {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') {
      i = skipString(src, i) + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '#' && src[i + 1] !== '[') {
      while (i < src.length && src[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < src.length) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    i++;
  }
  return out.join('');
}

/** index of the quote that closes the string starting at `i` (src[i] is the quote) */
function skipString(src, i) {
  const quote = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === quote) return j;
  }
  return src.length - 1;
}

/** index of the bracket closing the one at `i` (`(`→`)`, `[`→`]`, `{`→`}`) */
function matchBalanced(src, i) {
  const open = src[i];
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "'" || c === '"') { j = skipString(src, j); continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/** Read one statement starting at/after `i`; stops at the top-level `;` or `}`. */
function readStatement(src, i, end) {
  while (i < end && /\s/.test(src[i])) i++;
  if (i >= end) return null;
  const start = i;
  let depth = 0;
  let j = i;
  for (; j < end; j++) {
    const c = src[j];
    if (c === "'" || c === '"') { j = skipString(src, j); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']') { if (depth > 0) depth--; }
    else if (c === '}') { if (depth === 0) break; depth--; }
    else if (c === ';' && depth === 0) break;
  }
  return { start, end: j, text: src.slice(start, j), next: Math.min(end, j + 1) };
}

/** top-level comma split (commas inside (), [], {}, '' and "" are ignored) */
function splitTopLevel(text) {
  const src = String(text ?? '');
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"') { i = skipString(src, i); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth > 0) depth--; }
    else if (c === ',' && depth === 0) {
      out.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = src.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** `{ ... }` body of the closure passed to `group(...)`, in absolute offsets. */
function closureBody(src, from, to) {
  const segment = src.slice(from, to);
  const m = /\bfunction\b|\bfn\s*\(/.exec(segment);
  if (!m) return null;
  const brace = src.indexOf('{', from + m.index);
  if (brace < 0 || brace >= to) return null;
  const end = matchBalanced(src, brace);
  if (end < 0) return null;
  return { start: brace, end };
}

function lineStartsOf(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

/** 1-based line of an absolute offset (binary search over line starts). */
function lineOf(state, abs) {
  const starts = state.lines;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= abs) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
