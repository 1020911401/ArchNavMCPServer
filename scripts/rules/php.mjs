/**
 * PHP-only structural rules.
 *
 * `php-loose-comparison` still lives in any.mjs because it shared the JS rules' blanked
 * source and flags; the rules here need nothing but the raw text and the file name, so
 * they are the cleanest declarative form in the codebase — a pure function of
 * (file, src) → findings.
 *
 * The controller-shape rules (`unvalidated-mass-input`, `n-plus-one`, `unbounded-query`)
 * needed three pre-computed flags — `isPhp`, `isController` (a *filename* test, not a
 * language test) and `isRequestPath` — which the scanner now passes explicitly instead
 * of hiding them in closure scope.
 */

const finding = ({ rule, severity, file, line, message, why, evidence }) => ({ rule, severity, file, line, message, why, evidence });

// Moved here with the rules that use them: nothing else in the scanner reads these.
// Both call-shape regexes accept `::` as well as `->`: Laravel's static facade calls
// (`User::find($id)` inside a loop, `User::paginate(10)`) are the same query as the
// instance form, and keying only on `->` made the rules miss them — a loop over
// `User::find()` was silently clean, and `User::paginate(10)` was not recognized as
// pagination at all.
//
// `get` is the one method with two meanings: Eloquent's `->get()` (a query, no argument)
// and Request/Collection's `->get($key)` (an in-memory lookup). Matching bare `get(`
// reported `$cache->get($row->id)` and `$request->get('flag')` as N+1 — measured on a
// 962-file Laravel repo: 3 of 70 reported files were this false positive.
const QUERY_IN_LOOP_RE = /(?:::|->)(where|orWhere|find|findOrFail|first|firstOrFail|pluck|count|value|update|save|create|insert)\s*\(|(?:::|->)get\s*\(\s*\)/;
const PAGINATION_RE = /(?:::|->)(paginate|simplePaginate|cursorPaginate)\s*\(/;
const MASS_INPUT_RE = /->all\s*\(\s*\)/;
const VALIDATION_PRESENT_RE = /(->validate\s*\(|extends\s+FormRequest|validate\s*\(\s*\$request|\w+Request\s+\$)/;

export const PHP_RULES = [
  {
    id: 'php-read-modify-write', family: 'php', severity: 'warn', title: '读-改-写同一字段（并发丢更新）',
    run: ({ file, f, src, lineOf }) => {
      if (!/\.php$/i.test(file)) return [];
      const rmw = /\$(\w+)->(\w+)\s*=\s*\$\1->\2\s*[+\-*/]/.exec(src);
      if (!rmw) return [];
      return [finding({
        rule: 'php-read-modify-write', severity: 'warn', file: f, line: lineOf(rmw.index),
        message: `${f}:${lineOf(rmw.index)} 读-改-写同一字段：\`${rmw[0].replace(/\s+/g, ' ').slice(0, 50)}\``,
        why: '并发下会丢更新（两人同时读到同一个值）；用原子 increment()/decrement()，或包在事务 + lockForUpdate() 里。',
        evidence: `matched: ${rmw[0].replace(/\s+/g, ' ').slice(0, 60)}`,
      })];
    },
  },
  {
    // security: unvalidated mass input in a controller
    id: 'php-unvalidated-mass-input', family: 'php', severity: 'warn', title: '$request->all() 未校验',
    run: ({ file, f, src, lineOf, isPhp, isController }) => {
      if (!isPhp || !isController) return [];
      if (!MASS_INPUT_RE.test(src) || VALIDATION_PRESENT_RE.test(src)) return [];
      const m = MASS_INPUT_RE.exec(src);
      return [finding({
        rule: 'php-unvalidated-mass-input', severity: 'warn', file: f, line: lineOf(m.index),
        message: `${file} 用了 $request->all()，但文件里没有任何 validate()/FormRequest。`,
        why: '未校验的 all() 一旦喂给 create()/update() 就是批量赋值；即使 Model 有 $fillable，字段语义也没被约束。',
        evidence: '$request->all() present, validate()/FormRequest absent',
      })];
    },
  },
  {
    // performance: query inside a loop (N+1 smell) — PHP only: the pattern itself
    // (`foreach (…) { … ->first(`) appears verbatim inside this file's own regexes.
    // Severity depends on where the file sits: a loop on the request path is a warn,
    // a batch/console loop is only an info (there the cost is usually accepted).
    // Counted loops are included because the expensive shape in practice is not
    // `foreach` — it is `for ($i = 0; $i < 30; $i++) { … ->count() }` (a dashboard
    // doing one query per day, 60 queries per request on a real repo).
    id: 'php-n-plus-one', family: 'php', severity: 'warn', title: '循环里查库（N+1）',
    run: ({ f, src, lineOf, isPhp, isRequestPath }) => {
      if (!isPhp) return [];
      for (const m of src.matchAll(/\b(?:foreach|for|while)\s*\([^)]*\)\s*\{/g)) {
        const window = src.slice(m.index, m.index + 400);
        const q = QUERY_IN_LOOP_RE.exec(window);
        if (!q) continue;
        return [finding({
          rule: 'php-n-plus-one', severity: isRequestPath ? 'warn' : 'info', file: f, line: lineOf(m.index),
          message: `循环体内有查询调用 \`${q[0].trim()}\`，疑似 N+1。`,
          why: '静态启发式（不判决对错）：循环里查库会随数据量线性放大；先看能不能 with() 预加载或 whereIn 批量查。请求路径上的循环降级为 info（批处理/命令行里往往可接受）。',
          evidence: `loop@${lineOf(m.index)}, query=${q[0].trim()}, requestPath=${isRequestPath}`,
        })];
      }
      return [];
    },
  },
  {
    // performance: unbounded query in a controller.
    // NOT gated on `isPhp` — it never was. The original block keyed off `isController`
    // alone, so a JS "controller" file is scanned too; adding a PHP guard here would be
    // a behaviour change hiding inside a refactor. The golden snapshot holds that line.
    id: 'php-unbounded-query', family: 'php', severity: 'info', title: '无分页的全量取数',
    run: ({ f, src, lineOf, isController }) => {
      if (!isController) return [];
      const m = /(->get\s*\(\s*\)|::all\s*\(\s*\))/.exec(src);
      if (!m || PAGINATION_RE.test(src)) return [];
      return [finding({
        rule: 'php-unbounded-query', severity: 'info', file: f, line: lineOf(m.index),
        message: `${f} 有无上限的取数（${m[0].trim()}）且全文件没有 paginate()。`,
        why: '无分页的全量取数随数据增长变慢并吃内存；列表接口应有分页。（本 fixture 里 8 个控制器有 paginate，可作为对照写法）',
        evidence: `${m[0].trim()} present, paginate() absent`,
      })];
    },
  },
];
