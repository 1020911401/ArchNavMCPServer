/**
 * Declarative rule model — the shape every rule family is migrating to.
 *
 * A rule is `{ id, family, severity, title, run(ctx) → findings[] }`:
 *   - `id` must exist in RULE_REGISTRY (that binding is asserted in tests, so a rule
 *     cannot silently disappear from the checklist or invent a name nobody registered);
 *   - `run` is pure over the file text and returns findings, which makes a single rule
 *     unit-testable without driving the whole 370-line scanner;
 *   - families live in their own module (this file is the runner + the Go family).
 *
 * The old imperative style (`if (isX) findings.push({...})` inline in scanContent) stays
 * for the families not migrated yet — one model, not two, is the goal; the golden
 * snapshot in bench/rule-golden.mjs proves each migration is behaviour-preserving.
 */

/** Execute declarative rules over one file. Errors bubble: a crashing rule must be loud. */
export { ANY_RULES } from './any.mjs';
export { VUE_RULES, vforMissingKeys } from './vue.mjs';
export { BINDING_RULES } from './bindings.mjs';
export { PHP_RULES } from './php.mjs';
export { STUB_RULES, stubMarkerInComments } from './stub.mjs';

export function runRules(rules, ctx) {
  const out = [];
  for (const rule of rules) out.push(...(rule.run(ctx) || []));
  return out;
}

const finding = ({ rule, severity, file, line, message, why, evidence }) => ({ rule, severity, file, line, message, why, evidence });

/**
 * Go: the two mistakes that cost real money in services (plus SQL built by concatenation).
 * Behaviour moved verbatim out of scanContent — bench/rule-golden.json is the contract.
 */
export const GO_RULES = [
  {
    id: 'go-ignored-error', family: 'go', severity: 'warn', title: '丢弃返回值（通常是 error）',
    run: ({ file, src, lineOf }) => {
      const ignoredMatches = [...src.matchAll(/,\s*_\s*:?=\s*\w|\(\s*_\s*\)/g)];
      const ignored = ignoredMatches[0];
      if (!ignored) return [];
      return [finding({
        rule: 'go-ignored-error', severity: 'warn', file, line: lineOf(ignored.index),
        message: `${file}:${lineOf(ignored.index)} 丢弃返回值 ${ignoredMatches.length} 处，例如 \`${ignored[0].replace(/\s+/g, ' ').slice(0, 40)}\`。`,
        why: 'Go 里 `, _ :=` 最常见的用途就是丢掉 error：线上表现为"什么都没发生"，而错误被永久吞掉。至少要 log 或显式注释为什么安全。',
        evidence: `occurrences=${ignoredMatches.length}, first=${ignored[0].replace(/\s+/g, ' ').slice(0, 50)}`,
      })];
    },
  },
  {
    id: 'go-panic-in-library', family: 'go', severity: 'warn', title: '库代码里的 panic',
    run: ({ file, src, lineOf }) => {
      const isMainPkg = /^\s*package\s+main\b/m.test(src);
      const panicMatches = [...src.matchAll(/\bpanic\s*\(/g)];
      const panics = panicMatches[0];
      if (!panics || isMainPkg) return [];
      return [finding({
        rule: 'go-panic-in-library', severity: 'warn', file, line: lineOf(panics.index),
        message: `${file}:${lineOf(panics.index)} 非 main 包里调用 panic ${panicMatches.length} 处。`,
        why: '库/business 层 panic 会把调用方（可能是 HTTP handler）整条请求打挂，而且没法被调用方兜住；返回 error 让上层决定。',
        evidence: `package=non-main, occurrences=${panicMatches.length}`,
      })];
    },
  },
  {
    id: 'go-sql-injection', family: 'go', severity: 'error', title: 'SQL 拼接（注入）',
    run: ({ file, src, lineOf }) => {
      const sqlConcat = /\b(?:db|tx|conn)\.(?:query|QueryContext|Query|exec|ExecContext|Exec|raw|Raw)\s*\([^)]*(?:fmt\.Sprintf|\+|\$\{)/i.exec(src.replace(/\n/g, ' '));
      if (!sqlConcat) return [];
      return [finding({
        rule: 'go-sql-injection', severity: 'error', file, line: lineOf(sqlConcat.index),
        message: `${file} 用拼接/格式化构造 SQL：\`${sqlConcat[0].replace(/\s+/g, ' ').slice(0, 60)}\``,
        why: 'SQL 注入；Go 的 database/sql 用占位符（? / $1）传参，不要 fmt.Sprintf 拼进语句。',
        evidence: `matched: ${sqlConcat[0].replace(/\s+/g, ' ').slice(0, 70)}`,
      })];
    },
  },
];
