#!/usr/bin/env node
/**
 * audit-skill.mjs — the agent skill is documentation with claims, and claims rot.
 *
 *   node scripts/audit-skill.mjs           # human report, exit 1 on any error
 *   node scripts/audit-skill.mjs --json    # machine report
 *
 * It checks the things that can be checked without a model:
 *   1. every `scripts/x.mjs`, `src/x.js`, `references/x.md` named in the prose exists
 *   2. every `node src/index.js <cmd>` names a real CLI command
 *   3. every `--flag` written next to a script is mentioned by that script
 *   4. every `archnav://skill…` URI is actually served by src/mcp-playbook.js
 *   5. every served resource/prompt is discoverable from SKILL.md (the always-on page)
 *   6. every reference file on disk is reachable from the docs, and vice versa
 *   7. the "N 个坑" heading matches the number of items listed
 *   8. the frontmatter version matches the top changelog line
 *
 * Adding a skill claim that fails one of these is how the four drifts found in
 * v1.7.0 (stale `git add -N` advice, a resource missing from the table, a
 * reference to a script that never existed, "三个坑" over a list of five) will
 * be caught next time instead of by a reader.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const skillFlag = argv.indexOf('--skill');
// `--skill <dir>` audits a *copy*: the tests break the playbook on purpose and must
// never touch the tracked file (node --test runs files in parallel, so an in-place
// mutation is a race against every other test that reads skill/archnav).
const SKILL = skillFlag !== -1 ? path.resolve(argv[skillFlag + 1]) : path.join(ROOT, 'skill', 'archnav');
const JSON_OUT = argv.includes('--json');

const findings = [];
const report = (level, where, message, detail = '') => findings.push({ level, where, message, detail });

function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

const mdFiles = walk(SKILL);
const text = Object.fromEntries(mdFiles.map((f) => [f, fs.readFileSync(path.join(SKILL, f), 'utf8')]));

// ---- ground truth: the CLI -------------------------------------------------
const cliSrc = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
const cliCommands = new Set();
for (const m of cliSrc.matchAll(/\.command\(\s*['"`]([^'"`]+)/g)) {
  for (const token of m[1].split(/[\s|[\]]+/)) if (/^[a-z][a-z-]*$/.test(token)) cliCommands.add(token);
}

// ---- ground truth: the MCP playbook ---------------------------------------
const playbookSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-playbook.js'), 'utf8');
const servedPrompts = new Set([...playbookSrc.matchAll(/name:\s*'(archnav_[a-z_]+)'/g)].map((m) => m[1]));
const servedUris = new Set([...playbookSrc.matchAll(/uri:\s*'(archnav:\/\/[^']+)'/g)].map((m) => m[1]));
const servedFiles = new Map([...playbookSrc.matchAll(/uri:\s*'([^']+)',\s*file:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));

// ---- claim extraction ------------------------------------------------------
const seen = new Set();
const once = (key, level, where, message, detail) => {
  if (seen.has(key)) return;
  seen.add(key);
  report(level, where, message, detail);
};

const scriptSource = new Map();
const sourceOf = (rel) => {
  if (!scriptSource.has(rel)) {
    const abs = path.join(ROOT, rel);
    scriptSource.set(rel, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);
  }
  return scriptSource.get(rel);
};

for (const md of mdFiles) {
  text[md].split('\n').forEach((line, i) => {
    const where = `${md}:${i + 1}`;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const span = m[1];

      // 1. repo paths
      for (const p of span.matchAll(/\b((?:scripts|src|docs|bench|skill|tests|prompts)\/[A-Za-z0-9_./-]+\.(?:mjs|js|md|py|json|sh|tsv))/g)) {
        const rel = p[1];
        if (!fs.existsSync(path.join(ROOT, rel)) && !fs.existsSync(path.join(SKILL, rel))) {
          once(`path:${rel}`, 'error', where, 'references a path that does not exist', rel);
        }
      }

      // 2. CLI commands — both `node src/index.js <cmd>` and the installed `archnav <cmd>`
      for (const c of span.matchAll(/(?:node src\/index\.js|\barchnav)\s+([a-z][a-z-]+)/g)) {
        if (!cliCommands.has(c[1])) once(`cli:${c[1]}`, 'error', where, 'names a CLI command the CLI does not have', c[1]);
      }

      // 3. scripts + their flags
      for (const c of span.matchAll(/node (scripts\/[A-Za-z0-9_.-]+\.mjs)/g)) {
        const src = sourceOf(c[1]);
        if (!src) continue; // path check above already reported it
        for (const f of span.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]+)/g)) {
          if (!src.includes(f[1])) once(`flag:${c[1]}:${f[1]}`, 'error', where, 'documents a flag the script never reads', `${c[1]} ${f[1]}`);
        }
      }

      // 4. MCP resource URIs
      for (const u of span.matchAll(/archnav:\/\/[A-Za-z0-9/_-]+/g)) {
        if (!servedUris.has(u[0])) once(`uri:${u[0]}`, 'error', where, 'names an MCP resource the server does not serve', u[0]);
      }
    }
  });
}

// ---- 4b. the human docs make the same kind of claims ------------------------
// `docs/*.md` and README are written for humans and the skill references for agents.
// They are deliberately *not* the same text (merging them would lose one audience),
// but they name the same scripts, flags and resources — and that half drifts silently.
// Same extractors, one difference: a claim already reported for the skill is not
// reported twice.
const docsDir = path.join(ROOT, 'docs');
const docFiles = [
  'README.md',
  ...(fs.existsSync(docsDir) ? fs.readdirSync(docsDir).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`) : []),
];
for (const rel of docFiles) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  for (const [i, line] of fs.readFileSync(full, 'utf8').split('\n').entries()) {
    const where = `${rel}:${i + 1}`;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const span = m[1];
      for (const p of span.matchAll(/\b((?:scripts|src|skill|tests|docs)\/[A-Za-z0-9_./-]+\.(?:mjs|js|md|py|json|sh))/g)) {
        if (!fs.existsSync(path.join(ROOT, p[1]))) once(`docpath:${p[1]}`, 'error', where, 'doc references a path that does not exist', p[1]);
      }
      for (const c of span.matchAll(/(?:node src\/index\.js|\barchnav)\s+([a-z][a-z-]+)/g)) {
        if (!cliCommands.has(c[1])) once(`doccli:${c[1]}`, 'error', where, 'doc names a CLI command the CLI does not have', c[1]);
      }
      for (const c of span.matchAll(/node (scripts\/[A-Za-z0-9_.-]+\.mjs)/g)) {
        const src = sourceOf(c[1]);
        if (!src) continue;
        for (const f of span.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]+)/g)) {
          if (!src.includes(f[1])) once(`docflag:${c[1]}:${f[1]}`, 'error', where, 'doc documents a flag the script never reads', `${c[1]} ${f[1]}`);
        }
      }
      for (const u of span.matchAll(/archnav:\/\/[A-Za-z0-9/_-]+/g)) {
        if (!servedUris.has(u[0])) once(`docuri:${u[0]}`, 'error', where, 'doc names an MCP resource the server does not serve', u[0]);
      }
    }
  }
}

// ---- 4c. the rule count is a claim too -------------------------------------
// "61 rules" appears in README (twice, both languages) and in the handbook. It is the
// size of the rule table — a number that silently rots the day someone adds a rule.
const ruleTableCount = [...fs.readFileSync(path.join(ROOT, 'scripts', 'review-rules.mjs'), 'utf8')
  .matchAll(/\{ id: '[a-z0-9-]+', group: '/g)].length;
for (const rel of ['README.md', 'docs/review-rules.md', ...mdFiles.map((f) => `skill/archnav/${f}`)]) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  for (const [i, line] of fs.readFileSync(full, 'utf8').split('\n').entries()) {
    if (!/rule/i.test(line) && !/规则/.test(line)) continue;
    for (const m of line.matchAll(/(\d{2,3})\s+rules\b|(\d{2,3})\s*条规则/g)) {
      const claimed = Number(m[1] || m[2]);
      if (claimed !== ruleTableCount) {
        once(`rules:${rel}`, 'error', `${rel}:${i + 1}`, 'doc claims a rule count that no longer matches the table', `says ${claimed}, table has ${ruleTableCount}`);
      }
    }
  }
}

// ---- 4d. the MCP surface has a count and a roster too ----------------------
const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-server.js'), 'utf8');
const toolNames = [...serverSrc.matchAll(/name:\s*'(archnav_[a-z_]+)'/g)].map((m) => m[1]);
const readme = fs.existsSync(path.join(ROOT, 'README.md')) ? fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8') : '';
for (const m of readme.matchAll(/(\d+)\s+fused MCP tools|MCP tools \((\d+)/g)) {
  const claimed = Number(m[1] || m[2]);
  if (claimed !== toolNames.length) {
    report('error', 'README.md', 'doc claims an MCP tool count the server no longer has', `says ${claimed}, server has ${toolNames.length}`);
  }
}
for (const name of toolNames) {
  // backticked, or the prompt `archnav_review_diff` would satisfy `archnav_review`
  if (!readme.includes(`\`${name}\``)) report('error', 'README.md', 'an MCP tool the server exposes is not documented', name);
}

// ---- 4e. markdown links must resolve ---------------------------------------
// Prose links are claims too, and they are the ones a reader clicks. They live outside
// code spans, so the extractor above never sees them.
const LINK_SKIP = /^(?:[a-z]+:|#|\/\/)/i;
for (const rel of ['README.md', ...docFiles, ...mdFiles.map((f) => `skill/archnav/${f}`)]) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const base = path.dirname(abs);
  for (const [i, line] of fs.readFileSync(abs, 'utf8').split('\n').entries()) {
    for (const m of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1].split('#')[0].split('?')[0];
      if (!target || LINK_SKIP.test(target)) continue;
      const resolved = path.resolve(base, decodeURIComponent(target));
      if (!fs.existsSync(resolved)) {
        once(`link:${rel}:${target}`, 'error', `${rel}:${i + 1}`, 'markdown link points at a path that does not exist', target);
      }
    }
  }
}

// ---- 5. discoverability: every served surface is on the always-on page -----
// A passing mention is not discoverability: an agent reading SKILL.md finds the
// surfaces in the table, so the assertion is "the uri sits in a table row".
const thin = text['SKILL.md'] || '';
const tableLines = thin.split('\n').filter((l) => l.trimStart().startsWith('|'));
for (const [uri, file] of servedFiles) {
  if (!tableLines.some((l) => l.includes(uri))) {
    report('error', 'SKILL.md', 'served MCP resource is not in the playbook table', `${uri} (${file})`);
  }
}
for (const p of servedPrompts) {
  if (!tableLines.some((l) => l.includes(p)) && !thin.includes(p)) {
    report('error', 'SKILL.md', 'served MCP prompt is not mentioned', p);
  }
}

// ---- 5b. prompts: every declared prompt has its file, and every file a prompt -
const promptsDir = path.join(SKILL, 'prompts');
const promptFiles = fs.existsSync(promptsDir) ? fs.readdirSync(promptsDir).filter((f) => f.endsWith('.md')) : [];
const declaredPrompts = [...playbookSrc.matchAll(/name:\s*'(archnav_[a-z_]+)',\s*file:\s*'([^']+)'/g)].map((m) => ({ name: m[1], file: m[2] }));
for (const { name, file } of declaredPrompts) {
  const abs = path.join(promptsDir, file);
  if (!fs.existsSync(abs)) {
    report('error', 'src/mcp-playbook.js', 'prompt declares a file that does not exist', `${name} → prompts/${file}`);
    continue;
  }
  if (fs.statSync(abs).size < 200) report('warn', 'src/mcp-playbook.js', 'prompt body looks truncated', `${name} → prompts/${file}`);
}
for (const f of promptFiles) {
  if (!declaredPrompts.some((d) => d.file === f)) report('warn', 'skill/archnav/prompts', 'prompt file is not declared by mcp-playbook.js', f);
}

// ---- 6. reference files: on disk ⇄ referenced ------------------------------
const refsDir = path.join(SKILL, 'references');
const refFiles = fs.existsSync(refsDir) ? fs.readdirSync(refsDir).filter((f) => f.endsWith('.md')) : [];
const allProse = mdFiles.map((f) => text[f]).join('\n');
for (const r of refFiles) {
  // references/ *is* the served surface: a file here that no resource points at is a
  // doc nobody can reach through the MCP layer (mutation testing found this one — the
  // audit used to call it a warning, so a dead reference could sit there indefinitely).
  if (![...servedFiles.values()].some((f) => f.endsWith(`/${r}`))) {
    report('error', 'skill/archnav/references', 'reference file is not served as an MCP resource', r);
  }
  if (!allProse.includes(r)) report('warn', 'skill/archnav', 'reference file is orphaned (no doc links it)', `references/${r}`);
}
for (const file of servedFiles.values()) {
  if (!fs.existsSync(path.join(SKILL, file))) report('error', 'src/mcp-playbook.js', 'serves a resource file that does not exist', file);
}

// ---- 7. the "N 个坑" heading must match the list ---------------------------
const heading = thin.match(/^##\s+(.*坑.*)$/m);
if (heading) {
  const cn = heading[1].match(/[一二三四五六七八九十]/);
  const items = [...thin.matchAll(/^(\d+)\.\s+\*\*/gm)].map((m) => Number(m[1]));
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (cn && items.length && map[cn[0]] !== items.length) {
    report('error', 'SKILL.md', 'the heading count contradicts the list', `heading says ${map[cn[0]]}, the list has ${items.length}`);
  }
  const gaps = items.filter((n, i) => n !== i + 1);
  if (gaps.length) report('error', 'SKILL.md', 'pitfall numbering has a gap or duplicate', `sequence: ${items.join(',')}`);
}

