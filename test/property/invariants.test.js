// L2 属性/不变量测试（技术架构 §10）：确定性、守恒律、fold 一致性。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, skipDayAtHome, PACK } from '../helpers.js';
import { fold } from '../../packages/core/index.js';

/** 全物品价值守恒：事件流里 ITEM_MOVED 的净和 == 库存变化（+系统产出/消耗白名单） */
function inventoryFromEvents(events) {
  const inv = {};
  for (const e of events) if (e.t === 'ITEM_MOVED') inv[e.d.item] = (inv[e.d.item] || 0) + e.d.delta;
  return inv;
}

describe('RND-06 确定性', () => {
  test('同种子同输入序列 → 逐字节一致的事件流', () => {
    const run1 = playFixedScript(100);
    const run2 = playFixedScript(100);
    assert.equal(JSON.stringify(run1.events), JSON.stringify(run2.events));
    assert.equal(JSON.stringify(run1.state), JSON.stringify(run2.state));
  });
  test('异种子 → 事件流不同（天气/骰点分歧）', () => {
    const a = playFixedScript(100);
    const b = playFixedScript(101);
    assert.notEqual(JSON.stringify(a.events), JSON.stringify(b.events));
  });
});

describe('守恒律与 fold 一致性', () => {
  test('L2-01 物品流动记账：库存 == 事件净和（含起点）', () => {
    const { state, events } = playFixedScript(77);
    const start = { ...newRun({ seed: 77, roster: ['bron', 'katya', 'pavel'] }).state.inventory };
    const delta = inventoryFromEvents(events);
    const expect = { ...start };
    for (const [k, v] of Object.entries(delta)) expect[k] = (expect[k] || 0) + v;
    // 归一化（负数清零）
    for (const k of Object.keys(expect)) if (expect[k] <= 0) delete expect[k];
    assert.deepEqual(state.inventory, expect);
  });

  test('L2-02 fold(events) === 最终状态（深比较）', () => {
    for (const seed of [1, 42, 77, 2024]) {
      const { state, events } = playFixedScript(seed);
      const f = fold(events);
      assert.deepEqual(f, state, `seed ${seed} fold 不一致`);
    }
  });

  test('L2-03 状态转移合法性：饥饿/伤/病不出界', () => {
    const { state } = playFixedScript(9);
    for (const c of state.chars) {
      assert.ok(c.hunger >= 0 && c.hunger <= 4);
      assert.ok(c.wound >= 0 && c.wound <= 3);
      assert.ok(c.sick >= 0 && c.sick <= 3);
      assert.ok(c.moodPts >= -18 && c.moodPts <= 15);
    }
  });
});

/** 固定剧本：三天，含建造/制造/夜访/事件/交易尝试/袭击面 */
function playFixedScript(seed) {
  const { state, events } = newRun({ seed, roster: ['bron', 'katya', 'pavel'] });
  let s = state, ev = [...events];
  const st = (intents) => { const r = step(s, intents); ev.push(...r.events); s = r.state; return r; };
  // D1 白天
  st([{ type: 'act', actor: 'bron', action: 'search_home' }]);
  st([{ type: 'act', actor: 'katya', action: 'search_home' }]);
  st([{ type: 'act', actor: 'pavel', action: 'open_room', target: 'cellar' }]);
  if (s.activeEvent) st([{ type: 'event_choice', option: s.activeEvent.cardId === 'n_meds' ? 'refuse' : 'give' }]);
  st([{ type: 'advance' }]);
  // D1 夜：阿走去里社
  st([{ type: 'dusk_assign', scavenger: 'pavel', location: 'church', gear: [], others: { bron: 'sleep', katya: 'sleep' } }]);
  let g = 0;
  while (s.phase === 'night' && s.night && !s.night.home && g++ < 12) {
    if (s.activeEvent) { st([{ type: 'event_choice', option: 'thanks' }]); continue; }
    const before = s.night.slots;
    st([{ type: 'night', action: 'search' }]);
    if (s.night && s.night.slots === before) { st([{ type: 'night', action: 'retreat' }]); break; }
  }
  if (s.phase === 'night') st([{ type: 'night', action: 'retreat' }]);
  // D2 白天：建炉灶、做饭、可能的交易
  st([{ type: 'act', actor: 'bron', action: 'build', target: 'stove' }]);
  st([{ type: 'act', actor: 'bron', action: 'cook' }]);
  st([{ type: 'act', actor: 'katya', action: 'eat' }]);
  if (s.franko) st([{ type: 'trade_op', give: { book: 1 }, get: { water: 2 } }]);
  if (s.activeEvent) st([{ type: 'event_choice', option: 'refuse' }]);
  st([{ type: 'advance' }]);
  // D2 夜：在家
  st([{ type: 'dusk_assign', scavenger: null, others: { bron: 'guard' } }]);
  return { state: s, events: ev };
}
