/**
 * The language-agnostic + PHP/JS family, migrated out of scanContent.
 *
 * These four rules shared three pre-computed inputs (`scannable`, `src`, `lineOf`) and a
 * couple of file-type flags. Those are now an explicit `ctx` argument instead of 30 lines
 * of closure scope — the point of the migration: a rule can be exercised on its own and
 * the scanner keeps only the wiring.
 *
 * `scannable` = source with strings/comments and template-literal bodies blanked (answers
 * "is this real code?"), `src` = the raw text (needed to tell a catch block whose braces
 * hold only a comment from one that is genuinely empty).
 */

const finding = ({ rule, severity, file, line, message, why, evidence }) => ({ rule, severity, file, line, message, why, evidence });

const LINE_BREAK = String.fromCharCode(10);

export const ANY_RULES = [
  {
    id: 'php-loose-comparison', family: 'php', severity: 'warn', title: '松散比较 == / !=（类型杂耍）',
    run: ({ file, scannable, codeOnly, lineOf }) => {
      if (!/\.php$/i.test(file)) return [];
      const loose = /(?<![=!<>+\-*/])==(?!=)/.exec(scannable) || /(?<![=!<>])!=(?!=)/.exec(scannable);
      if (loose) {
        return [finding({
          rule: 'php-loose-comparison', severity: 'warn', file, line: lineOf(loose.index),
          message: `PHP 用了松散比较 \`${loose[0]}\`（${file}）。`,
          why: 'PHP 的类型杂耍是长期漏洞来源（0 == "abc"、"1e2" == "100"）：校验/鉴权分支必须用 === / !==，或先做类型转换。',
          evidence: `matched: ${loose[0]} @${lineOf(loose.index)}`,
        })];
      }
      // Relational operators against an empty-string literal never show up in the
      // `==`/`!=` scan above — and PHP 8 changed their answer: measured on both
      // interpreters, `"" < 0` is **false** on 7.4 and **true** on 8.3 (while
      // `"" == 0` flipped the other way). A branch written for one version silently
      // takes the other after an upgrade. Scan `codeOnly` (strings kept, comments
      // blanked) because the empty-string operand is a string literal.
      // The lookbehind matters: `['k' => '']` contains `> ''` and is an array
      // literal, not a comparison — without it every fixture's default values fired.
      const rel = /(?:''|"")\s*(?<![<>=!])(<=|>=|<|>)|(?<![<>=!])(<=|>=|<|>)\s*(?:''|"")/.exec(codeOnly || '');
      if (!rel) return [];
      const op = rel[1] || rel[2];
      return [finding({
        rule: 'php-loose-comparison', severity: 'warn', file, line: lineOf(rel.index),
        message: `PHP 用 \`${op}\` 直接和空字符串比较（${file}）。`,
        why: 'PHP 8 改了字符串与非数值比较的规则：`"" < 0` 在 7.4 是 false、在 8.3 是 true（`"" == 0` 正好相反）。跨版本时这里会静默走另一条分支——比较前先显式类型转换。',
        evidence: `matched: ${op} with empty-string operand @${lineOf(rel.index)}`,
      })];
    },
  },
  {
    // The shape that actually bit a Laravel/PHP migration: a value read from
    // config/DB/request (unknown type at runtime) compared with `<`/`>` to a number.
    // `get('store_stock') < 0` is false for `''` on PHP 7.4 and true on 8.3, so the
    // branch that "cannot happen" happens after the upgrade. This needs the
    // assignment to be visible in the same file — an uncast parameter would be noise.
    id: 'php-uncast-value-compare', family: 'php', severity: 'warn',
    title: '配置/入参未经类型转换就与数字做大小比较',
    run: ({ file, codeOnly, lineOf }) => {
      if (!/\.php$/i.test(file)) return [];
      const code = codeOnly || '';
      // Sources whose runtime type is not declared in code: config reads, request
      // input, env, superglobals, and array access on a request-ish variable.
      const SOURCE_RE = /(\$\w+)\s*=\s*([^;]*?)(?:->get\(|->query\(|->input\(|->header\(|\bconfig\(|\binput\(|\benv\(|\bgetenv\(|->request\b|\$_(?:GET|POST|REQUEST)\b)/;
      // The cast that makes the comparison version-proof usually sits in the
      // *assignment* (`$limit = (int) request()->input(...)`), not next to the
      // operator. Looking only at the 24 chars before `<`/`>` reported every
      // cast-at-assignment site as uncast — 9/9 false positives on the Laravel
      // migration repo, which is what made this rule look like the real risk area.
      const CAST_AT_RHS_RE = /(?:^|[^\w$])(?:\(int\)|\(integer\)|\(float\)|\(double\)|\(string\)|\(bool\)|\(boolean\)|\bintval\(|\bfloatval\(|\bstrval\(|\bboolval\(|\bcount\(|\bstrlen\()/;
      const fromSource = new Map();
      const castAtSource = new Set();
      let line = 0;
      for (const sourceLine of code.split(LINE_BREAK)) {
        line += 1;
        const m = SOURCE_RE.exec(sourceLine);
        if (!m) continue;
        fromSource.set(m[1], line);
        if (CAST_AT_RHS_RE.test(m[2] || '')) castAtSource.add(m[1]);
      }
      if (!fromSource.size) return [];
      const CAST_RE = /(?:\(int\)|\(float\)|\(string\)|\(bool\)|\bintval\(|\bfloatval\(|\bcount\(|\bstrlen\()\s*$/;
      const hits = [];
      const scan = (re, pick) => {
        for (const m of code.matchAll(re)) {
          const varName = pick(m);
          const at = fromSource.get(varName);
          if (!at) continue;
          if (castAtSource.has(varName)) continue; // (int) in the assignment already fixes the type
          const idx = m.index;
          if (at > lineOf(idx)) continue; // assignment must come first
          const before = code.slice(Math.max(0, idx - 24), idx);
          if (CAST_RE.test(before)) continue;
          hits.push({ varName, idx });
        }
      };
      scan(/(\$\w+(?:\[[^\]]*\])?)\s*(?:<=|>=|<|>)\s*-?\d+(?:\.\d+)?\b/g, (m) => m[1]);
      scan(/-?\d+(?:\.\d+)?\s*(?:<=|>=|<|>)\s*(\$\w+(?:\[[^\]]*\])?)/g, (m) => m[1]);
      if (!hits.length) return [];
      hits.sort((a, b) => a.idx - b.idx);
      const first = hits[0];
      const assignedAt = fromSource.get(first.varName);
      return [finding({
        rule: 'php-uncast-value-compare', severity: 'warn', file, line: lineOf(first.idx),
        message: `${first.varName}（第 ${assignedAt} 行取自配置/入参）未做类型转换就参与大小比较（${file}）。`,
        why: '配置/入参在运行时可能是空串或非数值。PHP 7.4 里 `"" < 0` 是 false、PHP 8.3 是 true，`"" == 0` 则相反——同一段代码在两个版本走不同分支。比较前显式 `(int)`/`(float)` 转换，跨版本才等价。',
        evidence: `var=${first.varName}, assignedAt=${assignedAt}, compareAt=${lineOf(first.idx)}`,
      })];
    },
  },
  {
    // A shebang means this file *is* a CLI: console.log is its interface, not a
    // leftover debug statement (this is how the checker flagged its own scripts).
    id: 'js-debug-left-on', family: 'front', severity: 'warn', title: 'console.log / debugger 残留',
    run: ({ file, scannable, lineOf, isJsOrVue, isCli }) => {
      if (!isJsOrVue || isCli) return [];
      const dbg = /(?<![\w.$])console\.(log|debug|info)\s*\(|(?<![\w.$])debugger\s*(?:;|$)/m.exec(scannable);
      if (!dbg) return [];
      return [finding({
        rule: 'js-debug-left-on', severity: 'warn', file, line: lineOf(dbg.index),
        message: `${file} 残留调试输出 \`${dbg[0].trim()}\`。`,
        why: '和 PHP 的 dd() 同一类问题：console.log 会泄漏接口返回与用户数据，debugger 会在打开控制台时中断。',
        evidence: `matched: ${dbg[0].trim()}`,
      })];
    },
  },
  {
    id: 'js-loose-equality', family: 'front', severity: 'info', title: '判断里的松散相等',
    // `isCli` matters: in the original the rule shared the debug rule's guard, so a
    // shebang script (whose whole job is comparing CLI args) was exempt. Dropping that
    // guard added two phantom findings — the golden snapshot caught it.
    run: ({ file, scannable, lineOf, isJsOrVue, isCli }) => {
      if (!isJsOrVue || isCli) return [];
      // Only loose comparisons that *decide* something (condition / return / ternary).
      const looseJs = /(?:if|while|for|return|&&|\|\||\?)[^;\n{}]*?(?<![=!<>+\-*/])==(?!=)/.exec(scannable)
        || /(?:if|while|for|return|&&|\|\||\?)[^;\n{}]*?(?<![=!<>])!=(?!=)/.exec(scannable);
      if (!looseJs) return [];
      return [finding({
        rule: 'js-loose-equality', severity: 'info', file, line: lineOf(looseJs.index),
        message: `${file} 在判断里用了松散相等 \`${looseJs[0].trim().slice(0, 60)}\`。`,
        why: "== 会做隐式转换（'' == 0、null == undefined）：AI 生成代码里很常见，建议 === / !==。",
        evidence: `matched: ${looseJs[0].trim().slice(0, 60)}`,
      })];
    },
  },
  {
    // "empty catch" is a code smell — scanning prose (README, rule tables that *describe*
    // `catch {}`) flagged the documentation instead, hence the isCode guard.
    id: 'empty-catch', family: 'any', severity: 'warn', title: '空 catch（吞异常）',
    run: ({ file, src, scannable, lineOf, isCode }) => {
      if (!isCode) return [];
      let emptyCatch = /catch\s*(\([^)]*\))?\s*\{\s*\}/.exec(scannable);
      // A comment inside the braces *is* an explanation (`catch { /* malformed json */ }`),
      // and the blanked source hides comments — so confirm against the raw text.
      if (emptyCatch) {
        const open = emptyCatch[0].indexOf('{');
        const inner = src.slice(emptyCatch.index + open + 1, emptyCatch.index + emptyCatch[0].lastIndexOf('}'));
        if (inner.trim()) emptyCatch = null;
      }
      if (!emptyCatch) return [];
      return [finding({
        rule: 'empty-catch', severity: 'warn', file, line: lineOf(emptyCatch.index),
        message: `${file} 有空 catch 块（吞掉异常）。`,
        why: 'AI 生成代码最常见的"看起来能跑"写法：异常被吞后线上只剩空数据没有日志，排查成本极高。至少要记日志或向上抛。',
        evidence: `matched: ${emptyCatch[0].replace(/\s+/g, ' ').trim()}`,
      })];
    },
  },
];
