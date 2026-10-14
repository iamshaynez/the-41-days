// 快局（长线体验-v0.2 §4.1 局型表）：D21 入局的中盘切片——
// 「围城切片」快局：预设中盘家底，主线从还军时节照走，交割日仍是正典 D41。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, PACK } from '../helpers.js';
import { applyQuickStart } from '../../packages/core/src/pacing.js';
import { beginRun, fold } from '../../packages/core/index.js';

describe('场景：快局——从第 21 天入局', () => {
  test('中盘家底落地：日子、炉灶、门板、见识都是「认真玩了二十天」的样子', () => {
    const { state } = newRun({ seed: 21 });
    const qs = PACK.quickstart;
    assert.ok(qs, '内容包应带 quickstart 预设');
    applyQuickStart(state, PACK);
    assert.equal(state.day, qs.day, `入局即第 ${qs.day} 天`);
    assert.equal(state.phase, 'day');
    assert.ok(state.facilities.stove, '二十天的家不该没有炉灶');
    assert.ok(state.doorLevel >= 1, '门该有加固');
    assert.ok(state.knownLocs.length > 4, '见识过这座城');
    for (const c of state.chars) {
      assert.ok(c.hunger <= 3 && c.hunger >= 1, `${c.name} 应是中盘的饥饿度，不是开局的白板`);
      assert.ok(c.ap > 0, '入局第一天就有事可做');
    }
    assert.equal(state.war.endDay, 41, '交割日是正典，快局不许改');
  });

  test('快局照常开演：第一天收卷、夜访、破晓，账走事件流', () => {
    const { state } = newRun({ seed: 22 });
    applyQuickStart(state, PACK);
    const { events } = beginRun(state, PACK, { prologue: false });
    let s = state, all = [...events];
    const take = (intents) => { const r = step(s, intents); all.push(...r.events); s = r.state; return r; };
    const r1 = take([{ type: 'auto_day' }]);
    assert.ok(r1.state.phase === 'dusk' || r1.state.phase === 'day', '白天收得住');
    if (s.phase === 'dusk') {
      take([{ type: 'dusk_assign', scavenger: s.chars[0].id, location: s.knownLocs.includes('market') ? 'market' : s.knownLocs[0], gear: [], others: {} }]);
      if (s.phase === 'night' && s.night && !s.night.home) take([{ type: 'night_directive', stance: 'normal', text: '照常' }]);
    }
    assert.ok(!s.over, '快局第一天不该终局');
    assert.ok(s.day >= 21, `日子在第 21 天之后（实际 ${s.day}）`);
    const rebuilt = fold(all);
    assert.deepEqual(rebuilt, s, '快局开局预设必须走事件流可回放');
  });

  test('快局只补家底，不烧掉未来的卡：D21 之前窗口的卡照旧沉默', () => {
    const { state } = newRun({ seed: 23 });
    applyQuickStart(state, PACK);
    const { events } = beginRun(state, PACK, { prologue: false });
    const fired = events.filter((e) => e.t === 'EVENT_FIRED').map((e) => e.d.cardId);
    const early = (PACK.cards || []).filter((c) => {
      const [lo, hi] = c.when?.dayWindow || [];
      return lo !== undefined && hi !== undefined && hi < 21;
    });
    for (const c of early) assert.ok(!fired.includes(c.id), `过窗卡 ${c.id} 不该在 D21 复活`);
  });
});
