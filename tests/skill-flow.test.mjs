/**
 * skill-flow.test.mjs — execute the playbook the way an agent would.
 *
 * The audit (tests/skill-claims.test.mjs) checks that the skill's claims *resolve*;
 * this file checks that they are *true*: it builds a throwaway git repo and walks
 * the flow the skill tells an agent to walk — analyze → locate → read → whereami →
 * arch → impact → changes → review-rules (compact/full) → test-select → deep →
 * version → MCP prompts/resources — asserting the documented behaviour, including
 * the five "pitfalls" the playbook tells the reader to expect.
 *
 * It deliberately does not need bench/ (customer-code copies) or the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE = process.execPath;

function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-skill-'));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });

  w('package.json', JSON.stringify({ name: 'fixture', version: '1.2.3', type: 'module' }) + '\n');
  w('.gitignore', 'build/\nnode_modules/\n.archnav/\n');
  w('src/math.js', 'export function add(a, b) {\n  return a + b;\n}\n');
  w('src/cart.js', [
    "import { add } from './math.js';",
    '',
    'export function calcTotal(items) {',
    '  let total = 0;',
    '  for (const item of items) total = add(total, item.price);',
    '  return total;',
    '}',
    '',
    'export function applyDiscount(items, rate) {',
    '  if (rate == 1) return calcTotal(items);',
    '  return calcTotal(items) * (1 - rate);',
    '}',
    '',
  ].join('\n'));
  w('src/api.js', [
    "import { applyDiscount } from './cart.js';",
    '',
    'export function handleOrder(req) {',
    '  return { total: applyDiscount(req.items, req.rate) };',
    '}',
    '',
  ].join('\n'));
  w('build/gen.js', 'export function generated() {\n  return 1;\n}\n');
  w('tests/cart.test.mjs', [
    "import test from 'node:test';",
    "import assert from 'node:assert';",
    "import { calcTotal } from '../src/cart.js';",
    "test('total', () => assert.equal(calcTotal([{ price: 2 }]), 2));",
    '',
  ].join('\n'));
  git('init', '-q', '.');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

const cli = (dir, ...args) => spawnSync(NODE, [path.join(ROOT, 'src', 'index.js'), ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const script = (dir, rel, ...args) => spawnSync(NODE, [path.join(ROOT, rel), ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const asJson = (r) => JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));

test('the documented flow works end to end on a scratch repo', { skip: spawnSync('git', ['--version']).status !== 0 ? 'git is not available' : false }, async (t) => {
  const dir = scratchRepo();
  const failures = [];
  const expect = (name, ok, evidence) => {
    t.diagnostic(`${ok ? '✅' : '❌'} ${name}${evidence ? `  ${evidence}` : ''}`);
    if (!ok) failures.push(`${name}: ${evidence}`);
  };

  // 1. analyze
  const analyzed = cli(dir, 'analyze', '.');
  const index = JSON.parse(fs.readFileSync(path.join(dir, '.archnav', 'index.json'), 'utf8'));
  expect('analyze builds an index', analyzed.status === 0 && (index.symbols || []).length > 0, `${(index.symbols || []).length} symbols`);

  // 2. locate, and the line has to be the real one
  const locate = asJson(cli(dir, 'locate', 'calcTotal', '--json')).symbol;
  const realLine = fs.readFileSync(path.join(dir, 'src', 'cart.js'), 'utf8').split('\n').findIndex((l) => l.includes('function calcTotal')) + 1;
  expect('locate returns the real file:line', locate.file.endsWith('cart.js') && locate.line_start === realLine, `${locate.file}:${locate.line_start}`);

  // 3. read re-reads the disk
  const read = cli(dir, 'read', 'calcTotal');
  expect('read returns source, not a graph node', /function calcTotal/.test(read.stdout), 'body present');

  // 4. whereami
  const where = cli(dir, 'whereami', 'src/cart.js', String(realLine));
  expect('whereami maps file:line → symbol', /calcTotal/.test(where.stdout), where.stdout.trim().split('\n')[0]);

  // 5. arch
  expect('arch prints layers', cli(dir, 'arch').status === 0, '');

  // 6. impact walks two hops
  const impact = JSON.stringify(asJson(cli(dir, 'impact', 'calcTotal', '--json')));
  expect('impact reaches depth 1 (applyDiscount) and depth 2 (handleOrder)', /applyDiscount/.test(impact) && /handleOrder/.test(impact), '');

  // 7. pitfall #1: untracked files are already changes; `.archnav/` would not be
  fs.writeFileSync(path.join(dir, 'src', 'promo.js'), "import { calcTotal } from './cart.js';\n\nexport function promoTotal(items) {\n  return calcTotal(items) * 0.9;\n}\n");
  const untracked = asJson(cli(dir, 'changes', '--scope', 'unstaged', '--json'));
  const listed = (untracked.changed_files || []).map((f) => f.file.replace(/\\/g, '/'));
  expect('pitfall #1: untracked promo.js is listed without `git add -N`', listed.includes('src/promo.js'), listed.join(','));
  expect('pitfall #1: `.archnav/` stays out of changes when gitignored', !listed.some((f) => f.startsWith('.archnav/')), '');

  // 7b. the scope names are not what an agent assumes: `staged` is index+untracked,
  //     so an unstaged worktree edit is invisible under it (a real "reviewed nothing" trap)
  fs.appendFileSync(path.join(dir, 'src', 'api.js'), '\n// unstaged worktree edit\n');
  const stagedFiles = (asJson(cli(dir, 'changes', '--scope', 'staged', '--json')).changed_files || []).map((f) => f.file.replace(/\\/g, '/'));
  const unstagedFiles = (asJson(cli(dir, 'changes', '--scope', 'unstaged', '--json')).changed_files || []).map((f) => f.file.replace(/\\/g, '/'));
  expect('scope: `staged` shows untracked files but hides an unstaged edit', stagedFiles.includes('src/promo.js') && !stagedFiles.includes('src/api.js'), `staged=${stagedFiles.join(',')}`);
  expect('scope: `unstaged` does show the worktree edit', unstagedFiles.includes('src/api.js'), `unstaged=${unstagedFiles.join(',')}`);

  // 8. pitfall #2: stale index reports the new file's import; re-analyze clears it
  fs.writeFileSync(path.join(dir, 'src', 'metrics.js'), 'export function score(a) {\n  return a.length;\n}\n');
  fs.appendFileSync(path.join(dir, 'src', 'promo.js'), "\nimport { score } from './metrics.js';\n\nexport function promoScore(a) {\n  return score(a);\n}\n");
  const stale = script(dir, 'scripts/review-rules.mjs', '.', '--scope', 'unstaged', '--json', '--no-compact');
  const fresh0 = JSON.parse(stale.stdout);
  const staleHit = (fresh0.findings || []).some((f) => f.rule === 'js-unresolved-local-import');
  cli(dir, 'analyze', '.');
  const fresh = asJson(script(dir, 'scripts/review-rules.mjs', '.', '--scope', 'unstaged', '--json', '--no-compact'));
  const freshHit = (fresh.findings || []).some((f) => f.rule === 'js-unresolved-local-import');
  expect('pitfall #2: stale index flags the new import, re-analyze clears it', staleHit && !freshHit, `stale=${staleHit} fresh=${freshHit}`);

  // 9. pitfall #3: compact by default in brief, evidence only with --no-compact
  fs.writeFileSync(path.join(dir, 'src', 'legacy.js'), "import { nothing } from './nope.js';\n\nexport function legacy(a, b) {\n  if (a == b) return nothing(a);\n  return 0;\n}\n");
  const compact = asJson(script(dir, 'scripts/review-rules.mjs', '.', '--scope', 'unstaged', '--json'));
  const full = asJson(script(dir, 'scripts/review-rules.mjs', '.', '--scope', 'unstaged', '--json', '--no-compact'));
  const compactHasEvidence = (compact.findings || []).some((f) => f.evidence !== undefined || f.message !== undefined);
  const fullHasEvidence = (full.findings || []).some((f) => f.evidence !== undefined || f.message !== undefined);
  expect('pitfall #3: --json is compact, --no-compact carries evidence', (compact.findings || []).length > 0 && !compactHasEvidence && fullHasEvidence, `compact=${(compact.findings || []).length} full=${(full.findings || []).length}`);

  // 10. pitfall #4: .gitignore is honoured — including the documented *subset*
  //     semantics (leading/trailing `/` stripped, `!` negation lines skipped)
  fs.mkdirSync(path.join(dir, 'gen'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gen', 'custom.js'), 'export function g() { return 1; }\n');
  fs.mkdirSync(path.join(dir, 'keep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'keep', 'k.js'), 'export function k() { return 2; }\n');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'd.js'), 'export function d() { return 3; }\n');
  fs.appendFileSync(path.join(dir, '.gitignore'), 'gen/\n/dist/\nkeep/\n!keep/k.js\n');
  cli(dir, 'analyze', '.');
  const reindexed = JSON.parse(fs.readFileSync(path.join(dir, '.archnav', 'index.json'), 'utf8'));
  const files = Object.keys(reindexed.fileHashes || {}).map((f) => f.replace(/\\/g, '/'));
  expect('pitfall #4: ignored dirs stay out of the index', !files.some((f) => /^(build|gen|dist|keep)\//.test(f)), `${files.length} files indexed`);
  expect('pitfall #4: `/dist/` is recorded without slashes, `!` lines are skipped', reindexed.ignore.includes('dist') && !reindexed.ignore.includes('!keep/k.js'), `ignore=${JSON.stringify(reindexed.ignore)}`);
  expect('pitfall #4: a `!` negation does not re-include an ignored file', !files.includes('keep/k.js'), 'keep/k.js absent');

  // 11. pitfall #5/#6: the scoped-call bookkeeping exists (PHP-shaped index)
  expect('pitfall #5: unresolvedScopedCalls + scopedCallStats are on the index', 'unresolvedScopedCalls' in (reindexed.knowledgeGraph || {}) && 'scopedCallStats' in reindexed.knowledgeGraph, '');

  // 12. version
  const version = cli(dir, 'version', '.');
  expect('version reports git HEAD, manifest version and index commit', /HEAD|commit/i.test(version.stdout) && /1\.2\.3/.test(version.stdout), '');

  // 13. test-select: touch a symbol a test actually reaches, then ask
  const cartPath = path.join(dir, 'src', 'cart.js');
  fs.writeFileSync(cartPath, fs.readFileSync(cartPath, 'utf8').replace('let total = 0;', 'let total = 0; // touched'));
  const selected = script(dir, 'scripts/test-select.mjs', '.', '--scope', 'unstaged');
  expect('test-select maps the change to tests/cart.test.mjs', /tests\/cart\.test\.mjs/.test(selected.stdout), selected.stdout.split('\n').find((l) => /cart\.test/.test(l)) || '');

  // 14. deep, with no external binary
  const deep = script(dir, 'scripts/deep.mjs', '.', '--flows');
  expect('deep --flows runs without an external engine', deep.status === 0, `${deep.status}`);

  // 15. MCP surface
  const mcp = await probeMcp(dir);
  expect('MCP serves the four documented prompts', ['archnav_review_diff', 'archnav_self_review', 'archnav_test_select', 'archnav_deep'].every((p) => mcp.prompts.includes(p)), mcp.prompts.join(','));
  expect('MCP serves every resource named in SKILL.md', ['archnav://skill', 'archnav://skill/code-review', 'archnav://skill/self-review', 'archnav://skill/comparison', 'archnav://skill/kanban-review', 'archnav://skill/anchor-review', 'archnav://skill/playbook-full'].every((u) => mcp.uris.includes(u)), `${mcp.uris.length} resources`);
  expect('MCP resource body equals the file on disk', mcp.skillText === fs.readFileSync(path.join(ROOT, 'skill', 'archnav', 'SKILL.md'), 'utf8'), '');
  expect('prompts/get returns the declared prompt file verbatim',
    mcp.reviewDiffBody.trim() === fs.readFileSync(path.join(ROOT, 'skill', 'archnav', 'prompts', 'review-diff.md'), 'utf8').trim(),
    `${mcp.reviewDiffBody.length} chars`);
  expect('prompts/get appends the target dir when one is passed', /\/tmp\/somewhere/.test(mcp.deepBody), `${mcp.deepBody.length} chars`);

  // Best-effort cleanup: Windows can hold the directory for a moment after the MCP
  // child exits, so retry with a real delay instead of a single synchronous try.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      break;
    } catch (e) {
      if (attempt === 5) t.diagnostic(`⚠️ could not remove scratch repo: ${dir} (${e.code})`);
      else await new Promise((r) => setTimeout(r, 200));
    }
  }
  assert.deepEqual(failures, [], `the skill promises behaviour the tool does not have:\n${failures.join('\n')}`);
});

// The review layer makes promises the CLI never prints unless something goes wrong:
// `--gate` exits 1 on error findings, a waiver without a reason is not a waiver, and
// `--scope corpus` scans the whole index. The PHP comparison rules are the sharpest
// case: `php-loose-comparison` reports one thing per file (equality *or* comparison to
// an empty string, whoever matches first), and uncast config/input compared with a
// number belongs to `php-uncast-value-compare` — the skill states all three.
test('the review layer keeps its promises (gate, waivers, corpus, PHP rules)', { skip: spawnSync('git', ['--version']).status !== 0 ? 'git is not available' : false }, async (t) => {
  const dir = phpRepo();
  const failures = [];
  const expect = (name, ok, evidence) => {
    t.diagnostic(`${ok ? '✅' : '❌'} ${name}${evidence ? `  ${evidence}` : ''}`);
    if (!ok) failures.push(`${name}: ${evidence}`);
  };
  const review = (...args) => {
    const r = script(dir, 'scripts/review-rules.mjs', '.', ...args);
    let json = null;
    try { json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch { /* not asked for json */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };
  const rules = (json) => (json?.findings || []).map((f) => f.rule);

  cli(dir, 'analyze', '.');

  // gate: an `error` finding must fail the build, and only that
  const gate = review('--scope', 'unstaged', '--json', '--gate');
  expect('--gate exits 1 on an error-severity finding', gate.status === 1 && rules(gate.json).includes('js-dangerous-function'), `exit=${gate.status}`);
  const noGate = review('--scope', 'unstaged', '--json');
  expect('without --gate the same run exits 0', noGate.status === 0, `exit=${noGate.status}`);

  // waivers: no reason → not waived; with reason → waived
  const waivers = path.join(dir, 'waivers.json');
  fs.writeFileSync(waivers, JSON.stringify({ waivers: [{ rule: 'js-dangerous-function', file: 'src/danger.js' }] }));
  const reasonless = review('--scope', 'unstaged', '--json', '--no-compact', '--waivers', waivers);
  expect('a waiver with no reason does not silence the finding', rules(reasonless.json).includes('js-dangerous-function'), `waived=${(reasonless.json?.waived || []).length}`);
  fs.writeFileSync(waivers, JSON.stringify({ waivers: [{ rule: 'js-dangerous-function', file: 'src/danger.js', reason: '测试夹具，故意 eval' }] }));
  const withReason = review('--scope', 'unstaged', '--json', '--no-compact', '--waivers', waivers);
  expect('a waiver with a reason does silence it (and is recorded as waived)',
    !rules(withReason.json).includes('js-dangerous-function') && (withReason.json?.waived || []).length === 1,
    `waived=${(withReason.json?.waived || []).length}`);

  // corpus: whole-index sweep, off the diff path
  const corpus = review('--scope', 'corpus', '--json', '--no-compact');
  expect('--scope corpus runs on the whole index', corpus.status === 0 && (corpus.json?.harness?.scope?.files || 0) > 0, `files=${corpus.json?.harness?.scope?.files ?? '?'}`);

  // PHP rules, as the skill describes them
  const php = review('--scope', 'corpus', '--json', '--all-rules', '--no-compact');
  const phpFindings = (php.json?.findings || []).filter((f) => f.rule.startsWith('php-'));
  const uncast = phpFindings.filter((f) => f.rule === 'php-uncast-value-compare');
  expect('php-uncast-value-compare catches config compared with a number', uncast.length === 1, uncast.map((f) => f.evidence).join(' | '));
  const loose = phpFindings.filter((f) => f.rule === 'php-loose-comparison');
  expect('php-loose-comparison reports one finding per file (first match wins)', loose.length === 2, `files with findings: ${loose.map((f) => path.basename(f.file)).join(',')}`);
  const looseOn = (name) => loose.some((f) => path.basename(f.file) === name);
  expect('php-loose-comparison fires on `==` and on comparison with an empty string', looseOn('Equality.php') && looseOn('EmptyCompare.php'), `equality=${looseOn('Equality.php')} empty=${looseOn('EmptyCompare.php')}`);
  expect('a `<>` comparison is not reported by any rule (documented gap)', !phpFindings.some((f) => /<>/.test(f.evidence || '')), '');

  // brief is the cheap path: extended rules (php-loose-comparison) do not run
  const brief = review('--scope', 'corpus', '--json', '--no-compact');
  expect('brief does not run the extended PHP comparison rule', !(brief.json?.findings || []).some((f) => f.rule === 'php-loose-comparison'), `enabled=${brief.json?.harness?.rules?.enabled ?? '?'}/${brief.json?.harness?.rules?.registry ?? '?'}`);

  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* tmp */ }
  assert.deepEqual(failures, [], `the review layer does not keep the skill's promises:\n${failures.join('\n')}`);
});

