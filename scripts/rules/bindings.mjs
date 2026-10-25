/**
 * JS/Vue dead bindings — imports and declarations that are never read.
 *
 * Migrated verbatim from scanContent. The subtle part worth preserving is `blanked`:
 * uses are counted on the string/comment/regex-blanked source, because counting on raw
 * text made `'foo'` inside a string look like a use, while the older regex-pair blanking
 * could swallow real code (a regex literal like /['"]/ opened a phantom string).
 *
 * Two emitters share one rule id on purpose: an unused *import* is a warn (it fakes the
 * dependency graph and inflates the bundle), an unused *declaration* is info (usually a
 * leftover from a refactor). The registry keeps a single entry.
 */

const finding = ({ rule, severity, file, line, message, why, evidence }) => ({ rule, severity, file, line, message, why, evidence });

export const BINDING_RULES = [
  {
    id: 'js-unused-binding', family: 'front', severity: 'warn', title: '未使用的 import',
    run: ({ f, src, blanked, lineOf, isJsOrVue }) => {
      if (!isJsOrVue) return [];
      const withoutComments = blanked;
      const out = [];
      for (const m of src.matchAll(/^[ \t]*import\s+([^;\n]+?)\s+from\s+['"][^'"]+['"]/gm)) {
        // `import type {A} from 'b'` / `import typeof A from 'b'`: the leading
        // keyword is a modifier, not a binding. Counting it as one reported every
        // type-only import as a dead binding (the keyword occurs exactly once).
        const clause = m[1].trim().replace(/^(?:type|typeof)\s+/, '');
        const bound = [];
        const defaultName = /^([A-Za-z_$][\w$]*)/.exec(clause)?.[1];
        if (defaultName && defaultName !== 'from') bound.push(defaultName);
        const braces = /\{([^}]*)\}/.exec(clause)?.[1];
        if (braces) for (const part of braces.split(',')) {
          const name = part.trim().split(/\s+as\s+/).pop()?.trim();
          if (name && /^[A-Za-z_$][\w$]*$/.test(name)) bound.push(name);
        }
        for (const name of bound) {
          const uses = [...withoutComments.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;
          if (uses > 1) continue;
          out.push(finding({
            rule: 'js-unused-binding', severity: 'warn', file: f, line: lineOf(m.index),
            message: `${f}:${lineOf(m.index)} import 了 \`${name}\` 但整个文件没再用过。`,
            why: '未使用的 import：AI 生成/改写的常见残留，增大打包体积、让"这个文件依赖谁"变假，也容易掩盖真正少 import 的东西。',
            evidence: `name=${name}, occurrences=${uses}`,
          }));
        }
      }
      return out;
    },
  },
  {
    id: 'js-unused-binding', family: 'front', severity: 'info', title: '声明后从未读取的绑定',
    run: ({ f, src, blanked, lineOf, isJsOrVue }) => {
      if (!isJsOrVue) return [];
      const withoutComments = blanked;
      const out = [];
      for (const m of src.matchAll(/^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) {
        const name = m[1];
        const uses = [...withoutComments.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;
        if (uses > 1) continue;
        out.push(finding({
          rule: 'js-unused-binding', severity: 'info', file: f, line: lineOf(m.index),
          message: `${f}:${lineOf(m.index)} 声明了 \`${name}\` 但从未被读取。`,
          why: '死绑定：很可能是重构后忘了删，或者本该用这个变量却写了别的名字。',
          evidence: `binding=${name}, occurrences=${uses}`,
        }));
      }
      return out;
    },
  },
];
