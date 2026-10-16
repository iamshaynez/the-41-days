// 宏观意图的相位方言（线上实测：LLM 裁判在黄昏把「出门找吃的」归成 auto_day，
// 同一句话直读路径返回 dusk_auto——同一句话不该因解析器不同被 BAD_PHASE 弹回）。
// 铁律：玩家话已出口，按当下相位翻译成当下能做的事；
// auto_day/auto_night/dusk_assign/dusk_auto/night_directive 在错相位一律翻译，绝不弹回。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK } from '../helpers.js';

const ROSTER = ['bron', 'marta', 'katya'];
const toDusk = (s) => { let n = s; while (n.phase !== 'dusk') n = step(n, [{ type: 'advance' }]).state; return n; };
const outTonight = (s, scav = 'bron', loc = 'market') =>
  step(s, [{ type: 'dusk_assign', scavenger: scav, location: loc, gear: [], others: {} }]).state;

describe('相位方言：求生话在错相位也要落地', () => {
  test('黄昏说 auto_day（出门找吃的被裁判归成白天托管）→ 派今晚的工，夜成行', () => {
    for (const seed of [601, 602, 603]) {
      let s = newRun({ seed, roster: ROSTER }).state;
      s = toDusk(s);
      s.knownLocs.push('market');
      const r = step(s, [{ type: 'auto_day' }]);
      assert.ok(!r.rejects.length, `seed ${seed}: 不许 BAD_PHASE 弹回（${JSON.stringify(r.rejects)}）`);
      assert.ok(r.state.phase === 'night' && r.state.night && !r.state.night.home,
        `seed ${seed}: 黄昏的托管 = 今晚有人出门张罗`);
    }
  });

  test('夜访中说 auto_day → 化作夜间方针，夜继续走', () => {
    let s = newRun({ seed: 604, roster: ROSTER }).state;
    s = toDusk(s);
    s.knownLocs.push('market');
    s = outTonight(s);
    assert.ok(s.phase === 'night' && s.night && !s.night.home, '前提：夜访中');
    const r = step(s, [{ type: 'auto_day' }]);
    assert.ok(!r.rejects.some((x) => x.reason === 'BAD_PHASE'), '不许 BAD_PHASE 弹回');
    assert.ok(r.state.night?.directive || r.state.night?.home || r.state.phase !== 'night',
      '夜有了方针或已收工——话没有落空');
  });

  test('夜半居家（批量内过渡态）说 auto_day → 收夜到天亮，不弹回', () => {
    let s = newRun({ seed: 605, roster: ROSTER }).state;
    s.phase = 'night'; s.night = { home: true }; // 手工构造过渡态（留守夜在批内即收）
    const dayBefore = s.day;
    const r = step(s, [{ type: 'auto_day' }]);
    assert.ok(!r.rejects.some((x) => x.reason === 'BAD_PHASE'), '不许 BAD_PHASE 弹回');
    assert.ok(r.state.day > dayBefore || r.state.phase !== 'night', '夜合上了');
  });

  test('白天说 dusk_assign（今晚谁去哪）→ 管家收卷今天，不许 NOT_DUSK 弹回', () => {
    let s = newRun({ seed: 606, roster: ROSTER }).state; // 新局即白天
    assert.equal(s.phase, 'day');
    s.knownLocs.push('market');
    const r = step(s, [{ type: 'dusk_assign', scavenger: 'bron', location: 'market', gear: [], others: {} }]);
    assert.ok(!r.rejects.some((x) => x.reason === 'NOT_DUSK'), `不许 NOT_DUSK 弹回（${JSON.stringify(r.rejects)}）`);
  });

  test('夜半居家（批量内过渡态）说 advance（过/睡觉吧）→ 合眼到天亮，不弹回', () => {
    let s = newRun({ seed: 607, roster: ROSTER }).state;
    s.phase = 'night'; s.night = { home: true };
    const r = step(s, [{ type: 'advance' }]);
    assert.ok(!r.rejects.some((x) => x.reason === 'BAD_PHASE'), `夜里说「过」不该失败（${JSON.stringify(r.rejects)}）`);
    assert.ok(r.state.phase !== 'night', '夜合上了');
  });

  test('白天说 auto_night（继续/你看着办被归成夜间托管）→ 收卷今天', () => {
    let s = newRun({ seed: 608, roster: ROSTER }).state; // 新局即白天
    assert.equal(s.phase, 'day');
    const r = step(s, [{ type: 'auto_night' }]);
    assert.ok(!r.rejects.length, `不许弹回（${JSON.stringify(r.rejects)}）`);
  });
});
