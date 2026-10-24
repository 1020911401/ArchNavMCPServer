/**
 * Golden snapshot for rule-model refactors: run every rule over a fixed file corpus and
 * dump the findings as sorted JSON. Any refactor must reproduce this byte-for-byte —
 * that is the only honest way to prove "declarative rewrite, same behaviour".
 *
 * Usage: node bench/rule-golden.mjs [--write]
 *   --write   create/overwrite bench/rule-golden.json (do this BEFORE the refactor)
 *   (default) compare against it and exit 1 on any difference
 */
import fs from 'node:fs';
import path from 'node:path';
import { scanContent } from '../scripts/review-rules.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TARGET = path.join(ROOT, 'bench', 'rule-golden.json');

// A corpus that exercises every family: PHP-ish, JS/Vue-ish, Python-ish, docs, configs.
const CORPUS_DIRS = ['scripts', 'src', 'tests', 'bench'];
const EXTRA = [
  ['app/Http/Controllers/OrderController.php', "<?php\nclass A {\n  public function x() { if ($a == $b) { dd($a); } }\n}\n"],
  ['app/Service.php', "<?php\n$q = DB::select(\"select * from u where id = {$_GET['id']}\");\n"],
  ['resources/js/app.js', "const payload = {};\nconsole.log(payload);\nif (x == null) {}\n// TODO: later\n"],
  ['resources/js/Comp.vue', "<template><div v-for=\"i in list\">{{ i.nope }}</div></template>\n<script>export default { methods: { go() { this.$refs.a.x(); } } }</script>\n"],
  ['tools/t.py', "def f(x):\n    try:\n        pass\n    except:\n        pass\n    return eval(x)\n"],
  ['tools/t.go', "package main\nfunc f() { os.Exit(0) }\n"],
  // Vue family: these three fixtures exist because the original corpus triggered none of
  // the vue rules, so a migration could have broken them silently.
  ['pages/detail/detail.vue', "<template>\n  <view v-for=\"(it, i) in list\" v-if=\"it.show\">{{ it.name }}</view>\n</template>\n<script>\nexport default {\n  props: { orderId: { type: String, required: true }, total: Number },\n  methods: {\n    bump() { this.total = 0; this.orderId = 'x'; },\n    tick() { setInterval(() => this.bump(), 1000); },\n  },\n};\n</script>\n"],
  ['pages/ok.vue', "<template><view v-for=\"i in list\" :key=\"i.id\">{{ i.name }}</view></template>\n<script>export default { data() { return { t: null }; }, mounted() { this.t = setInterval(()=>{}, 1000); }, beforeDestroy() { clearInterval(this.t); } };</script>\n"],
  // PHP read-modify-write + the other two stub branches (hash comment / thrown
  // placeholder). Written with \u escapes so this file's own source does not itself
  // read like a leftover stub — the checker scans bench/ too, and a fixture that
  // tripped the rule it was written to cover would be its own false positive.
  ['app/Service/Counter.php', "<?php\nfunction bump($order) {\n  $order->pay_count = $order->pay_count + 1;\n  $ok = $order->total - 1;\n  return $ok;\n}\n"],
  ['app/Service/HashTodo.php', "<?php\nfunction todo() {\n  # TODO: switch to atomic increment\n  return 1;\n}\n"],
  ['app/Service/Stub.php', "<?php\nfunction stub() {\n  throw new Error('\u672a\u5b9e\u73b0');\n}\n"],
  ['docs/a.md', "# Title\nTODO: fill in\n"],
  ['conf/a.yaml', "key: value\nnot implemented: true\n"],
];

const files = [];
for (const dir of CORPUS_DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.name === 'node_modules' || e.name === '.archnav' || e.name === '.git') continue;
      if (e.isDirectory()) walk(p);
      else if (/\.(php|js|mjs|cjs|ts|vue|py|go|md|ya?ml|json)$/.test(e.name)) files.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  };
  walk(abs);
}
for (const [rel, text] of EXTRA) {
  const abs = path.join(ROOT, rel);
  if (fs.existsSync(abs)) continue;                       // never clobber a real file
  files.push(rel);
  files[files.length - 1] = { rel, text };
}

const rows = [];
for (const entry of files) {
  const rel = typeof entry === 'string' ? entry : entry.rel;
  const src = typeof entry === 'string' ? fs.readFileSync(path.join(ROOT, rel), 'utf8') : entry.text;
  for (const f of scanContent(rel, src)) {
    rows.push({ rule: f.rule, severity: f.severity, file: rel, line: f.line ?? null, message: f.message });
  }
}
rows.sort((a, b) => (a.file + a.rule + String(a.line)).localeCompare(b.file + b.rule + String(b.line)));

const payload = { corpusFiles: files.length, findings: rows.length, rows };
if (process.argv.includes('--write')) {
  fs.writeFileSync(TARGET, JSON.stringify(payload, null, 2) + '\n');
  console.log(`golden written: ${TARGET} — ${rows.length} findings over ${files.length} files`);
} else {
  if (!fs.existsSync(TARGET)) { console.error('no golden file — run with --write first'); process.exit(2); }
  const before = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
  const same = JSON.stringify(before.rows) === JSON.stringify(rows);
  console.log(`golden compare: ${same ? 'IDENTICAL' : 'DIFFERS'} — before ${before.findings} / now ${rows.length} findings`);
  if (!same) {
    const key = (r) => `${r.file}|${r.rule}|${r.line}`;
    const b = new Map(before.rows.map((r) => [key(r), r]));
    const n = new Map(rows.map((r) => [key(r), r]));
    for (const [k, r] of b) if (!n.has(k)) console.log('  missing now:', k, '|', r.message.slice(0, 60));
    for (const [k, r] of n) if (!b.has(k)) console.log('  new now   :', k, '|', r.message.slice(0, 60));
    process.exit(1);
  }
}
