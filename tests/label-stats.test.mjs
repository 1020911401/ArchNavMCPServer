/**
 * tests/label-stats.test.mjs — 从看板标注算规则精确率的口径。
 *
 * 钉住三件事：
 *   1. 未确认（open）绝不进分母——精确率只能来自人真的点过 ✅/⛔；
 *   2. 非 archnav 卡与收口卡不参与统计（否则分母被任务书自身污染）；
 *   3. `--suggest-waivers` 的输出必须能被 review-rules 的 loadWaivers 直接吃。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, parseCard, parseCards, aggregate, suggest, suggestedWaivers, renderMarkdown, parseArgs } from '../scripts/label-stats.mjs';
import { loadWaivers } from '../scripts/review-rules.mjs';

const card = (over = {}) => ({ id: 't1', title: '[archnav] duplication-clone · src/a.js', priority: 2, status: 'done', tenant: 'fp1', ...over });

test('status → label: only done/blocked/archived are labels', () => {
  assert.equal(classify('done'), 'tp');
  assert.equal(classify('blocked'), 'fp');
  assert.equal(classify('archived'), 'waived');
  for (const s of ['todo', 'ready', 'running', 'review', 'triage', 'missing', undefined]) assert.equal(classify(s), 'open');
});

test('parseCard reads rule/file and skips non-archnav or close cards', () => {
  assert.deepEqual(parseCard(card()), { id: 't1', rule: 'duplication-clone', file: 'src/a.js', priority: 2, status: 'done', label: 'tp', tenant: 'fp1', result: null });
  assert.equal(parseCard(card({ title: '[archnav] empty-catch' })).file, null);
  assert.equal(parseCard(card({ title: '[other] x · y' })), null);
  assert.equal(parseCard(card({ title: '[archnav] 审核任务书收口 fp1' })), null);
  assert.equal(parseCards([card(), { title: 'nope' }]).length, 1);
});

test('precision uses only labelled cards; open cards never inflate it', () => {
  const cards = parseCards([
    card({ id: 'a', status: 'done' }), card({ id: 'b', status: 'done' }),
    card({ id: 'c', status: 'blocked' }),
    card({ id: 'd', status: 'todo' }),            // open
    card({ id: 'e', status: 'archived' }),        // waived, out of the fraction
    card({ id: 'f', status: 'done', title: '[archnav] js-loose-equality · src/b.js' }),
  ]);
  const stats = aggregate(cards);
  const dup = stats.rules.find((r) => r.key === 'duplication-clone');
  assert.equal(dup.tp, 2);
  assert.equal(dup.fp, 1);
  assert.equal(dup.open, 1);
  assert.equal(dup.waived, 1);
  assert.equal(dup.n, 3, 'n = tp + fp');
  assert.equal(dup.precision, 0.667);
  assert.deepEqual(stats.totals, { cards: 6, tp: 3, fp: 1, waived: 1, open: 1 });

  const low = aggregate(cards, { minSamples: 1, low: 0.7 }).rules.find((r) => r.key === 'duplication-clone');
  assert.equal(low.suggestion.verdict, 'demote-or-waive');
  const keep = aggregate(cards, { minSamples: 1, high: 0.6 }).rules.find((r) => r.key === 'duplication-clone');
  assert.equal(keep.suggestion.verdict, 'keep');
});

test('insufficient samples are never judged', () => {
  const stats = aggregate(parseCards([card()]), { minSamples: 5 });
  assert.equal(stats.rules[0].suggestion.verdict, 'insufficient');
  assert.match(stats.rules[0].suggestion.text, /1\/5/);
  assert.equal(suggest({ key: 'x', tp: 0, fp: 0 }, {}).verdict, 'insufficient');
});

test('suggested waivers only cover rule×file pairs that humans actually rejected', () => {
  const cards = parseCards([
    ...Array.from({ length: 4 }, (_, i) => card({ id: `f${i}`, status: 'blocked' })),
    card({ id: 't', status: 'done' }),
    card({ id: 'ok', status: 'done', title: '[archnav] empty-catch · src/c.js' }),
    card({ id: 'rulelevel', status: 'blocked', title: '[archnav] layer-model-missing' }),
  ]);
  const stats = aggregate(cards, { minSamples: 5, low: 0.4 });
  const waivers = suggestedWaivers(stats.pairs, { minSamples: 5, low: 0.4 });
  assert.equal(waivers.length, 1, 'only the 5-sample pair qualifies');
  assert.deepEqual([waivers[0].rule, waivers[0].file, waivers[0].line], ['duplication-clone', 'src/a.js', null]);
  assert.match(waivers[0].reason, /4\/5/);

  // 输出必须能被 review-rules 直接吃：规则同源，不能各写一套
  const parsed = loadWaivers('x.json', { readFile: () => JSON.stringify({ waivers }) });
  assert.equal(parsed.list.length, 1);
  assert.equal(parsed.list[0].rule, 'duplication-clone');
});

test('markdown states the source, the thresholds and refuses to infer from open cards', () => {
  const empty = renderMarkdown(aggregate([]), { board: 'default', minSamples: 5, low: 0.4, high: 0.85 });
  assert.match(empty, /还没有任何 ✅\/⛔ 标注/);
  const md = renderMarkdown(aggregate(parseCards([card({ status: 'blocked' })]), { minSamples: 1, low: 0.4 }), { from: 'cards.json' });
  assert.match(md, /规则 \| TP \| FP/);
  assert.match(md, /候选动作/);
  assert.match(md, /不是配置/);
  assert.match(md, /open` 卡不算准确/);
});

test('parseArgs takes thresholds and never guesses a board', () => {
  const o = parseArgs(['--board', 'archnav', '--min-samples', '8', '--low', '0.3', '--suggest-waivers', 'w.json']);
  assert.equal(o.board, 'archnav');
  assert.equal(o.minSamples, 8);
  assert.equal(o.low, 0.3);
  assert.equal(o.suggestWaivers, 'w.json');
  assert.equal(parseArgs([]).board, 'default');
});
