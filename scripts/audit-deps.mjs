#!/usr/bin/env node
/**
 * audit-deps — dependency vulnerability audit for the review pipeline.
 *
 * Why OSV instead of the ecosystem tools:
 *   `npm audit` does not work on a machine whose registry is a mirror — measured here:
 *   npmmirror returns 404 NOT_IMPLEMENTED for /-/npm/v1/security/advisories/bulk, so
 *   "0 vulnerabilities" would have been a lie. composer / govulncheck / pip-audit are
 *   simply not installed. The OSV database covers all four ecosystems over plain HTTP,
 *   needs no toolchain, and is the same source govulncheck consumes.
 *
 * Boundary: this audits the *declared* dependency set from lockfiles — it is not SBOM
 * provenance, not license compliance, and it only knows versions that are pinned
 * (a floating range is reported as unscannable rather than guessed at).
 *
 * Usage:
 *   node scripts/audit-deps.mjs [dir] [--json] [--markdown FILE|-] [--fail-on high|critical]
 *   node scripts/audit-deps.mjs [dir] --osv-fixture file.json   # offline: replay a saved OSV response
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const norm = (p) => String(p ?? '').replace(/\\/g, '/');

/** package-lock.json (v1 `dependencies` or v2/v3 `packages`) → {name, version, ecosystem}. */
export function parseNpmLock(text) {
  const out = [];
  let json;
  try { json = JSON.parse(text); } catch { return out; }
  if (json.packages) {
    for (const [key, meta] of Object.entries(json.packages)) {
      if (!key || !meta || meta.link) continue;
      const name = key.replace(/^node_modules\//, '').split('node_modules/').pop();
      if (meta.version) out.push({ name, version: String(meta.version), ecosystem: 'npm', dev: Boolean(meta.dev) });
    }
  } else if (json.dependencies) {
    for (const [name, meta] of Object.entries(json.dependencies)) {
      if (meta && meta.version) out.push({ name, version: String(meta.version), ecosystem: 'npm', dev: Boolean(meta.dev) });
    }
  }
  return out;
}

/** composer.lock packages[] → {name, version, ecosystem}. */
export function parseComposerLock(text) {
  const out = [];
  let json;
  try { json = JSON.parse(text); } catch { return out; }
  for (const list of [json.packages || [], json['packages-dev'] || []]) {
    for (const p of list) {
      if (p && p.name && p.version) out.push({ name: p.name, version: String(p.version).replace(/^v/, ''), ecosystem: 'Packagist', dev: list === json['packages-dev'] });
    }
  }
  return out;
}

/** go.mod require blocks → {name, version, ecosystem}. Indirect dependencies count too. */
export function parseGoMod(text) {
  const out = [];
  const add = (line, indirect) => {
    const m = /^\s*([\w./-]+)\s+v(\S+)/.exec(line);
    if (m) out.push({ name: m[1], version: m[2].replace(/\+incompatible$/, ''), ecosystem: 'Go', dev: indirect });
  };
  let inBlock = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '');
    if (/^\s*require\s*\(/.test(line)) { inBlock = true; continue; }
    if (inBlock) {
      if (/^\s*\)/.test(line)) { inBlock = false; continue; }
      add(line, /indirect/.test(raw));
      continue;
    }
    if (/^\s*require\s+/.test(line)) add(line.replace(/^\s*require\s+/, ''), /indirect/.test(raw));
  }
  return out;
}

/** requirements.txt pinned entries → {name, version, ecosystem}; unpinned lines are surfaced. */
export function parseRequirements(text) {
  const pinned = [];
  const unscannable = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const m = /^([A-Za-z0-9_.-]+)\s*==\s*([\w.!+-]+)/.exec(line);
    if (m) pinned.push({ name: m[1], version: m[2], ecosystem: 'PyPI', dev: false });
    else {
      const name = /^([A-Za-z0-9_.-]+)/.exec(line)?.[1];
      if (name) unscannable.push({ name, spec: line.slice(name.length).trim() });
    }
  }
  return { pinned, unscannable };
}

