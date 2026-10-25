/**
 * gradeRisk — the four-tier verdict ArchNav gives its own impact results.
 *
 * The tiers exist so "how scared should I be" is answered by one call, with the
 * reasons printed. Thresholds are calibrated, not copied: GitNexus' *scale* is
 * kept (depth-1 callers, cross-module escalation, UNKNOWN ≠ safe) but its *values*
 * are not, because on crmeb-laravel it reports LOW for a symbol with 254 callers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gradeRisk } from '../src/navigation.js';

/** n distinct files under one or more app roots. */
const rows = (n, apps = ['app']) => Array.from({ length: n }, (_, i) => ({
  symbol: `caller${i}`,
  file: `${apps[i % apps.length]}/src/file${i}.js`,
  line: i + 1,
  confidence: 0.85,
}));

const level = (o) => gradeRisk(o).level;

test('gradeRisk: tier boundaries sit at 3/4, 9/10, 24/25 files', () => {
  assert.equal(level({ direct: rows(0) }), 'LOW');
  assert.equal(level({ direct: rows(1) }), 'LOW');
  assert.equal(level({ direct: rows(3) }), 'LOW');
  assert.equal(level({ direct: rows(4) }), 'MEDIUM');
  assert.equal(level({ direct: rows(9) }), 'MEDIUM');
  assert.equal(level({ direct: rows(10) }), 'HIGH');
  assert.equal(level({ direct: rows(24) }), 'HIGH');
  assert.equal(level({ direct: rows(25) }), 'CRITICAL');
});

test('gradeRisk: the tier counts FILES, not symbols', () => {
  // 20 call sites in one file is one review decision, not twenty.
  const sameFile = Array.from({ length: 20 }, (_, i) => ({ symbol: `c${i}`, file: 'app/src/one.js', confidence: 0.9 }));
  assert.equal(level({ direct: sameFile }), 'LOW');
  const r = gradeRisk({ direct: sameFile });
  assert.equal(r.symbols, 20);
  assert.equal(r.files, 1);
});

test('gradeRisk: spread across apps escalates, 4+ apps by two tiers', () => {
  // 2 files in 2 apps = MEDIUM base, +1 for the second app
  assert.equal(level({ direct: rows(4, ['admin', 'backend']) }), 'HIGH');
  // 4 distinct apps = +2
  assert.equal(level({ direct: rows(8, ['admin', 'admin-merchant', 'admin-store', 'backend']) }), 'CRITICAL');
  // the bump is visible in the reasons, not just the level
  const r = gradeRisk({ direct: rows(4, ['admin', 'backend']) });
  assert.ok(r.reasons.some((x) => x.includes('跨 2 个应用')), r.reasons.join(' | '));
});

test('gradeRisk: 10+ indirect relations add a tier; the cap holds at CRITICAL', () => {
  assert.equal(level({ direct: rows(4), indirect: rows(10) }), 'HIGH');
  assert.equal(level({ direct: rows(4), indirect: rows(9) }), 'MEDIUM');
  assert.equal(level({ direct: rows(25), indirect: rows(50) }), 'CRITICAL');
});

test('gradeRisk: callers that are all tests downgrade one tier, never below LOW', () => {
  const tests = Array.from({ length: 12 }, (_, i) => ({ symbol: `t${i}`, file: `backend/tests/Feature/T${i}Test.php`, confidence: 0.9 }));
  assert.equal(level({ direct: tests }), 'MEDIUM', 'HIGH → MEDIUM');
  const few = Array.from({ length: 3 }, (_, i) => ({ symbol: `t${i}`, file: `tests/unit/t${i}.test.js`, confidence: 0.9 }));
  assert.equal(level({ direct: few }), 'LOW');
});

test('gradeRisk: no callers is LOW by default, UNKNOWN when the name is ambiguous', () => {
  const plain = gradeRisk({ direct: [] });
  assert.equal(plain.level, 'LOW');
  assert.match(plain.note, /grep 复核/, 'an empty set must not read as proof of safety');

  const amb = gradeRisk({ direct: [], ambiguous: true });
  assert.equal(amb.level, 'UNKNOWN');
  assert.match(amb.note, /无法判定/);
});

test('gradeRisk: an ambiguous name keeps its real tier and says the number is aggregated', () => {
  const r = gradeRisk({ direct: rows(10), ambiguous: true });
  assert.equal(r.level, 'HIGH');
  assert.match(r.note, /多个定义/);
  assert.ok(r.reasons.length >= 1);
});

test('gradeRisk: low edge confidence is disclosed, not used to hide fan-in', () => {
  const weak = rows(10).map((r) => ({ ...r, confidence: 0.4 }));
  const r = gradeRisk({ direct: weak });
  assert.equal(r.level, 'HIGH', 'confidence must not silently downgrade real fan-in');
  assert.match(r.note, /置信度偏低/);
});

test('gradeRisk: empty/undefined input never throws', () => {
  assert.equal(gradeRisk().level, 'LOW');
  assert.equal(gradeRisk({ direct: null, indirect: null }).level, 'LOW');
  assert.equal(gradeRisk({ direct: [null, undefined, {}] }).files, 0);
});