// ---- 7b. the always-loaded page has a budget -------------------------------
// tests/mcp-playbook.test.mjs enforces the hard 4000-char cap; warn earlier, because
// the page is loaded on *every* turn and the drift is invisible in review diffs.
const SKILL_BUDGET = 4000;
if (thin.length > SKILL_BUDGET) {
  report('error', 'SKILL.md', 'always-loaded page is over budget', `${thin.length} chars > ${SKILL_BUDGET}`);
} else if (thin.length > SKILL_BUDGET * 0.75) {
  report('warn', 'SKILL.md', 'always-loaded page is approaching the budget', `${thin.length} chars, budget ${SKILL_BUDGET}`);
}

// ---- 8. frontmatter version vs the changelog line --------------------------
const fmVersion = (thin.match(/^version:\s*([\d.]+)/m) || [])[1];
const topVersion = (thin.match(/^> \*\*v([\d.]+)\*\*/m) || [])[1];
if (fmVersion && !topVersion) {
  report('error', 'SKILL.md', 'frontmatter version has no visible version stamp', `version: ${fmVersion}`);
}
if (fmVersion && topVersion && fmVersion !== topVersion) {
  report('error', 'SKILL.md', 'frontmatter version and changelog disagree', `frontmatter ${fmVersion} vs changelog ${topVersion}`);
}