/** Collect the declared dependency set from whatever lockfiles the repo has. */
export function collectDependencies(dir) {
  const read = (rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return null; } };
  const result = { deps: [], ecosystems: {}, unscannable: [], missing: [] };

  const npmLock = read('package-lock.json');
  if (npmLock) {
    const deps = parseNpmLock(npmLock);
    result.deps.push(...deps);
    result.ecosystems.npm = deps.length;
  } else {
    const pkg = read('package.json');
    if (pkg) {
      try {
        const json = JSON.parse(pkg);
        const declared = Object.keys({ ...(json.dependencies || {}), ...(json.devDependencies || {}) });
        if (declared.length) {
          result.missing.push({ ecosystem: 'npm', reason: `有 package.json（${declared.length} 条声明）但没有 package-lock.json：装不出确定版本，无法审计`, hint: 'npm install --package-lock-only' });
        }
      } catch { /* malformed package.json */ }
    }
  }

  const composerLock = read('composer.lock');
  if (composerLock) {
    const deps = parseComposerLock(composerLock);
    result.deps.push(...deps);
    result.ecosystems.Packagist = deps.length;
  } else if (read('composer.json')) {
    result.missing.push({ ecosystem: 'Packagist', reason: '有 composer.json 但没有 composer.lock：版本不确定', hint: 'composer update --lock' });
  }

  const goMod = read('go.mod');
  if (goMod) {
    const deps = parseGoMod(goMod);
    result.deps.push(...deps);
    result.ecosystems.Go = deps.length;
  }

  const req = read('requirements.txt');
  if (req) {
    const { pinned, unscannable } = parseRequirements(req);
    result.deps.push(...pinned);
    result.ecosystems.PyPI = pinned.length;
    for (const u of unscannable) result.unscannable.push({ ...u, reason: '未固定版本（没有 ==），OSV 只能按范围匹配，可能是噪声' });
  }
  const pyproject = read('pyproject.toml');
  if (!req && pyproject) {
    result.missing.push({ ecosystem: 'PyPI', reason: '只有 pyproject.toml：多数声明是版本范围，无 lock 可查', hint: 'pip-compile / uv lock 生成锁定文件' });
  }

  // dedupe (a lockfile can list the same package twice under different paths)
  const seen = new Set();
  result.deps = result.deps.filter((d) => {
    const k = `${d.ecosystem}:${d.name}@${d.version}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return result;
}

/** Map an OSV record to {severity, score, summary}. */
export function osvSeverity(vuln) {
  const dbSev = vuln?.database_specific?.severity || vuln?.ecosystem_specific?.severity || null;
  // OSV puts the CVSS *vector* in severity[].score for CVSS_V3 (the numeric score is
  // only present for some records). Do not invent a score from the vector: use the
  // database severity when there is one, and keep the vector as evidence.
  const cvss = (vuln?.severity || []).find((s) => /CVSS/.test(s.type))?.score || null;
  const numeric = typeof cvss === 'number' ? cvss : (/^[0-9]+(\.[0-9]+)?$/.test(String(cvss || '').trim()) ? Number(cvss) : null);
  const score = numeric;
  let level = String(dbSev || '').toUpperCase();
  if (!level && score !== null) level = score >= 9 ? 'CRITICAL' : score >= 7 ? 'HIGH' : score >= 4 ? 'MODERATE' : 'LOW';
  return { level: level || 'UNKNOWN', score, cvss };
}

/** OSV records → our findings. `severityOfLevel` decides the finding severity. */
export function osvFindings(entries, { mapSeverity = (level) => (level === 'CRITICAL' || level === 'HIGH' ? 'warn' : 'info') } = {}) {
  const out = [];
  for (const { dep, vuln } of entries) {
    const { level, score, cvss } = osvSeverity(vuln);
    const fixed = (vuln.affected || []).flatMap((a) => a.ranges || []).flatMap((r) => r.events || []).map((e) => e.fixed).filter(Boolean);
    out.push({
      rule: 'dep-vulnerability', severity: mapSeverity(level), file: null, line: null,
      message: `${dep.ecosystem} ${dep.name}@${dep.version} → ${vuln.id}${vuln.summary ? `：${vuln.summary}` : ''}`,
      why: `已知依赖漏洞（${level}${score ? ` CVSS ${score}` : ''}）。它多半不是本次改动引入的，所以默认只是 warn/info；要么升级到修复版本，要么在评审里明确接受。`,
      evidence: `${vuln.id}${fixed.length ? `, fixed in ${[...new Set(fixed)].slice(0, 3).join('/')}` : ''}${cvss ? `, ${cvss}` : ''}`,
    });
  }
  return out;
}

/** Query OSV (batch, then details for the affected packages only). Injectable for tests. */
export async function queryOsv(deps, { fetchImpl = globalThis.fetch, batchSize = 100, timeoutMs = 30000 } = {}) {
  const entries = [];
  const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('OSV timeout')), timeoutMs))]);
  for (let i = 0; i < deps.length; i += batchSize) {
    const chunk = deps.slice(i, i + batchSize);
    const res = await withTimeout(fetchImpl('https://api.osv.dev/v1/querybatch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: chunk.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })) }),
    }));
    if (!res.ok) throw new Error(`OSV querybatch HTTP ${res.status}`);
    const json = await res.json();
    const results = json.results || [];
    for (let j = 0; j < chunk.length; j++) {
      const ids = (results[j]?.vulns || []).map((v) => v.id);
      for (const id of ids) {
        const detail = await withTimeout(fetchImpl(`https://api.osv.dev/v1/vulns/${id}`));
        if (!detail.ok) continue;
        entries.push({ dep: chunk[j], vuln: await detail.json() });
      }
    }
  }
  return entries;
}