/** A tiny repo where the review layer has something to say: one error, two PHP files,
 *  one uncast config comparison, one `<>` (the documented blind spot). */
function phpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archnav-review-'));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  w('package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module' }) + '\n');
  w('composer.json', JSON.stringify({ name: 'fixture/php', require: { php: '>=8.0' } }) + '\n');
  w('.gitignore', '.archnav/\n');
  w('src/danger.js', 'export function run(code) {\n  return eval(code);\n}\n');
  w('Equality.php', '<?php\nclass Equality\n{\n    public function cmp($a, $b)\n    {\n        if ($a == $b) { return 1; }\n        return 0;\n    }\n}\n');
  w('EmptyCompare.php', '<?php\nclass EmptyCompare\n{\n    public function cmp($x)\n    {\n        if ("" < 0) { return 1; }\n        return 0;\n    }\n}\n');
  w('Limit.php', '<?php\nclass Limit\n{\n    public function get()\n    {\n        $limit = config("app.limit");\n        if ($limit > 0) { return $limit; }\n        return 0;\n    }\n}\n');
  w('Alias.php', '<?php\nclass Alias\n{\n    public function cmp($a, $b)\n    {\n        if ($a <> $b) { return 1; }\n        return 0;\n    }\n}\n');
  // Everything stays *untracked* on purpose: `changes` already counts untracked files,
  // which is the claim the playbook makes (and a committed baseline would hide it).
  spawnSync('git', ['init', '-q', '.'], { cwd: dir });
  return dir;
}

