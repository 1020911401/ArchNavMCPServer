/**
 * Blade template call extraction — recall patch.
 *
 * `extractBladeCalls(filePath)` finds PHP method calls written inside Blade
 * expressions, e.g.:
 *
 *     {!! $presenter->showSelectOptions($groups, $id) !!}
 *     {{ $data->sum('input') }}
 *     @if ($user->canAccess($id))
 *     @foreach ($rows as $r) ... @endforeach
 *     {{ $presenter?->showSelectOptions($rows, $id) }}   // null-safe
 *
 * Precision rules (recall is secondary — never invent a call):
 *   - the receiver MUST be a plain PHP variable, so only `$var->m(` / `$var?->m(`
 *     match. `DB::table('departments')`, `Foo::bar()` and bare prose never do.
 *   - Blade comments (`{{-- ... --}}`, including multi-line) are blanked first.
 *   - the call must sit inside a Blade construct (`{{ }}`, `{!! !!}`,
 *     `@directive(...)`, `@php ... @endphp`), so the same text inside an HTML
 *     attribute or a `<script>` string literal is ignored.
 *   - `$a->b->c(` chains are NOT reported (the receiver is not a bare variable).
 *
 * Each hit is `{ var, callee, line }` with `var` without the leading `$`.
 */
import fs from 'fs';

const CALL_RE = /\$([A-Za-z_]\w*)\s*(\?->|->)\s*([A-Za-z_]\w*)\s*\(/g;
const BLADE_COMMENT_RE = /\{\{--[\s\S]*?--\}\}/g;

/** Replace every non-newline character of a match with a space (length kept). */
function blank(match) {
  return match.replace(/[^\n]/g, ' ');
}

function stripBladeComments(src) {
  return src.replace(BLADE_COMMENT_RE, blank);
}

/**
 * Mark every character that lies inside a Blade expression construct.
 * Returns a Uint8Array: 1 = inside, 0 = outside.
 */
function bladeRegions(src) {
  const mask = new Uint8Array(src.length);
  const mark = (a, b) => {
    const end = Math.min(b, mask.length);
    for (let i = a; i < end; i++) mask[i] = 1;
  };
  let m;

  // output tags: {!! !!} and {{ }}
  const outRe = /\{!![\s\S]*?!!\}|\{\{[\s\S]*?\}\}/g;
  while ((m = outRe.exec(src))) mark(m.index, m.index + m[0].length);

  // @php ... @endphp blocks, and single-line @php statements
  const phpRe = /@php\b/g;
  while ((m = phpRe.exec(src))) {
    const after = m.index + m[0].length;
    const endIdx = src.indexOf('@endphp', after);
    const eol = src.indexOf('\n', after);
    if (endIdx !== -1 && (eol === -1 || endIdx < eol)) mark(m.index, endIdx + 7);
    else mark(m.index, eol === -1 ? src.length : eol);
  }

  // @directive( ...balanced parens... )
  const dirRe = /@[A-Za-z_]\w*\s*\(/g;
  while ((m = dirRe.exec(src))) {
    let i = m.index + m[0].length - 1; // points at '('
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    mark(m.index, i);
  }

  return mask;
}

function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts, pos) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Extract Blade template method calls from a .blade.php file.
 * @param {string} filePath
 * @returns {{var: string, callee: string, line: number}[]}
 */
export function extractBladeCalls(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const src = stripBladeComments(raw);
  const mask = bladeRegions(src);
  const starts = lineStarts(src);
  const out = [];
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(src))) {
    if (!mask[m.index]) continue;
    out.push({ var: m[1], callee: m[3], line: lineAt(starts, m.index) });
  }
  return out;
}
