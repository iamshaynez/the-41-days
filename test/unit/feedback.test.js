// 原地反馈载荷（体验批次三）：输入响应不只回一段文——beats（谁在做、做了什么行）、
// moves（物品增减账）、ticks（刻度变化）随行，前端在打字的当下原地动起来。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, PACK } from '../helpers.js';
import { buildFeedback, renderDirect } from '../../packages/server/narrate.js';

describe('反馈载荷 buildFeedback', () => {
  test('beats：每条事实一行，行动者随行', () => {
    const { state } = newRun({ seed: 31 });
    const r = step(state, [{ type: 'auto_day' }]);
    const fb = buildFeedback(r.state, r.facts, r.events, PACK);
    assert.ok(Array.isArray(fb.beats) && fb.beats.length > 0, '白天收卷应有节拍');
    for (const b of fb.beats) {
      assert.ok(typeof b.line === 'string' && b.line, '节拍必须带可直接落纸的行');
      if (b.char) assert.ok(r.state.chars.some((c) => c.id === b.char), `行动者 ${b.char} 必须在名册里`);
    }
    const eat = fb.beats.find((b) => b.k === 'eat');
    if (eat) assert.ok(eat.char, '吃饭的节拍必须带上谁在吃');
  });

  test('moves：物品增减来自事件账（ITEM_MOVED），数值守恒', () => {
    const { state } = newRun({ seed: 32 });
    const r = step(state, [{ type: 'act', actor: 'anton', action: 'cook' }]);
    const fb = buildFeedback(r.state, r.facts, r.events, PACK);
    const moved = r.events.filter((e) => e.t === 'ITEM_MOVED');
    assert.equal(fb.moves.length, moved.length, 'moves 与 ITEM_MOVED 一一对应');
    for (const m of fb.moves) assert.ok(typeof m.item === 'string' && Number.isInteger(m.delta));
    if (moved.length) {
      const meal = fb.moves.find((m) => m.item === 'meal');
      assert.ok(meal && meal.delta === 1, '做饭应入熟食账');
    }
  });

  test('ticks：破晓刻度（饥饿/心情档）可指名到人', () => {
    const { state } = newRun({ seed: 33 });
    let s = state;
    const r1 = step(s, [{ type: 'advance' }]);
    s = r1.state;
    const r2 = step(s, [{ type: 'dusk_assign', scavenger: null, others: {} }]); // 在家过夜 → 破晓
    const fb = buildFeedback(r2.state, r2.facts, r2.events, PACK);
    const hunger = fb.ticks.filter((t) => t.t === 'HUNGER_CHANGED');
    assert.ok(hunger.length > 0, '破晓应带回饥饿刻度');
    for (const t of hunger) assert.ok(t.char && typeof t.to === 'number');
  });

  test('直读正文与节拍行严格同源：renderDirect === beats 逐行拼接（前端按拍排版的契约）', () => {
    for (const seed of [51, 52, 53, 54]) {
      const { state } = newRun({ seed });
      let s = state;
      const run = (intents) => {
        const r = step(s, intents);
        s = r.state;
        const facts = r.facts.filter((x) => x.k !== 'ensemble');
        const text = renderDirect(s, facts, PACK);
        const fb = buildFeedback(s, facts, r.events, PACK);
        assert.equal(fb.beats.map((b) => b.line).join('\n'), text, `seed ${seed} 正文与节拍必须逐行一致`);
      };
      run([{ type: 'auto_day' }]);
      run([{ type: 'dusk_assign', scavenger: null, others: {} }]);
    }
  });
});
