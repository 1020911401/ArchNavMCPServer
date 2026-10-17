/**
 * Taint (file-local source→sink) + dependency audit (OSV) — unit tests.
 * The audit parsers and the OSV mapping are pure, so they are pinned here; the
 * network call itself is exercised by the E2E run, not by these tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { taintFindings, reviewFindings, RULE_REGISTRY, MODE_PRESETS, applyMode, semgrepCandidates, parseSemgrepJson, firstLine, resolveSemgrep, pythonScriptsDirs } from '../scripts/review-rules.mjs';
import {
  parseNpmLock, parseComposerLock, parseGoMod, parseRequirements,
  osvSeverity, osvFindings, buildDepChecklist, queryOsv,
} from '../scripts/audit-deps.mjs';

test('taint: request input reaching echo / exec / SQL is caught, escaping silences it', () => {
  const php = taintFindings('app/Http/Controllers/A.php', [
    '<?php',
    '$q = $request->input("q");',
    'echo $q;',
  ].join('\n'));
  assert.equal(php.length, 1);
  assert.equal(php[0].rule, 'taint-source-to-sink');
  assert.equal(php[0].severity, 'warn', 'output sink');
  assert.equal(php[0].line, 3);
  assert.match(php[0].evidence, /source=\$q@2 → sink=output@3/);

  // the same value into exec is an error
  const exec = taintFindings('app/A.php', '<?php\n$c = $request->get("cmd");\neval($c);');
  assert.equal(exec[0].severity, 'error');

  // escaping on the way to the sink clears it
  assert.deepEqual(taintFindings('app/A.php', '<?php\n$q = $request->input("q");\necho htmlspecialchars($q);'), []);
  // no source in the file → nothing to say
  assert.deepEqual(taintFindings('app/A.php', '<?php\n$q = "safe";\necho $q;'), []);

  // JS: request → innerHTML
  const js = taintFindings('pages/a/index.vue', '<script>\nconst name = req.query.name;\nel.innerHTML = name;\n</script>');
  assert.equal(js.length, 1);
  assert.match(js[0].evidence, /sink=output/);
  assert.deepEqual(taintFindings('pages/a/index.vue', '<script>\nconst name = req.query.name;\nel.innerHTML = encodeURIComponent(name);\n</script>'), []);

  // Python: request → cursor.execute
  const py = taintFindings('app/views.py', 'q = request.args.get("q")\ncur.execute("select " + q)');
  assert.equal(py.length, 1);
  assert.equal(py[0].severity, 'warn', 'sql sink');

  // only code files are scanned, and the rule is registered
  assert.deepEqual(taintFindings('docs/x.md', '$q = $request->input("q");\necho $q;'), []);
  assert.ok(RULE_REGISTRY.some((r) => r.id === 'taint-source-to-sink'));
  // wired into reviewFindings (changed file with the pattern produces the finding)
  const idx = { symbols: [{ id: 'x', name: 'x', kind: 'function', file: 'app/A.php', line_start: 1, line_end: 3 }], layerMap: {}, knowledgeGraph: { nodes: [], edges: [] } };
  const res = reviewFindings({
    changes: { scope: 'unstaged', via: 'git', changed_files: [{ file: 'app/A.php' }], changed_symbols: [], impacted: [], unmapped_files: [] },
    index: idx, tier: 'core', readFile: () => '<?php\n$q = $request->input("q");\necho $q;',
  });
  assert.ok(res.some((f) => f.rule === 'taint-source-to-sink'), 'taint runs inside the review pass');
});

test('audit: lockfile parsers cover the four ecosystems', () => {
  const npmV3 = parseNpmLock(JSON.stringify({ packages: { '': { name: 'demo' }, 'node_modules/lodash': { version: '4.17.4' }, 'node_modules/@scope/pkg': { version: '1.0.0', dev: true }, 'node_modules/a/node_modules/b': { version: '2.0.0' } } }));
  assert.deepEqual(npmV3.map((d) => `${d.name}@${d.version}${d.dev ? '(dev)' : ''}`).sort(), ['@scope/pkg@1.0.0(dev)', 'b@2.0.0', 'lodash@4.17.4']);
  const npmV1 = parseNpmLock(JSON.stringify({ dependencies: { minimist: { version: '0.0.8' } } }));
  assert.deepEqual(npmV1, [{ name: 'minimist', version: '0.0.8', ecosystem: 'npm', dev: false }]);
  assert.deepEqual(parseNpmLock('not json'), []);

  const composer = parseComposerLock(JSON.stringify({ packages: [{ name: 'laravel/framework', version: 'v8.0.0' }], 'packages-dev': [{ name: 'phpunit/phpunit', version: '9.5.0' }] }));
  assert.deepEqual(composer.map((d) => `${d.ecosystem}:${d.name}@${d.version}`), ['Packagist:laravel/framework@8.0.0', 'Packagist:phpunit/phpunit@9.5.0']);

  const gomod = parseGoMod(`module demo\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n\tgolang.org/x/text v0.3.7 // indirect\n)\n\nrequire github.com/spf13/cobra v1.7.0\n`);
  assert.deepEqual(gomod.map((d) => `${d.name}@${d.version}${d.dev ? '(indirect)' : ''}`), ['github.com/gin-gonic/gin@1.9.0', 'golang.org/x/text@0.3.7(indirect)', 'github.com/spf13/cobra@1.7.0']);

  const req = parseRequirements('# c\nrequests==2.31.0\nflask>=2.0\n-r other.txt\nurllib3==2.0.7\n');
  assert.deepEqual(req.pinned.map((d) => `${d.name}@${d.version}`), ['requests@2.31.0', 'urllib3@2.0.7']);
  assert.deepEqual(req.unscannable.map((u) => u.name), ['flask'], 'a range cannot be audited by version');
});

test('audit: OSV severity mapping and finding shape', () => {
  assert.equal(osvSeverity({ database_specific: { severity: 'MODERATE' } }).level, 'MODERATE');
  const vectorOnly = osvSeverity({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] });
  assert.equal(vectorOnly.score, null, 'a vector is not a score - do not invent one');
  assert.equal(vectorOnly.level, 'UNKNOWN');
  assert.match(vectorOnly.cvss, /CVSS:3\.1/);
  const numeric = osvSeverity({ severity: [{ type: 'CVSS_V3', score: '9.8' }] });
  assert.equal(numeric.score, 9.8);
  assert.equal(numeric.level, 'CRITICAL');
  assert.equal(osvSeverity({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/...' }], database_specific: { severity: 'CRITICAL' } }).level, 'CRITICAL', 'database severity wins');
  assert.equal(osvSeverity({}).level, 'UNKNOWN');

  const entries = [{ dep: { ecosystem: 'npm', name: 'lodash', version: '4.17.4' }, vuln: { id: 'GHSA-x', summary: 'Prototype Pollution in lodash', database_specific: { severity: 'HIGH' }, affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }] } }];
  const f = osvFindings(entries);
  assert.equal(f[0].rule, 'dep-vulnerability');
  assert.equal(f[0].severity, 'warn', 'pre-existing dependency risk is context, not a build blocker');
  assert.match(f[0].evidence, /fixed in 4\.17\.21/);
  assert.equal(osvFindings(entries, { mapSeverity: () => 'error' })[0].severity, 'error', 'the gate decides the severity');
});

test('audit: checklist rows explain what could not be scanned', () => {
  const rows = buildDepChecklist({
    collected: {
      ecosystems: { npm: 12 },
      missing: [{ ecosystem: 'Packagist', reason: '有 composer.json 但没有 composer.lock：版本不确定', hint: 'composer update --lock' }],
      unscannable: [{ name: 'flask', spec: '>=2.0' }],
    },
    entries: [{ dep: { ecosystem: 'npm', name: 'lodash', version: '4.17.4' }, vuln: { id: 'GHSA-x' } }],
    error: null,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get('deps.npm').status, 'hit');
  assert.equal(byId.get('deps.npm').hits, 1);
  assert.equal(byId.get('deps.packagist.missing').status, 'na');
  assert.match(byId.get('deps.packagist.missing').reason, /composer\.lock/);
  assert.match(byId.get('deps.unpinned').reason, /flask/);
  const withError = buildDepChecklist({ collected: { ecosystems: {}, missing: [], unscannable: [] }, entries: [], error: 'OSV timeout' });
  assert.match(withError[0].reason, /OSV timeout/);
});

test('audit: the deep preset audits, --no-audit / --audit override it both ways', () => {
  assert.equal(MODE_PRESETS.deep.audit, true, 'repo-level mode is the one that runs periodically');
  assert.ok(!MODE_PRESETS.brief.audit && !MODE_PRESETS.standard.audit, 'per-commit modes never hit the network');
  // parseArgs leaves the flag null when neither --audit nor --no-audit was given
  assert.equal(applyMode({ mode: 'deep', auditFlag: null, dupKinds: [] }).audit, true);
  assert.equal(applyMode({ mode: 'deep', auditFlag: false, dupKinds: [] }).audit, false, 'CI runs deep without touching OSV');
  assert.equal(applyMode({ mode: 'brief', auditFlag: true, dupKinds: [] }).audit, true, '--audit works on its own');
  assert.equal(applyMode({ mode: 'standard', auditFlag: null, dupKinds: [] }).audit, false);
});

test('OSV details: one fetch per unique advisory id, through a bounded pool', async () => {
  const calls = [];
  let live = 0, peak = 0;
  const fetchImpl = async (url) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--; calls.push(url);
    if (url.endsWith('/querybatch')) {
      // dep a → two advisories, dep b → shares one of them, dep c → none
      return { ok: true, json: async () => ({ results: [{ vulns: [{ id: 'GHSA-x' }, { id: 'GHSA-y' }] }, { vulns: [{ id: 'GHSA-x' }] }, { vulns: [] }] }) };
    }
    return { ok: true, json: async () => ({ id: url.split('/').pop() }) };
  };
  const deps = ['a', 'b', 'c'].map((name) => ({ ecosystem: 'npm', name, version: '1.0.0' }));
  const entries = await queryOsv(deps, { fetchImpl, concurrency: 2 });
  const details = calls.filter((u) => u.includes('/v1/vulns/')).sort();
  assert.deepEqual(details, ['https://api.osv.dev/v1/vulns/GHSA-x', 'https://api.osv.dev/v1/vulns/GHSA-y'], 'the shared advisory is fetched once, not once per package');
  assert.deepEqual(entries.map((e) => `${e.dep.name}:${e.vuln.id}`).sort(), ['a:GHSA-x', 'a:GHSA-y', 'b:GHSA-x'], 'every (package, advisory) pair is reported');
  assert.ok(peak <= 3, `in-flight requests stay bounded (peak ${peak})`);
});

test('OSV details: a failed detail response drops that entry, never invents one', async () => {
  let live = 0, peak = 0;
  const ids = Array.from({ length: 30 }, (_, i) => `TH-${i}`);
  const fetchImpl = async (url) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    if (url.endsWith('/querybatch')) return { ok: true, json: async () => ({ results: [{ vulns: ids.map((id) => ({ id })) }] }) };
    return { ok: false, status: 500 };
  };
  const entries = await queryOsv([{ ecosystem: 'npm', name: 'a', version: '1.0.0' }], { fetchImpl, concurrency: 4 });
  assert.deepEqual(entries, [], 'no detail → no finding');
  assert.ok(peak <= 5, `30 advisories do not open 30 sockets at once (peak ${peak})`);
});

test('semgrep: resolution order, and its stdout is read past the leading warning', () => {
  const exe = process.platform === 'win32' ? '.exe' : '';
  assert.deepEqual(semgrepCandidates({}).map((c) => c.bin), ['semgrep', 'python']);
  assert.deepEqual(semgrepCandidates({}).at(-1), { bin: 'python', prefix: ['-m', 'semgrep'] });
  assert.equal(semgrepCandidates({ SEMGREP_BIN: '/opt/semgrep' })[0].bin, '/opt/semgrep', 'an explicit binary wins');
  assert.deepEqual(semgrepCandidates({ PYTHON: 'py3' }).at(-1), { bin: 'py3', prefix: ['-m', 'semgrep'] }, 'PYTHON picks the interpreter');
  const sd = '/home/u/.local/bin';
  const withScripts = semgrepCandidates({}, { scriptsDirs: [sd] });
  assert.deepEqual(withScripts.map((c) => c.bin), ['semgrep', path.join(sd, `semgrep${exe}`), path.join(sd, `pysemgrep${exe}`), 'python']);
  assert.equal(withScripts[1].pathPrefix, sd, 'the semgrep launcher needs its own dir on PATH to find pysemgrep');
  // measured: the fallback prints a deprecation notice before the JSON
  assert.deepEqual(parseSemgrepJson('Using python -m semgrep is deprecated\n{"results":[]}'), { results: [] });
  assert.equal(parseSemgrepJson('not json at all'), null);
  assert.equal(parseSemgrepJson(''), null);
  assert.equal(firstLine('\n   node: bad option: --json  \nmore text'), 'node: bad option: --json');
  assert.equal(firstLine(null), '');
});

test('semgrep: an off-PATH install is found before falling back to `python -m`', () => {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const interp = 'C:\\py\\Scripts';
  const userBase = 'C:\\Users\\x\\AppData\\Roaming\\Python\\Python314\\Scripts';
  const tried = [];
  const spawnImpl = (bin, args) => {
    tried.push(`${bin} ${args.join(' ')}`.trim());
    if (bin === 'python' && args[0] === '-c') return { status: 0, stdout: `${interp}\r\n${userBase}\r\n` };
    if (bin === 'semgrep') return { error: { code: 'ENOENT' } };
    if (bin.startsWith(interp)) return { error: { code: 'ENOENT' } };   // the interpreter's own dir has no semgrep (measured)
    return { status: 0, stdout: '{"results":[{"check_id":"x"}]}' };
  };
  const r = resolveSemgrep({ env: { PATH: '/usr/bin' }, args: ['--json'], spawnImpl });
  assert.equal(r.bin, path.join(userBase, `semgrep${exe}`), 'the user-base script python reports wins over the deprecated module route');
  assert.equal(tried[0], 'semgrep --json', 'PATH is tried before python is asked anything');
  assert.match(tried[1], /^python -c import sys,sysconfig/, 'python is asked only after the PATH lookup misses');
  assert.ok(!tried.some((t) => t.endsWith('-m semgrep')), 'the deprecated `python -m semgrep` route is never reached when a script exists');
  assert.match(r.result.stdout, /results/);

  // helpers behind it
  assert.deepEqual(pythonScriptsDirs({}, () => ({ status: 0, stdout: 'C:\\a\\Scripts\n  C:\\b\\Scripts  \nC:\\a\\Scripts\n' })), ['C:\\a\\Scripts', 'C:\\b\\Scripts'], 'both dirs, deduplicated');
  assert.deepEqual(pythonScriptsDirs({}, () => ({ status: 1, stdout: '/nope' })), []);
  assert.deepEqual(pythonScriptsDirs({}, () => ({ error: { code: 'ENOENT' } })), []);

  // nothing works anywhere: the last "not found" comes back so the caller can say why
  const none = resolveSemgrep({ env: { PATH: '/usr/bin' }, spawnImpl: (bin, args) => (bin === 'python' && args[0] === '-c' ? { status: 1, stdout: '' } : { error: { code: 'ENOENT' } }) });
  assert.equal(none.result.error.code, 'ENOENT');
});
