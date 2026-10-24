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

export const ANY_RULES = [
  {
    id: 'php-loose-comparison', family: 'php', severity: 'warn', title: '松散比较 == / !=（类型杂耍）',
    run: ({ file, scannable, lineOf }) => {
      if (!/\.php$/i.test(file)) return [];
      const loose = /(?<![=!<>+\-*/])==(?!=)/.exec(scannable) || /(?<![=!<>])!=(?!=)/.exec(scannable);
      if (!loose) return [];
      return [finding({
        rule: 'php-loose-comparison', severity: 'warn', file, line: lineOf(loose.index),
        message: `PHP 用了松散比较 \`${loose[0]}\`（${file}）。`,
        why: 'PHP 的类型杂耍是长期漏洞来源（0 == "abc"、"1e2" == "100"）：校验/鉴权分支必须用 === / !==，或先做类型转换。',
        evidence: `matched: ${loose[0]} @${lineOf(loose.index)}`,
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