// ---- 9. advice the tool has already outgrown -------------------------------
// A sentence can be internally consistent, point at real files, and still be wrong
// because the tool moved. `git add -N .` as a *step* is the canonical case: `changes`
// already reports untracked files, so the step is pure state mutation. Negated lines
// ("不用…") are the correction, not the defect.
const STALE_ADVICE = [
  { re: /git add -N\s+\./, why: '`changes` 已经包含未跟踪文件；`git add -N .` 只是状态变更，只有裸 `git diff` 需要' },
];
for (const md of mdFiles) {
  text[md].split('\n').forEach((line, i) => {
    if (/不用|不需要|只在|是给/.test(line)) return;
    for (const s of STALE_ADVICE) {
      if (s.re.test(line)) report('error', `${md}:${i + 1}`, 'repeats advice the tool has outgrown', s.why);
    }
  });
}

// ---- report ---------------------------------------------------------------
const errors = findings.filter((f) => f.level === 'error');
const warnings = findings.filter((f) => f.level === 'warn');
if (JSON_OUT) {
  console.log(JSON.stringify({ skill: 'archnav', version: fmVersion || null, files: mdFiles.length, errors, warnings }, null, 2));
} else {
  for (const f of [...errors, ...warnings]) {
    console.log(`${f.level === 'error' ? '❌' : '⚠️'} ${f.where}  ${f.message}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  console.log(`\n${mdFiles.length} md files · ${errors.length} error(s) · ${warnings.length} warning(s)`);
}
process.exit(errors.length ? 1 : 0);