function probeMcp(dir) {  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [path.join(ROOT, 'src', 'mcp-server.js')], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const waiters = new Map();
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && waiters.has(msg.id)) {
          waiters.get(msg.id)(msg);
          waiters.delete(msg.id);
        }
      }
    });
    const send = (id, method, params = {}) => new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`${method} timed out`)), 20000);
      waiters.set(id, (m) => { clearTimeout(timer); res(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    (async () => {
      await send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'skill-flow', version: '1' } });
      const prompts = await send(2, 'prompts/list');
      const resources = await send(3, 'resources/list');
      const read = await send(4, 'resources/read', { uri: 'archnav://skill' });
      // prompts/get must return the file the playbook claims it does — a prompt that
      // silently serves a different (or empty) body is a broken workflow, not a doc nit.
      const prompt = await send(5, 'prompts/get', { name: 'archnav_review_diff' });
      const deepPrompt = await send(6, 'prompts/get', { name: 'archnav_deep', arguments: { dir: '/tmp/somewhere' } });
      const result = {
        prompts: (prompts.result?.prompts || []).map((p) => p.name),
        uris: (resources.result?.resources || []).map((r) => r.uri),
        skillText: read.result?.contents?.[0]?.text || '',
        reviewDiffBody: prompt.result?.messages?.[0]?.content?.text || '',
        deepBody: deepPrompt.result?.messages?.[0]?.content?.text || '',
      };
      // Wait for the child to actually exit: on Windows a killed process keeps its
      // working directory handle for a moment, and the caller deletes that directory
      // right after (EPERM, seen intermittently before this await was added).
      child.kill();
      await new Promise((res) => (child.exitCode !== null ? res() : child.once('exit', res)));
      resolve(result);
    })().catch(async (e) => { child.kill(); await new Promise((res) => (child.exitCode !== null ? res() : child.once('exit', res))); reject(e); });
  });
}
