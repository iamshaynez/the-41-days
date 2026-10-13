// 序章三幕（叙事双轴-v0.1 §2）：节拍引擎、守卫、因果入账、合流变体、单句版与跳过、fold 镜像
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, PACK } from '../helpers.js';
import { fold, preludeBeats, preludeBeatView } from '../../packages/core/index.js';

const PICK = { p1_water: 'tried', p3_shelling: 'share', p4_door: 'open', p2_house: 'ours', p5_dawn9: 'begin', p6_white: 'begin' };

/** 走完序章：文本幕 advance 翻页，卡拍按 PICK 选 */
function playPrelude(s, pick = (c) => PICK[c.id] ?? c.options[0].key) {
  let cur = s, guard = 0;
  while (cur.phase === 'prologue' && guard++ < 40) {
    if (cur.activeEvent) cur = step(cur, [{ type: 'event_choice', option: pick(PACK.cardMap[cur.activeEvent.cardId]) }]).state;
    else cur = step(cur, [{ type: 'advance' }]).state;
  }
  return cur;
}

describe('序章三幕 · 节拍引擎', () => {
  test('幕序：天下×4 → 围城×3 → p1/p3/p4 → 前传×3 → 合流 → p2/p5 → 第 1 天', () => {
    const { state } = newRun({ prologue: true });
    let s = state;
    assert.equal(s.phase, 'prologue');
    assert.equal(s.prelude.i, 0, '开局在幕一第一拍');
    // 幕一（天下×4）+ 幕二（关城/白日/夜/白衣）：八翻
    for (let i = 0; i < 8; i++) {
      assert.ok(!s.activeEvent, '文本幕不带卡');
      s = step(s, [{ type: 'advance' }]).state;
    }
    assert.equal(s.activeEvent?.cardId, 'p1_water', '幕二首卡是降卒进城');
    // 幕二三卡
    const order = [];
    while (s.activeEvent && !['p2_house'].includes(s.activeEvent.cardId)) {
      order.push(s.activeEvent.cardId);
      s = step(s, [{ type: 'event_choice', option: PICK[s.activeEvent.cardId] }]).state;
      if (!s.activeEvent) break; // 进入前传文本幕
    }
    assert.deepEqual(order, ['p1_water', 'p3_shelling', 'p4_door']);
    // 前传×3 + 入局引 + 合流：五翻（阵容三人）
    let textBeats = 0;
    while (!s.activeEvent && s.phase === 'prologue' && textBeats < 6) {
      s = step(s, [{ type: 'advance' }]).state;
      textBeats++;
    }
    assert.equal(textBeats, 5, '三段前传 + 入局引 + 一段合流');
    assert.equal(s.activeEvent?.cardId, 'p2_house', '合流后写名上墙');
    s = step(s, [{ type: 'event_choice', option: 'ours' }]).state;
    assert.equal(s.activeEvent?.cardId, 'p5_dawn9');
    s = step(s, [{ type: 'event_choice', option: 'begin' }]).state;
    assert.equal(s.activeEvent?.cardId, 'p6_white', '第九天早晨之后是白衣之夜');
    s = step(s, [{ type: 'event_choice', option: 'begin' }]).state;
    assert.equal(s.phase, 'day');
    assert.equal(s.day, 1);
    assert.ok(s.eventFlags.handover_seen, '白衣落旗：城开被亲眼看见');
    assert.equal(s.mainline[0]?.stepId, 'm1_flag', '序章落幕即落 D1 大事步（易帜）');
  });

  test('守卫：文本幕只有翻页合法，白天行动仍被挡', () => {
    const { state } = newRun({ prologue: true });
    const r = step(state, [{ type: 'act', actor: 'anton', action: 'eat', target: 'raw' }]);
    assert.ok(r.rejects.some((x) => x.reason === 'IN_PROLOGUE'));
  });

  test('卡拍上 advance 被挡——选择才有旗标与因果账', () => {
    const { state } = newRun({ prologue: true });
    let s = state;
    for (let i = 0; i < 8; i++) s = step(s, [{ type: 'advance' }]).state; // 幕一×4 + 幕二×4（含白衣）
    assert.equal(s.activeEvent?.cardId, 'p1_water');
    const r = step(s, [{ type: 'advance' }]);
    assert.ok(r.rejects.some((x) => x.reason === 'IN_PROLOGUE'), '卡拍必须选');
  });

  test('序章的选择进因果账（序章标签 + 动词正确）', () => {
    const { state } = newRun({ prologue: true });
    const s = playPrelude(state);
    const pro = s.causality.entries.filter((e) => e.tags?.includes('prologue'));
    assert.ok(pro.length >= 2, '序章至少两笔因果账（分食 + 开门）');
    assert.ok(pro.some((e) => e.verb === 'help' && e.target === 'neighbor'), '分给老人入账');
    assert.ok(pro.some((e) => e.verb === 'help' && e.target === 'stranger'), '开门入账');
  });

  test('合流段按组合换：素徽在队即旧宅变体', () => {
    const z = newRun({ prologue: true, roster: ['zofia', 'anton', 'marta'] }).state;
    const zt = preludeBeats(PACK, z).find((b) => b.id === 'confluence')?.text || '';
    assert.ok(zt.includes('旧宅'), '素徽变体收编');
    const d = newRun({ prologue: true, roster: ['danilo', 'vera', 'bron'] }).state;
    const dt = preludeBeats(PACK, d).find((b) => b.id === 'confluence')?.text || '';
    assert.ok(dt.includes('两本账'), '江鳅×薄姑互不信任变体');
    const plain = newRun({ prologue: true, roster: ['anton', 'marta', 'bron'] }).state;
    const pt = preludeBeats(PACK, plain).find((b) => b.id === 'confluence')?.text || '';
    assert.ok(pt.includes('三条路'), '无变体组合走通用合流');
  });

  test('入局引：前传毕、合流前——点破三个平民与活下去的目标（{{names}} 插值）', () => {
    const { state } = newRun({ prologue: true, roster: ['anton', 'marta', 'bron'] });
    const beats = preludeBeats(PACK, state);
    const eIdx = beats.findIndex((b) => b.source === 'entry');
    const cIdx = beats.findIndex((b) => b.id === 'confluence');
    const lastPreq = Math.max(...beats.map((b, i) => (b.t === 'prequel' ? i : -1)));
    assert.ok(eIdx > lastPreq && eIdx < cIdx, '入局引夹在前传与合流之间');
    const view = preludeBeatView(PACK, { ...state, prelude: { i: eIdx } });
    assert.ok(view.text.includes('文简、辛夷、石大'), '点名三人: ' + view.text.slice(0, 40));
    assert.ok(view.text.includes('活过这个秋天'), '目标：活下去');
    // 单句版同样有入局引（名字来得更突然，更需要这一拍）
    const short = newRun({ prologue: true, preludeMode: 'short', roster: ['bron', 'katya', 'pavel'] }).state;
    assert.ok(preludeBeats(PACK, short).some((b) => b.source === 'entry'));
  });

  test('单句版（二周目）：天下一行、前传用 line、可跳过', () => {
    const { state } = newRun({ prologue: true, preludeMode: 'short' });
    const beats = preludeBeats(PACK, state);
    const full = preludeBeats(PACK, newRun({ prologue: true }).state);
    assert.ok(beats.length < full.length, '单句版节拍更少');
    assert.equal(beats[0].id, 'openingChoice', '单句版第一拍是开场二选一（玩家局默认由此进入）');
    assert.equal(beats[1]?.id, 'heavenLine', '第二拍才是单句天下');
    assert.equal(beats.filter((b) => b.t === 'text' && b.source === 'heaven').length, 0, '长天下不进单句版');
    const preq = beats.find((b) => b.t === 'prequel');
    assert.ok(preq, '前传拍仍在（单句）');
    // 跳过：直接落地第 1 天，D1 大事步照落
    const r = step(state, [{ type: 'skip_prelude' }]);
    assert.equal(r.state.phase, 'day');
    assert.equal(r.state.mainline[0]?.stepId, 'm1_flag');
    assert.ok(r.facts.some((f) => f.k === 'prologue_skipped'), '跳过入账');
  });

  test('翻全卷：单句版展开为完整三幕，已答的卡不重复', () => {
    const { state } = newRun({ prologue: true, preludeMode: 'short' });
    let s = step(state, [{ type: 'advance' }]).state; // 开场选择 → 单句天下
    s = step(s, [{ type: 'advance' }]).state; // 单句天下 → p1
    assert.equal(s.activeEvent?.cardId, 'p1_water');
    s = step(s, [{ type: 'event_choice', option: 'tried' }]).state; // 答掉 p1 → 下一拍
    const r = step(s, [{ type: 'prelude_full' }]);
    s = r.state;
    assert.equal(s.preludeMode, 'full', '模式翻全');
    assert.equal(s.prelude.i, 0, '从「天下」重读');
    assert.ok(!s.activeEvent, '重回文本幕');
    for (let i = 0; i < 8; i++) s = step(s, [{ type: 'advance' }]).state; // 完整幕一×4 + 幕二×4
    assert.equal(s.activeEvent?.cardId, 'p3_shelling', '已答的 p1 跳过，p3 接上');
  });

  test('回忆录有序章段（围城那些天）', () => {
    const { state } = newRun({ prologue: true });
    let s = playPrelude(state);
    for (const c of s.chars) { c.wound = 3; c.hunger = 0; }
    for (let i = 0; i < 12 && !s.over; i++) {
      if (s.activeEvent) s = step(s, [{ type: 'event_choice', option: PACK.cardMap[s.activeEvent.cardId]?.options?.[0]?.key }]).state;
      s = step(s, [{ type: 'advance' }]).state;
      if (s.phase === 'dusk') s = step(s, [{ type: 'dusk_assign', scavenger: null, others: {} }]).state;
    }
    assert.ok(s.over);
    assert.ok(s.ending.storyline.prologue.length >= 2, '序章拍在复盘里');
  });

  test('fold 镜像：序章对局可重放（含节拍指针与大事轴）', () => {
    const { state, events } = newRun({ prologue: true });
    let s = state;
    const all = [...events];
    for (const opt of ['tried', 'share', 'open', 'ours', 'begin', 'begin']) {
      while (s.phase === 'prologue' && !s.activeEvent) {
        const r = step(s, [{ type: 'advance' }]);
        all.push(...r.events); s = r.state;
      }
      if (s.phase !== 'prologue') break;
      const r = step(s, [{ type: 'event_choice', option: opt }]);
      all.push(...r.events); s = r.state;
    }
    let tail = 0;
    while (s.phase === 'prologue' && tail++ < 20) { const r = step(s, [{ type: 'advance' }]); all.push(...r.events); s = r.state; }
    const rebuilt = fold(all);
    assert.equal(rebuilt.phase, 'day');
    assert.equal(rebuilt.prelude.i, rebuilt.prelude.i);
    assert.equal(rebuilt.mainline.length, s.mainline.length);
    assert.equal(rebuilt.causality.entries.length, s.causality.entries.length);
  });

  test('不带序章的开局仍是老样子（回归保护）', () => {
    const { state } = newRun({ prologue: false });
    assert.equal(state.phase, 'day');
    assert.ok(!state.activeEvent);
  });
});
