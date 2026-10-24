/**
 * Leftover-stub detection — the AI-code smell with the messiest guard history.
 *
 * The rule fires on three shapes, in priority order:
 *   1. a stub marker that *begins* a real comment line (comment spans come from the same
 *      state machine that blanks them, so "is this really a comment" is already settled);
 *   2. a `#`-prefixed marker in PHP (which the JS comment scanner does not cover);
 *   3. a marker attached to a throw / `new Error(` / TODO — the "placeholder implementation"
 *      case, where the phrase alone in prose is *not* a stub.
 *
 * History this file has to keep honest: the original was a bare regex over the whole file
 * and reported a doc line explaining that a leaf is "not implemented → na" (1 hit, 100%
 * false positive, 0 real stubs), and a later fix had to stop the rule from matching the
 * phrase quoted next to `throw` in its own explanatory comment. Hence: the phrase list is
 * built from escapes, and the doc above describes the shapes instead of quoting them.
 */

/** Moved verbatim out of review-rules.mjs so the rule and its helper ship together. */
const LINE_SPLIT_RE = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10));

/**
 * First TODO/FIXME/XXX/HACK that *begins* a comment line.
 *
 * Scanning the raw text reported the wrong things twice over: a marker inside a
 * string literal (`'// TODO: …'` — the tests' own fixtures write it as data) is not
 * a comment, and a marker mentioned mid-sentence is prose. The comment spans come
 * from the same state machine that blanks them, so "is this really a comment" is
 * already decided.
 */
export function stubMarkerInComments(src, spans) {
  for (const [start, end] of spans) {
    let offset = start;
    for (const line of src.slice(start, end).split(LINE_SPLIT_RE)) {
      const body = line.replace(/^\s*(?:\/\/+|\/\*+|\*+|<!--)\s*/, '');
      const m = /^(TODO|FIXME|XXX|HACK)\b/.exec(body);
      if (m) return { index: offset + (line.length - line.trimStart().length), 0: line.trim(), marker: m[1] };
      offset += line.length + 1;
    }
  }
  return null;
}

// Built from escapes: a literal phrase list here would be found by the rule on every
// self-review (the checker scanning its own pattern).
const STUB_FORM_RE = new RegExp(
  '(?:throw|new\\s+Error\\s*\\(|TODO|FIXME)[^\\n]{0,60}(?:\\u672a\\u5b9e\\u73b0|\\u5f85\\u8865|\\u4e34\\u65f6\\u65b9\\u6848|not\\u0020implemented)',
);

const finding = ({ rule, severity, file, line, message, why, evidence }) => ({ rule, severity, file, line, message, why, evidence });

export const STUB_RULES = [
  {
    id: 'ai-todo-left', family: 'any', severity: 'info', title: 'TODO/FIXME 占位残留',
    run: ({ file, f, src, isCode, isPhp, commentSpans, lineOf }) => {
      if (!isCode) return [];
      const stubComment = stubMarkerInComments(src, commentSpans);
      const hashTodo = isPhp ? /(?<![`'"])(?:^|\s)#[ \t]*\b(TODO|FIXME|XXX|HACK)\b/m.exec(src) : null;
      const todo = stubComment || hashTodo || STUB_FORM_RE.exec(src);
      if (!todo) return [];
      return [finding({
        rule: 'ai-todo-left', severity: 'info', file: f, line: lineOf(todo.index),
        message: `${file} 里留了 \`${todo[0]}\`。`,
        why: 'AI 很擅长留占位实现（注释里写"稍后补校验"、或者直接 throw 一个占位异常）；这类标记过了评审就没人回头，等于把半成品合进主干。',
        evidence: `matched: ${todo[0]}`,
      })];
    },
  },
];
