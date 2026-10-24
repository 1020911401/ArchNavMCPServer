/**
 * Vue family: prop mutation, v-if+v-for on one element, interval leak.
 *
 * Moved verbatim out of scanContent. These three read the raw `src` (templates are
 * markup, not blanked code) and only need `lineOf` — a good next candidate because the
 * migration surface is small while the rules themselves are non-trivial.
 *
 * `f` is the display form of the path (the scanner's normalised name) while `file` is the
 * name matched by the file-type regexes; both are passed so messages stay byte-identical.
 */

const finding = ({ rule, severity, file, line, message, why, evidence }) => ({ rule, severity, file, line, message, why, evidence });

export const VUE_RULES = [
  {
    id: 'vue-mutating-props', family: 'front', severity: 'warn', title: '子组件直接改 prop',
    run: ({ f, src, lineOf }) => {
      if (!/\.vue$/i.test(f)) return [];
      const out = [];
      const propsBlock = /props\s*:\s*(\{[\s\S]{0,600}?\}|\[[^\]]*\])/.exec(src);
      if (!propsBlock) return out;
      const names = [...propsBlock[1].matchAll(/(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*(?=:|,|\]|\})/g)].map((m) => m[1])
        .filter((n) => !['props', 'type', 'default', 'required', 'validator', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Function'].includes(n));
      for (const name of [...new Set(names)]) {
        const mut = new RegExp(`this\\.${name}\\s*(?:\\+\\+|--|[+\\-*/]?=(?!=))`).exec(src);
        if (!mut) continue;
        out.push(finding({
          rule: 'vue-mutating-props', severity: 'warn', file: f, line: lineOf(mut.index),
          message: `${f}:${lineOf(mut.index)} 直接修改 prop \`${name}\`（\`${mut[0].slice(0, 30)}\`）。`,
          why: '子组件改 prop 是单向数据流的破坏（父组件重渲染会覆盖，或者改了没有任何反应）；应 emit 事件让父组件改，或先复制到本地 data。',
          evidence: `prop=${name}, matched=${mut[0].slice(0, 40)}`,
        }));
      }
      return out;
    },
  },
  {
    id: 'vue-v-if-with-v-for', family: 'front', severity: 'warn', title: '同元素 v-if + v-for',
    run: ({ f, src, lineOf }) => {
      if (!/\.vue$/i.test(f)) return [];
      const out = [];
      for (const m of src.matchAll(/<([A-Za-z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
        const attrs = m[2];
        if (!(attrs.includes('v-if') && attrs.includes('v-for'))) continue;
        out.push(finding({
          rule: 'vue-v-if-with-v-for', severity: 'warn', file: f, line: lineOf(m.index),
          message: `${f}:${lineOf(m.index)} 同一个 <${m[1]}> 上同时有 v-if 与 v-for。`,
          why: 'Vue 2 里 v-for 优先于 v-if：条件晚于循环求值，既可能报错（访问不存在的变量）又把整个列表渲染一遍才筛掉。用 computed 先过滤，或把 v-if 移到外层 <template>。',
          evidence: `tag=${m[1]}`,
        }));
      }
      return out;
    },
  },
  {
    id: 'vue-timer-leak', family: 'front', severity: 'warn', title: 'setInterval 未清理',
    run: ({ f, src, lineOf }) => {
      if (!/\.vue$/i.test(f)) return [];
      if (!/setInterval\s*\(/.test(src) || /clearInterval\s*\(/.test(src)) return [];
      const m = /setInterval\s*\(/.exec(src);
      return [finding({
        rule: 'vue-timer-leak', severity: 'warn', file: f, line: lineOf(m.index),
        message: `${f}:${lineOf(m.index)} 用了 setInterval 但整个文件没有 clearInterval。`,
        why: '页面/组件销毁后定时器还在跑：拿着已卸载组件的状态发请求、刷数据，内存与请求都泄漏。在 onUnload/beforeDestroy/unmounted 里 clearInterval。',
        evidence: 'setInterval present, clearInterval absent',
      })];
    },
  },
];
