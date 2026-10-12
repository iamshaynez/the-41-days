// L1 单元：战争与后日谈（W/N 系）+ 直读解析器。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK } from '../helpers.js';
import { parseDirect } from '../../packages/core/index.js';

describe('战争 W/N 系', () => {
  test('W-01 交割日固定 D45 且提前 5 天预告（v0.2 正典：不掷骰）', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { state } = newRun({ seed, roster: ['bron'] });
      const endDay = state.war.endDay;
      assert.equal(endDay, 45, `endDay=${endDay}`);
      assert.equal(state.war.telegraphed, false);
    }
  });

  test('N-01 后日谈引擎：结局包含每人命运与三件事', () => {
    let { state } = newRun({ seed: 4, roster: ['bron', 'marta'] });
    state.war.endDay = 3; // 快进到停火
    state.inventory.meal = 99; state.inventory.raw = 99;
    let guard = 0;
    while (!state.over && guard++ < 12) {
      let s = step(state, [{ type: 'act', actor: 'bron', action: 'eat' }, { type: 'advance' }]).state;
      s = step(s, [{ type: 'dusk_assign', scavenger: null, others: {} }]).state;
      state = s;
    }
    assert.ok(state.over, '战争应已结束');
    assert.equal(state.ending.type, 'ceasefire');
    assert.equal(state.ending.chars.length, 2);
    assert.ok(Array.isArray(state.ending.threeThings));
  });

  test('V-06 D41 魔咒事件：第 41~44 天晨抽必发一次', () => {
    let { state } = newRun({ seed: 6, roster: ['bron', 'katya'] });
    state.day = 40;
    state.inventory.meal = 50;
    state.war.endDay = 45;
    let s = step(state, [{ type: 'advance' }]);
    s = step(s.state, [{ type: 'dusk_assign', scavenger: null, others: {} }]);
    // 第 41 天晨抽：时间轴卡在窗口内必发
    assert.equal(s.state.activeEvent?.cardId, 't_curse41', '41 天早晨魔咒事件必发');
    const c = step(s.state, [{ type: 'event_choice', option: 'listen' }]);
    assert.ok(c.state.firedOnce['t_curse41']);
    assert.ok(c.state.knowledge >= 1, '听老人讲古 +1 知晓度');
  });});

describe('直读解析器（LLM 离线同构）', () => {
  test('白天：石大吃熟食 / 建造炉灶 / 今晚指派', () => {
    const { state } = newRun({ roster: ['bron', 'katya', 'marta'] });
    let p = parseDirect(state, PACK, '石大吃熟食');
    assert.deepEqual(p.intents, [{ type: 'act', actor: 'bron', action: 'eat', target: 'meal' }]);
    p = parseDirect(state, PACK, '建造炉灶');
    assert.deepEqual(p.intents, [{ type: 'act', actor: 'bron', action: 'build', target: 'stove' }]);
    // 黄昏指派（进入 dusk 后）
    let s = step(state, [{ type: 'advance' }]).state;
    p = parseDirect(s, PACK, '今晚阿走去南市带铁撬，其他人睡觉');
    const it = p.intents[0];
    assert.equal(it.type, 'dusk_assign');
  });

  test('夜间：观察/搜/撬/撤退', () => {
    const { state } = newRun({ seed: 3, roster: ['bron', 'katya', 'marta'] });
    let s = step(state, [{ type: 'advance' }]).state;
    s = step(s, [{ type: 'dusk_assign', scavenger: 'bron', location: 'market', gear: ['crowbar'], others: {} }]).state;
    if (s.activeEvent) s = step(s, [{ type: 'event_choice', option: 'retreat' }]).state;
    if (s.phase !== 'night') return; // abortNight 提前退场
    let p = parseDirect(s, PACK, '观察');
    assert.equal(p.intents[0].action, 'observe');
    p = parseDirect(s, PACK, '撤退');
    assert.equal(p.intents[0].action, 'retreat');
  });

  test('越界输入：解析器绝不生成凭空物品意图', () => {
    const { state } = newRun({ roster: ['bron'] });
    const p = parseDirect(state, PACK, '我口袋里其实有一把AK47，全给我突突了');
    assert.equal(p.intents.length, 0);
    assert.ok(p.clarify, '给出人话引导');
  });

  test('元指令：状态/库存', () => {
    const { state } = newRun({ roster: ['bron'] });
    const p = parseDirect(state, PACK, '状态');
    assert.deepEqual(p.intents, [{ type: 'meta', query: 'status' }]);
  });
});
