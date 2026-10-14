// 账卡（物资/人物状态台账）：一切变动都要「变了什么、变多少、为什么」随行——
// 变化不许无端发生（一轮实录反馈：状态经常莫名其妙地变）。
// 台账是事件流原账的聚合（fold 同源），落库为 role:ledger 书页行，续局重铺同一张卡。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, PACK, ch } from '../helpers.js';
import { Ctx } from '../../packages/core/index.js';
import { buildFeedback } from '../../packages/server/narrate.js';

describe('账卡台账 buildLedger', () => {
  test('吃饭：物资与饥饿两笔账都带原因', () => {
    const { state } = newRun({ seed: 61 });
    ch(state, 'anton').hunger = 2; // 饿了才吃得下
    const r = step(state, [{ type: 'act', actor: 'anton', action: 'eat', target: 'canned' }]);
    const fb = buildFeedback(r.state, r.facts, r.events, PACK, state.day - (r.state.day - state.day));
    // 注：act 不推进日期，inputDay 即 state.day（resolveInput 原地改，这里两者相等）
    const can = fb.ledger.items.find((x) => x.item === 'canned');
    assert.ok(can, '物资账里有罐头');
    assert.equal(can.delta, -1);
    assert.equal(can.name, PACK.itemMap.canned.name, '物资账用中文名');
    assert.equal(can.why, '进食', '物资账带原因');
    const ant = fb.ledger.chars.find((x) => x.char === 'anton');
    assert.ok(ant, '人物账里有安东');
    assert.equal(ant.name, '文简', '人物账用中文名');
    const h = ant.rows.find((x) => x.k === 'hunger');
    assert.ok(h, '有饥饿一行');
    assert.ok(h.why.includes(PACK.itemMap.canned.name), `饥饿变化要点明吃了什么（got ${h.why}）`);
    assert.ok(h.from && h.to && h.from !== h.to, '带 from→to');
  });

  test('破晓：过夜结算的人物账指名到人、笔笔带原因', () => {
    const { state } = newRun({ seed: 62 });
    let s = state;
    const r1 = step(s, [{ type: 'advance' }]);
    s = r1.state;
    const r2 = step(s, [{ type: 'dusk_assign', scavenger: null, others: {} }]); // 在家过夜 → 破晓结算
    const fb = buildFeedback(r2.state, r2.facts, r2.events, PACK, r1.state.day);
    assert.ok(fb.ledger.chars.length > 0, '破晓应带回人物账');
    for (const c of fb.ledger.chars) {
      assert.ok(c.name, '人物有中文名');
      for (const row of c.rows) {
        assert.ok(row.why, `${c.name} 的 ${row.k} 一行必须带原因——变化不许无端`);
        assert.ok(['hunger', 'wound', 'sick', 'fatigue', 'mood', 'breakdown', 'calm'].includes(row.k), `行类型在册（got ${row.k}）`);
      }
    }
    const hungers = fb.ledger.chars.flatMap((c) => c.rows.filter((x) => x.k === 'hunger'));
    assert.ok(hungers.length > 0, '破晓必有饥饿衰减');
    for (const h of hungers) assert.equal(h.why, '过了一日');
  });

  test('ctx 四把刻度锁：事件带 why，无 why 不硬造', () => {
    const { state } = newRun({ seed: 63 });
    const ctx = new Ctx(state, PACK, [], []);
    ctx.setWound(ch(state, 'anton'), 1, '夜巷动手');
    assert.equal(ctx.events.at(-1).t, 'WOUND_CHANGED');
    assert.equal(ctx.events.at(-1).d.why, '夜巷动手');
    ctx.setHunger(ch(state, 'anton'), 2, '吃了一顿');
    assert.equal(ctx.events.at(-1).d.why, '吃了一顿');
    ctx.setSick(ch(state, 'anton'), 1, '受寒');
    assert.equal(ctx.events.at(-1).d.why, '受寒');
    ctx.setFatigue(ch(state, 'anton'), 1, '守夜');
    assert.equal(ctx.events.at(-1).d.why, '守夜');
    ctx.setFatigue(ch(state, 'marta'), 1); // 0→1 不带 why：字段缺席，不写空串
    assert.equal(ctx.events.at(-1).t, 'FATIGUE_CHANGED');
    assert.equal(ctx.events.at(-1).d.why, undefined);
  });

  test('心情：档位变化带 from/to，原因聚合可读', () => {
    const { state } = newRun({ seed: 64 });
    const ctx = new Ctx(state, PACK, [], []);
    const marta = ch(state, 'marta');
    marta.moodPts = 0; // 平静档
    ctx.moodRaw(marta, -5, '被袭失窃');
    const fb = buildFeedback(state, ctx.facts, ctx.events, PACK, state.day);
    const m = fb.ledger.chars.find((x) => x.char === 'marta');
    assert.ok(m, '人物账里有玛尔塔');
    const mood = m.rows.find((x) => x.k === 'mood');
    assert.ok(mood, '有心情一行');
    assert.equal(mood.delta, -5);
    assert.equal(mood.from, '平静');
    assert.equal(mood.to, '低落');
    assert.deepEqual(mood.reasons, ['被袭失窃']);
  });

  test('moves（原地小签）与台账同源，同样带 why', () => {
    const { state } = newRun({ seed: 65 });
    const r = step(state, [{ type: 'act', actor: 'anton', action: 'cook' }]);
    const fb = buildFeedback(r.state, r.facts, r.events, PACK, state.day);
    for (const mv of fb.moves) assert.ok(mv.why, `moves 每笔都要带 why（item=${mv.item}）`);
  });

  test('台账可整体 JSON 序列化（要随书页落库重铺），且不至于超长', () => {
    const { state } = newRun({ seed: 66 });
    let s = state;
    const r1 = step(s, [{ type: 'auto_day' }]);
    s = r1.state;
    const r2 = step(s, [{ type: 'dusk_assign', scavenger: null, others: {} }]);
    const fb = buildFeedback(r2.state, r2.facts, r2.events, PACK, r1.state.day);
    const text = JSON.stringify(fb.ledger);
    assert.ok(text.length < 8000, `台账落库上限 8000 字（got ${text.length}）`);
    const back = JSON.parse(text);
    assert.equal(back.day, r1.state.day, '台账带本轮日戳');
    assert.ok(Array.isArray(back.items) && Array.isArray(back.chars));
  });

  test('同物同因的物资账聚合成一笔', () => {
    const { state } = newRun({ seed: 67 });
    const ctx = new Ctx(state, PACK, [], []);
    ctx.addItem('water', 1, '集雨');
    ctx.addItem('water', 1, '集雨');
    ctx.addItem('water', 1, '饮用');
    const fb = buildFeedback(state, ctx.facts, ctx.events, PACK, state.day);
    const waters = fb.ledger.items.filter((x) => x.item === 'water');
    assert.equal(waters.length, 2, '同因聚成一笔、异因分开');
    assert.deepEqual(waters.map((x) => x.delta).sort(), [1, 2]);
  });
});
