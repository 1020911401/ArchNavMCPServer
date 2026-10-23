/**
 * Unit tests for `applyWaivers` / `loadWaivers` in scripts/review-rules.mjs.
 *
 * 豁免是审核链路里最容易变成「无痕静音器」的东西，所以这里钉的是它的三条规矩：
 *   1. 没有 reason 的豁免**不生效**（finding 还在）
 *   2. 匹配不到的豁免不静默丢弃 → 报 stale（规则改了/位置漂了就重审）
 *   3. 摘掉的 finding 必须出现在 waived[] 里（带理由），不是凭空消失
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyWaivers, loadWaivers } from '../scripts/review-rules.mjs';

const f = (rule, file, line, severity = 'warn') => ({
  rule, file, line, severity, message: `${rule} @ ${file}:${line}`, why: 'why', evidence: 'ev',
});

const base = [
  f('js-unused-binding', 'src/a.js', 76),
  f('js-unused-binding', 'src/a.js', 91),
  f('empty-catch', 'src/a.js', 44),
  f('js-unused-binding', 'src/b.js', 12),
];

test('有理由的豁免：摘掉该行，进入 waived[] 且带理由/确认人/卡号', () => {
  const r = applyWaivers(base, [
    { rule: 'js-unused-binding', file: 'src/a.js', line: 76, reason: '测试文件里的字符串字面量，假阳性', by: 'z', task: 't_1' },
  ]);
  assert.equal(r.kept.length, 3);
  assert.equal(r.waived.length, 1);
  assert.equal(r.waived[0].line, 76);
  assert.equal(r.waived[0].waiver.reason, '测试文件里的字符串字面量，假阳性');
  assert.equal(r.waived[0].waiver.by, 'z');
  assert.equal(r.waived[0].waiver.task, 't_1');
});

test('没理由的豁免不生效：finding 必须留着（豁免不能当静音器）', () => {
  const r = applyWaivers(base, [{ rule: 'js-unused-binding', file: 'src/a.js', line: 76, reason: '   ' }]);
  assert.equal(r.waived.length, 0);
  assert.equal(r.kept.length, 4);
  assert.equal(r.invalid.length, 1);
});

test('line 缺省 = 该规则该文件全豁免；精确 line 只摘那一行', () => {
  const all = applyWaivers(base, [{ rule: 'js-unused-binding', file: 'src/a.js', reason: '整文件豁免' }]);
  assert.equal(all.waived.length, 2, 'a.js 的两处都该摘掉');
  assert.equal(all.kept.length, 2);

  const one = applyWaivers(base, [{ rule: 'js-unused-binding', file: 'src/a.js', line: 91, reason: '只这一行' }]);
  assert.equal(one.waived.length, 1);
  assert.equal(one.waived[0].line, 91);
});

test('只命中规则+文件+行，不误伤同规则的其他文件', () => {
  const r = applyWaivers(base, [{ rule: 'js-unused-binding', file: 'src/a.js', reason: 'x' }]);
  assert.deepEqual(r.kept.map((x) => `${x.rule}@${x.file}:${x.line}`), ['empty-catch@src/a.js:44', 'js-unused-binding@src/b.js:12']);
});

test('路径分隔符/前缀归一化：Windows 反斜杠与 ./ 前缀都认', () => {
  const r = applyWaivers(base, [{ rule: 'empty-catch', file: '.\\src\\a.js', reason: '归一化' }]);
  assert.equal(r.waived.length, 1);
  assert.equal(r.waived[0].rule, 'empty-catch');
});

test('匹配不到的豁免报 stale（规则改了/位置漂了 → 该重审）', () => {
  const r = applyWaivers(base, [
    { rule: 'js-unused-binding', file: 'src/a.js', line: 999, reason: '这行已经没了' },
  ]);
  assert.equal(r.waived.length, 0);
  assert.equal(r.kept.length, 4);
  assert.equal(r.stale.length, 1);
});

test('loadWaivers 接受 {waivers:[…]} 与裸数组；形状不对就报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'waivers-'));
  try {
    const obj = join(dir, 'obj.json');
    writeFileSync(obj, JSON.stringify({ waivers: [{ rule: 'r', file: 'a.js', reason: 'why' }] }), 'utf8');
    assert.equal(loadWaivers(obj).list.length, 1);

    const arr = join(dir, 'arr.json');
    writeFileSync(arr, JSON.stringify([{ rule: 'r', file: 'a.js', reason: 'why' }]), 'utf8');
    assert.equal(loadWaivers(arr).list.length, 1);

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ nope: true }), 'utf8');
    assert.throws(() => loadWaivers(bad), /形状不对/);

    assert.throws(() => loadWaivers(join(dir, 'missing.json')), /ENOENT|no such file/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
