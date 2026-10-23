/**
 * Unit tests for scripts/kanban-review.mjs — 审核任务书 → Hermes Kanban 逐项确认。
 *
 * 这里只钉纯逻辑（分组 / 指纹 / 卡片正文 / 输入守约）；真正写看板、逐项确认、
 * 门禁退出码的端到端链路靠 `push` + `status --gate` 实测（见 docs/kanban-review.md）。
 * 刻意不碰 kanban：cmdPush 的 dry-run 在落到看板之前就 return。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseArgs, fingerprint, groupFindings, itemBody, SEV_PRIORITY, skipWaivedGroups, cmdPush,
} from '../scripts/kanban-review.mjs';

const finding = (rule, severity, file, line = 1, extra = {}) => ({
  rule, severity, file, line,
  message: `${file}:${line} 命中 ${rule}`,
  why: '为什么这条要人看', evidence: 'evidence-string', ...extra,
});

const review = {
  scope: 'unstaged', via: 'git',
  checklist: { summary: { total: 3, hit: 2, pass: 1, na: 0, findings: 4 }, rows: [{ id: 'x', status: 'hit', hits: 4 }] },
  findings: [
    finding('empty-catch', 'warn', 'src/a.js', 10),
    finding('empty-catch', 'warn', 'src/a.js', 20),
    finding('empty-catch', 'info', 'src/b.js', 5),
    finding('js-unused-binding', 'info', 'src/a.js', 7),
  ],
};

test('parseArgs 处理开关与带值选项', () => {
  const o = parseArgs(['push', 'review.json', '--board', 'b1', '--dry-run', '--gate']);
  assert.deepEqual(o._, ['push', 'review.json']);
  assert.equal(o.board, 'b1');
  assert.equal(o.dryrun, true);
  assert.equal(o.gate, true);
});

test('指纹只认审核内容：同内容稳定，改动/换 label 就变', () => {
  const a = fingerprint(review, 'run-1');
  assert.equal(a, fingerprint(structuredClone(review), 'run-1'), '同内容必须同指纹（重复 push 才能幂等）');
  assert.notEqual(a, fingerprint(review, 'run-2'));
  const bumped = structuredClone(review);
  bumped.findings[0].line = 11;
  assert.notEqual(a, fingerprint(bumped, 'run-1'), '行号变了就是另一批确认项');
  const dropped = structuredClone(review);
  dropped.findings.pop();
  assert.notEqual(a, fingerprint(dropped, 'run-1'));
});

test('groupFindings: rule-file 默认按「规则×文件」成组，严重度取组内最高', () => {
  const groups = groupFindings(review.findings, 'rule-file', 'info');
  assert.equal(groups.length, 3, 'empty-catch×a.js / empty-catch×b.js / js-unused-binding×a.js');
  const aEmpty = groups.find((g) => g.rule === 'empty-catch' && g.file === 'src/a.js');
  assert.equal(aEmpty.findings.length, 2);
  assert.equal(aEmpty.severity, 'warn');
  assert.equal(groups[0].severity, 'warn', 'warn 组排前面');
});

test('groupFindings: rule 与 finding 两种粒度', () => {
  assert.equal(groupFindings(review.findings, 'rule', 'info').length, 2);
  assert.equal(groupFindings(review.findings, 'finding', 'info').length, 4);
});

test('groupFindings: min-severity 过滤（遗留仓里 info 会淹没真正要看的）', () => {
  const only = groupFindings(review.findings, 'rule-file', 'warn');
  assert.equal(only.length, 1);
  assert.equal(only[0].rule, 'empty-catch');
  assert.equal(groupFindings(review.findings, 'rule-file', 'error').length, 0);
});

test('严重度 → 看板优先级（门禁按 priority>=2 卡住）', () => {
  assert.deepEqual(SEV_PRIORITY, { error: 3, warn: 2, info: 0 });
  const groups = groupFindings(review.findings, 'rule-file', 'info');
  assert.equal(SEV_PRIORITY[groups[0].severity], 2);
});

test('卡片正文带 file:line + why + evidence，且四个确认动词齐全', () => {
  const [g] = groupFindings(review.findings, 'rule-file', 'info');
  const body = itemBody(g, 'fp1234', 'archnav-review');
  assert.match(body, /`src\/a\.js:10`/);
  assert.match(body, /为什么: 为什么这条要人看/);
  assert.match(body, /证据: `evidence-string`/);
  assert.match(body, /complete <id>/);
  assert.match(body, /block <id>/);
  assert.match(body, /request-review <id>/);
  assert.match(body, /archive <id>/);
  assert.match(body, /fp1234/);
});

test('push --waivers：已豁免的组不建卡；组里还剩没看过的命中就保留', () => {
  const groups = groupFindings(review.findings, 'rule-file', 'info');

  // 整组豁免（rule+file 全豁免，line 省略）→ 该组不再建卡
  const all = skipWaivedGroups(groups, [{ rule: 'empty-catch', file: 'src/a.js', reason: '整文件看过了' }]);
  assert.equal(all.length, 2);
  assert.equal(all.some((g) => g.rule === 'empty-catch' && g.file === 'src/a.js'), false);

  // 只豁免其中一行 → 该组还有 src/a.js:20 没确认，卡必须留着
  const one = skipWaivedGroups(groups, [{ rule: 'empty-catch', file: 'src/a.js', line: 10, reason: '只这一行' }]);
  assert.equal(one.length, 3);
  assert.equal(one.filter((g) => g.rule === 'empty-catch').length, 2);

  // 没理由的豁免不生效（同 review-rules）→ 全部保留
  assert.equal(skipWaivedGroups(groups, [{ rule: 'empty-catch', file: 'src/a.js', reason: '' }]).length, 3);
  assert.equal(skipWaivedGroups(groups, []).length, 3);
});

test('push 只收完整任务书：压缩输出必须被挡回并指路 --no-compact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-review-'));
  try {
    const compact = join(dir, 'compact.json');
    writeFileSync(compact, JSON.stringify({ mode: 'brief', summary: {}, findings: [] }), 'utf8');
    assert.throws(() => cmdPush({ _: ['push', compact], dryrun: true }), /--no-compact/);

    const noWhy = join(dir, 'no-why.json');
    writeFileSync(noWhy, JSON.stringify({
      scope: 'all', checklist: { summary: {}, rows: [] },
      findings: [{ rule: 'r', severity: 'warn', file: 'a.js', line: 1 }],
    }), 'utf8');
    assert.throws(() => cmdPush({ _: ['push', noWhy], dryrun: true }), /why\/evidence/);

    const ok = join(dir, 'full.json');
    writeFileSync(ok, JSON.stringify(review), 'utf8');
    assert.equal(cmdPush({ _: ['push', ok], dryrun: true, board: 'b', cwd: 'C:/repo' }), 0, 'dry-run 不写看板，返回 0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
