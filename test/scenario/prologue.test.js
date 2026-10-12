// 序章（围城 D1→D9 闪回）：管线、守卫、因果入账、回忆录序章段
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, PACK } from '../helpers.js';
import { fold } from '../../packages/core/index.js';

describe('序章管线', () => {
  test('五拍逐拍推进，拍完落到第 1 天白天', () => {
    const { state } = newRun({ prologue: true });
    let s = state;
    assert.equal(s.phase, 'prologue');
    assert.equal(s.activeEvent?.cardId, 'p1_water', '首拍是停水那天');
    for (const opt of ['tried', 'ours', 'share', 'open', 'begin']) {
      assert.equal(s.phase, 'prologue', `拍间仍是序章（${opt}）`);
      s = step(s, [{ type: 'event_choice', option: opt }]).state;
    }
    assert.equal(s.phase, 'day', '序章读完，落到第 1 天白天');
    assert.equal(s.day, 1);
  });

  test('序章里只有选项合法：白天行动被守卫挡住', () => {
    const { state } = newRun({ prologue: true });
    const r = step(state, [{ type: 'act', actor: 'anton', action: 'eat', target: 'raw' }]);
    assert.ok(r.rejects.some((x) => x.reason === 'IN_PROLOGUE'));
  });

  test('序章的选择进因果账（序章标签 + 动词正确）', () => {
    const { state } = newRun({ prologue: true });
    let s = state;
    for (const opt of ['tried', 'ours', 'share', 'open', 'begin']) {
      s = step(s, [{ type: 'event_choice', option: opt }]).state;
    }
    const pro = s.causality.entries.filter((e) => e.tags?.includes('prologue'));
    assert.ok(pro.length >= 2, '序章至少两笔因果账（分食 + 开门）');
    assert.ok(pro.some((e) => e.verb === 'help' && e.target === 'neighbor'), '分给老人入账');
    assert.ok(pro.some((e) => e.verb === 'help' && e.target === 'stranger'), '开门入账');
  });

  test('回忆录有序章段（围城那些天）', () => {
    const { state } = newRun({ prologue: true });
    let s = state;
    for (const opt of ['tried', 'ours', 'share', 'open', 'begin']) {
      s = step(s, [{ type: 'event_choice', option: opt }]).state;
    }
    // 直接打到全灭看复盘
    for (const c of s.chars) { c.wound = 3; c.hunger = 0; }
    for (let i = 0; i < 12 && !s.over; i++) {
      if (s.activeEvent) s = step(s, [{ type: 'event_choice', option: PACK.cardMap[s.activeEvent.cardId]?.options?.[0]?.key }]).state;
      s = step(s, [{ type: 'advance' }]).state;
      if (s.phase === 'dusk') s = step(s, [{ type: 'dusk_assign', scavenger: null, others: {} }]).state;
    }
    assert.ok(s.over);
    const story = s.ending.storyline;
    assert.ok(story.prologue.length >= 2, '序章拍在复盘里');
  });

  test('fold 镜像：序章对局可重放', () => {
    const { state, events } = newRun({ prologue: true });
    let s = state;
    const all = [...events];
    for (const opt of ['tried', 'ours', 'share', 'open', 'begin']) {
      const r = step(s, [{ type: 'event_choice', option: opt }]);
      all.push(...r.events);
      s = r.state;
    }
    const rebuilt = fold(all);
    assert.equal(rebuilt.phase, 'day');
    assert.equal(rebuilt.causality.entries.length, s.causality.entries.length);
  });

  test('不带序章的开局仍是老样子（回归保护）', () => {
    const { state } = newRun({ prologue: false });
    assert.equal(state.phase, 'day');
    assert.ok(!state.activeEvent);
  });
});
