/**
 * PHP-only structural rules.
 *
 * `php-loose-comparison` still lives in any.mjs because it shared the JS rules' blanked
 * source and flags; the rules here need nothing but the raw text and the file name, so
 * they are the cleanest declarative form in the codebase — a pure function of
 * (file, src) → findings.
 */

const finding = ({ rule, severity, file, line, message, why, evidence }) => ({ rule, severity, file, line, message, why, evidence });

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
];
