// 别传场景测试（长线体验-v0.2 §3.4 CH-04/05）：框架 + 结局变体 + 池隔离
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK, skipDayAtHome } from '../helpers.js';

describe('别传框架（CH-04/05）', () => {
  test('开局修饰：固定阵容、天数计时器、库存注入、序章不演', () => {
    const { state } = newRun({ seed: 90, sidestory: 'luzhou' });
    const s = state;
    assert.equal(s.sidestory?.id, 'luzhou');
    assert.equal(s.chars.length, 1, '鲁舟一人一船');
    assert.equal(s.chars[0].name, '鲁舟');
    assert.equal(s.war.endDay, 6, '五天水程，第六天破晓收束');
    assert.equal(s.inventory.jewel, 1, '舱底有货');
  });

  test('日更卡按日上门，旗标选结局变体（收纸 → 券局点头）', () => {
    let s = newRun({ seed: 91, sidestory: 'luzhou' }).state;
    s.inventory.canned = 20; s.inventory.raw = 20; // 夹具隔离饥饿
    // D1 装船：卖给军需曹
    assert.equal(s.activeEvent?.cardId, 'lz_d1', '别传日更卡 D1 必发');
    s = step(s, [{ type: 'event_choice', option: 'army' }]).state;
    s = skipDayAtHome(s); // D2
    assert.equal(s.activeEvent?.cardId, 'lz_d2');
    s = step(s, [{ type: 'event_choice', option: 'pass' }]).state;
    s = skipDayAtHome(s); // D3
    assert.equal(s.activeEvent?.cardId, 'lz_d3');
    s = step(s, [{ type: 'event_choice', option: 'take' }]).state;
    assert.ok(s.eventFlags.lz_took_docs);
    s = skipDayAtHome(s); // D4
    s = step(s, [{ type: 'event_choice', option: 'hide' }]).state;
    s = skipDayAtHome(s); // D5
    s = step(s, [{ type: 'event_choice', option: 'end' }]).state;
    s = skipDayAtHome(s); // D6 破晓收束
    assert.ok(s.over, '别传到点收束');
    assert.equal(s.ending.type, 'sidestory');
    assert.match(s.ending.storyline.title, /鲁舟的一趟船/);
    assert.match(s.ending.storyline.annals[0]?.text || '', /券局的人点了头/, '收纸变体');
    assert.match(s.ending.storyline.annals[0]?.note || '', /批注/);
  });

  test('池隔离：主线卡不进别传，别传卡不进主线', () => {
    const side = newRun({ seed: 92, sidestory: 'subo' }).state;
    // 别传局里，主线的 timeline 卡（湘关米等）永不出现在时间轴抽取里
    const sideTimeline = PACK.cards.filter((c) => c.kind === 'timeline' && (c.side || null) === 'subo');
    const mainTimeline = PACK.cards.filter((c) => c.kind === 'timeline' && !c.side);
    assert.ok(sideTimeline.length === 3 && sideTimeline.every((c) => c.id.startsWith('sb_')), '素伯线三夜');
    assert.ok(mainTimeline.every((c) => !c.id.startsWith('sb_')), '主线时间轴无别传卡');
    // 主线局不触发别传卡
    const main = newRun({ seed: 93, roster: ['anton', 'marta', 'bron'] }).state;
    assert.ok(!main.sidestory);
    assert.ok(!main.activeEvent || !PACK.cardMap[main.activeEvent.cardId]?.side, '主线首晨无别传卡');
  });

  test('别传不发交割前兆（telegraph 守卫）', () => {
    let s = newRun({ seed: 94, sidestory: 'fancheng' }).state;
    s.inventory.canned = 40; s.inventory.raw = 40;
    for (let i = 0; i < 12 && !s.over; i++) s = skipDayAtHome(s);
    assert.ok(s.over, '数板十天收束');
    assert.equal(s.ending.type, 'sidestory');
    assert.match(s.ending.storyline.annals[0]?.text || '', /水退了一寸/);
  });

  test('别传里或然注入静默（注射守卫）', () => {
    let s = newRun({ seed: 95, sidestory: 'liaohua' }).state;
    // 直接喂齐或然 B 的料子——别传局里也必须不响
    s.docsSeen = ['#058', '#063']; s.reputation.church = 1; s.eventFlags.fire_witness = true;
    s.day = 5; s.inventory.canned = 40; s.inventory.raw = 40;
    s = skipDayAtHome(s);
    assert.ok(s.activeEvent?.cardId !== 'alt_jiangling', '别传局不注入主线或然');
  });
});