function parseArgs(argv) {
  const out = { dir: '.', json: false, markdown: null, failOn: null, osvFixture: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--markdown') out.markdown = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '-';
    else if (a === '--fail-on') out.failOn = String(argv[++i]).toUpperCase();
    else if (a === '--osv-fixture') out.osvFixture = argv[++i];
    else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2); }
    else out.dir = a;
  }
  return out;
}

/** Rows for the review task sheet (same shape as the rule registry). */
export function buildDepChecklist({ collected, entries, error }) {
  const rows = [];
  const byEco = new Map();
  for (const { dep } of entries) byEco.set(dep.ecosystem, (byEco.get(dep.ecosystem) || 0) + 1);
  for (const [eco, count] of Object.entries(collected.ecosystems)) {
    const hits = byEco.get(eco) || 0;
    rows.push({
      id: `deps.${eco.toLowerCase()}`, group: '依赖漏洞', family: 'deps',
      title: `${eco} 依赖漏洞审计（${count} 个已固定版本）`,
      status: hits ? 'hit' : 'pass', hits,
      reason: hits ? `${hits} 条公告` : '无已知漏洞',
    });
  }
  for (const m of collected.missing) {
    rows.push({
      id: `deps.${m.ecosystem.toLowerCase()}.missing`, group: '依赖漏洞', family: 'deps',
      title: `${m.ecosystem} 依赖审计`, status: 'na', hits: 0,
      reason: `${m.reason}（建议：${m.hint}）`,
    });
  }
  if (collected.unscannable.length) {
    rows.push({
      id: 'deps.unpinned', group: '依赖漏洞', family: 'deps',
      title: '未固定版本的依赖', status: 'na', hits: 0,
      reason: `${collected.unscannable.length} 条未固定版本：${collected.unscannable.slice(0, 4).map((u) => u.name).join(', ')}`,
    });
  }
  if (error) {
    rows.push({
      id: 'deps.osv', group: '依赖漏洞', family: 'deps', title: 'OSV 查询',
      status: 'na', hits: 0, reason: `查询失败：${error}`,
    });
  }
  return rows;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = path.resolve(opts.dir);
  const collected = collectDependencies(dir);
  let entries = [];
  let error = null;
  try {
    if (opts.osvFixture) {
      const saved = JSON.parse(fs.readFileSync(path.resolve(opts.osvFixture), 'utf8'));
      entries = saved.entries || [];
    } else if (collected.deps.length) {
      entries = await queryOsv(collected.deps);
    }
  } catch (e) {
    error = e.message;
  }
  const findings = osvFindings(entries);
  const rows = buildDepChecklist({ collected, entries, error });
  const summary = {
    dependencies: collected.deps.length,
    ecosystems: collected.ecosystems,
    advisories: entries.length,
    affected_packages: new Set(entries.map((e) => `${e.dep.name}@${e.dep.version}`)).size,
    worst: entries.map((e) => osvSeverity(e.vuln).level).sort().pop() || null,
  };
  if (opts.json) console.log(JSON.stringify({ dir, summary, rows, findings }, null, 2));
  else {
    console.log(`\n🔐 依赖漏洞审计 — ${dir}`);
    console.log(`   ${summary.dependencies} 个已固定依赖（${Object.entries(summary.ecosystems).map(([k, v]) => `${k} ${v}`).join(' / ') || '无'}）`);
    if (error) console.log(`   ⚠️  OSV 查询失败：${error}`);
    console.log(`   公告 ${summary.advisories} 条，涉及 ${summary.affected_packages} 个包${summary.worst ? `，最高等级 ${summary.worst}` : ''}`);
    for (const f of findings.slice(0, 20)) console.log(`   ${f.severity === 'warn' ? '⚠️' : 'ℹ️'} ${f.message.slice(0, 120)}`);
    for (const r of rows.filter((x) => x.status !== 'pass')) console.log(`   ${r.status === 'hit' ? '⚠️ ' : '➖'} ${r.id}: ${r.reason}`);
  }
  if (opts.markdown) {
    const md = [
      `## 🔐 依赖漏洞审计`, '',
      `${summary.dependencies} 个已固定依赖 · 公告 **${summary.advisories}** 条 · 涉及 ${summary.affected_packages} 个包${summary.worst ? ` · 最高 ${summary.worst}` : ''}`, '',
      ...findings.map((f) => `- ${f.severity === 'warn' ? '⚠️' : 'ℹ️'} ${f.message}`),
    ].join('\n');
    if (opts.markdown === '-') console.log(md);
    else { fs.writeFileSync(path.resolve(opts.markdown), md); console.error(`Markdown written to ${path.resolve(opts.markdown)}`); }
  }
  if (opts.failOn) {
    const order = { UNKNOWN: 3, LOW: 0, MODERATE: 1, HIGH: 2, CRITICAL: 3 };
    const worst = Math.max(0, ...entries.map((e) => order[osvSeverity(e.vuln).level] ?? 0));
    if (worst >= (order[opts.failOn] ?? 9)) {
      console.error(`worst advisory ${summary.worst} >= --fail-on ${opts.failOn} → gate failed`);
      process.exit(1);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
