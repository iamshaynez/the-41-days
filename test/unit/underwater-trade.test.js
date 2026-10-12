// 水下交易（统一交互面）：价目卡退场，管家在商人到访时自料理——
// 玩家用指令（trade_op 自由输入）或念头干预，但不再有交易界面。
// feasibleIntent：谋士选项的只读可行性门——渲染出来的选项必须点得动。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, PACK } from '../helpers.js';
import { planDay, feasibleIntent, tradeDeals } from '../../packages/core/index.js';

function withFranko() {
  const { state } = newRun({ seed: 31 });
  state.franko = { merchant: 'franko', stock: [
    { item: 'bandage', n: 2, buy: 3 }, { item: 'canned', n: 3, buy: 2 }, { item: 'firewood', n: 4, buy: 2 }
  ] };
  // 制造真实需求：没绷带、存粮见底——管家有理由出手
  delete state.inventory.bandage;
  state.inventory.canned = 0;
  state.inventory.raw = 0;
  state.inventory.jewel = 2; // 支付池有余
  return state;
}

describe('管家自动交易（水下）', () => {
  test('商人在门口时，auto_day 自带一笔建议成交（delegated）', () => {
    const s = withFranko();
    const r = step(s, [{ type: 'auto_day' }]);
    const traded = r.events.filter((e) => e.t === 'TRADE_DONE');
    assert.equal(traded.length, 1, `应成交一笔：${r.facts.map((f) => f.k).join(',')}`);
    assert.ok(r.facts.some((f) => f.k === 'trade_done' && f.delegated), '管家代办的账要分得清');
  });

  test('没有商人就没有交易', () => {
    const { state } = newRun({ seed: 32 });
    const r = step(state, [{ type: 'auto_day' }]);
    assert.equal(r.events.filter((e) => e.t === 'TRADE_DONE').length, 0);
  });

  test('家底付不起时管家不硬买（tradeDeals 本来就只出必过的单）', () => {
    const s = withFranko();
    // 掏空支付池：值钱的清零、材料压到建造底线之下、书也烧没
    for (const it of ['jewel', 'wine', 'moonshine', 'cigs', 'coffee', 'book']) delete s.inventory[it];
    s.inventory.parts = 3; // 低于底线 4，不动
    s.inventory.wood = 6;  // 正好是底线，不动
    const r = step(s, [{ type: 'auto_day' }]);
    assert.equal(r.events.filter((e) => e.t === 'TRADE_DONE').length, 0);
  });
});

describe('feasibleIntent（谋士选项的可行性门）', () => {
  test('act：人活着、有 AP 才可行；死人不可行', () => {
    const { state } = newRun({ seed: 33, roster: ['anton', 'marta', 'bron'] });
    assert.ok(feasibleIntent(state, PACK, { type: 'act', actor: 'anton', action: 'eat', target: 'raw' }));
    state.chars[0].alive = false;
    assert.ok(!feasibleIntent(state, PACK, { type: 'act', actor: 'anton', action: 'eat', target: 'raw' }));
    state.chars[0].alive = true; state.chars[0].ap = 0;
    assert.ok(!feasibleIntent(state, PACK, { type: 'act', actor: 'anton', action: 'eat', target: 'raw' }));
  });

  test('act 的设施/耗材前置：无灶不 cook、没书不读、没绷带不治（渲染的选项点得动）', () => {
    const { state } = newRun({ seed: 37, roster: ['anton', 'marta', 'bron'] });
    assert.ok(!feasibleIntent(state, PACK, { type: 'act', actor: 'anton', action: 'cook' }), '第 1 天没炉灶');
    state.facilities.stove = 1;
    assert.ok(feasibleIntent(state, PACK, { type: 'act', actor: 'anton', action: 'cook' }));
    assert.ok(feasibleIntent(state, PACK, { type: 'act', actor: 'anton', action: 'read' }), '开局有两册书');
    delete state.inventory.book;
    assert.ok(!feasibleIntent(state, PACK, { type: 'act', actor: 'anton', action: 'read' }));
    assert.ok(feasibleIntent(state, PACK, { type: 'act', actor: 'marta', action: 'treat', target: 'bandage', patient: 'anton' }), '有绷带即可（伤员细判留给内核）');
    delete state.inventory.bandage;
    assert.ok(!feasibleIntent(state, PACK, { type: 'act', actor: 'marta', action: 'treat', target: 'bandage', patient: 'anton' }), '没绷带不治');
  });

  test('dusk_assign：地点必须已知；夜访意图必须真的在夜里', () => {
    const { state } = newRun({ seed: 34, roster: ['anton', 'marta', 'bron'] });
    state.phase = 'dusk'; // 黄昏卡在黄昏相位上刷新选项
    assert.ok(feasibleIntent(state, PACK, { type: 'dusk_assign', scavenger: 'anton', location: 'market', gear: [], others: {} }));
    assert.ok(!feasibleIntent(state, PACK, { type: 'dusk_assign', scavenger: 'anton', location: 'beacon', gear: [], others: {} }), '不认识的地方去不了');
    assert.ok(!feasibleIntent(state, PACK, { type: 'night', action: 'search', target: 'x' }), '黄昏没有夜间意图');
  });

  test('trade_op：商人在、给得出、买得到才可行', () => {
    const s = withFranko();
    assert.ok(feasibleIntent(s, PACK, { type: 'trade_op', give: { jewel: 1 }, get: { bandage: 1 } }));
    assert.ok(!feasibleIntent(s, PACK, { type: 'trade_op', give: { jewel: 1 }, get: { rifle: 1 } }), '摊上没有的货');
    assert.ok(!feasibleIntent(s, PACK, { type: 'trade_op', give: { jewel: 9 }, get: { bandage: 1 } }), '给不起');
    const { state } = newRun({ seed: 35 });
    assert.ok(!feasibleIntent(state, PACK, { type: 'trade_op', give: { jewel: 1 }, get: { bandage: 1 } }), '没有商人');
  });

  test('越权意图类型一律不可行（谋士不许出这些牌）', () => {
    const { state } = newRun({ seed: 36 });
    assert.ok(!feasibleIntent(state, PACK, { type: 'meta', query: 'status' }));
    assert.ok(!feasibleIntent(state, PACK, { type: 'whisper', text: 'x' }));
    assert.ok(!feasibleIntent(state, PACK, { type: 'event_choice', option: 'g0' }));
  });
});
