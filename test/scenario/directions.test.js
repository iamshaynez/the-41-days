// 念头演化（三级分流）：誓（影响列传）/史种（长成停问卡）/杂念（静默快散）。
// 永生回声与「种下的念头」专栏退役——隆重度与兑付力对齐。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, PACK } from '../helpers.js';
import { Ctx } from '../../packages/core/index.js';
import { tickDirections } from '../../packages/core/src/causality.js';
import { dawnProblems } from '../../packages/core/src/delegate.js';
import { fold } from '../../packages/core/index.js';
import { anchorPool } from '../../packages/core/src/ge.js';
import { worldBrief, renderDirect } from '../../packages/server/narrate.js';
import { parseDirect } from '../../packages/core/src/parser.js';

describe('场景：种下一个念头', () => {
  test('种下：登记进状态、落 FLAG 事件、fact 可直读渲染', () => {
    const { state, events } = newRun({ seed: 11 });
    const r = step(state, [{ type: 'direction', subject: 'marta', text: '教她认字' }]);
    const dirs = Object.values(r.state.directions);
    assert.equal(dirs.length, 1);
    assert.ok(dirs[0].alive);
    assert.equal(dirs[0].subject, 'marta');
    assert.ok(r.facts.some((f) => f.k === 'direction_set'), '落 direction_set fact');
    assert.ok(r.events.some((e) => e.t === 'FLAG' && e.d.key === 'directions'), '落 FLAG 事件');
    // fold 回放：念头登记走事件溯源，重放结果一致
    const rebuilt = fold([...events, ...r.events]);
    assert.deepEqual(rebuilt.directions, r.state.directions);
    // 直读渲染：这句话落进了心里
    const line = renderDirect(r.state, r.facts, PACK);
    assert.ok(line.includes('种子'), `杂念直读行轻描淡写（不陈列原文）：${line}`);
  });

  test('同一念头再说一遍：浇水，不重种', () => {
    const { state } = newRun({ seed: 12 });
    const r1 = step(state, [{ type: 'direction', subject: 'marta', text: '教她认字' }]);
    // 过一天再提：lastDay 应刷新到当天（浇水延缓枯萎）
    const day2 = step(step(r1.state, [{ type: 'advance' }]).state, [{ type: 'dusk_assign', scavenger: null, others: {} }]).state;
    assert.equal(day2.day, 2);
    const r2 = step(day2, [{ type: 'direction', subject: 'marta', text: '教她认字' }]);
    assert.equal(Object.keys(r2.state.directions).length, 1, '不重复登记');
    const d = Object.values(r2.state.directions)[0];
    assert.equal(d.lastDay, 2, '浇水刷新 lastDay');
    assert.ok(r2.facts.some((f) => f.k === 'direction_watered'), '落浇水 fact');
  });

  test('第四颗杂念不挤兑（誓才有上限；杂念自散）', () => {
    const { state } = newRun({ seed: 13 });
    let s = state;
    for (const t of ['教她认字', '冬天要撑过去', '春天种点菜', '多睡点觉']) {
      s = step(s, [{ type: 'direction', subject: 'marta', text: t }]).state;
    }
    assert.equal(Object.values(s.directions).filter((d) => d.alive).length, 4, '杂念不限量');
  });

  test('回声退役：杂念不回声，三天自散（fact direction_faded）', () => {
    const { state } = newRun({ seed: 14 });
    const r0 = step(state, [{ type: 'direction', subject: 'marta', text: '教她认字' }]); // 杂念（无地无名）
    assert.ok(r0.facts.some((f) => f.k === 'direction_set'), '登记照旧');
    let s = r0.state;
    const ctx = new Ctx({ ...s, day: s.day + 3 }, PACK, [], []);
    tickDirections(ctx);
    assert.ok(ctx.facts.some((f) => f.k === 'direction_faded'), '三天自散');
    assert.ok(!ctx.facts.some((f) => f.k === 'direction_echo'), '永生回声已退役');
  });

  test('誓不枯萎：晨报一行常驻直到践行（杂念才散）', () => {
    const { state } = newRun({ seed: 15 });
    const r0 = step(state, [{ type: 'direction', text: '去大族宅区拆板材' }]); // 誓
    const v = Object.values(r0.state.directions).find((d) => d.kind === 'vow');
    assert.ok(v, '点名宅区成誓');
    const later = { ...r0.state, day: r0.state.day + 12 };
    const line = dawnProblems(later, PACK).find((p) => p.key === 'vow_' + v.id);
    assert.ok(line && /未践·第12天/.test(line.text), `誓常驻晨报（${line?.text}）`);
  });

  test('世界简报只报未践的誓——杂念不广播（谋士不再复读）', () => {
    const { state } = newRun({ seed: 16 });
    let s = step(state, [{ type: 'direction', text: '去南市看看' }]).state; // 誓
    s = step(s, [{ type: 'direction', subject: 'anton', text: '把账写下去' }]).state; // 杂念
    const brief = worldBrief(s, PACK);
    assert.ok(brief.includes('未践的誓') && brief.includes('南市'), '誓要进简报');
    assert.ok(!brief.includes('把账写下去'), '杂念不广播');
  });

  test('誓的主人不在了：登记不失败（列传照念）', () => {
    const { state } = newRun({ seed: 17 });
    const s = step(state, [{ type: 'direction', subject: null, text: '这个家要有个读书声' }]).state;
    assert.ok(Object.values(s.directions)[0].subject === null, '全家念头 subject 为 null');
  });
});

describe('直读：念头的大白话入口（保守规则，LLM 裁判管全量语义）', () => {
  test('「教辛夷认字」→ direction 意图', () => {
    const { state } = newRun({ seed: 18 });
    const r = parseDirect(state, PACK, '教辛夷认字');
    assert.equal(r.intents[0]?.type, 'direction');
    assert.equal(r.intents[0]?.subject, 'marta');
    assert.ok(r.intents[0]?.text?.includes('认字'));
  });

  test('「以后鼓励文简把账写完」→ direction；「让石大吃熟食」→ 仍是 act 命令', () => {
    const { state } = newRun({ seed: 19 });
    const d = parseDirect(state, PACK, '以后鼓励文简把账写完');
    assert.equal(d.intents[0]?.type, 'direction');
    assert.equal(d.intents[0]?.subject, 'anton');
    const a = parseDirect(state, PACK, '让石大吃熟食');
    assert.equal(a.intents[0]?.type, 'act');
    assert.equal(a.intents[0]?.action, 'eat');
  });
});

describe('场景：未被接住的话（whisper 素材环）', () => {
  test('落环：状态、FLAG、fact、锚池可见', () => {
    const { state, events } = newRun({ seed: 20 });
    const r = step(state, [{ type: 'whisper', text: '我在渡口看见龙了' }]);
    assert.deepEqual(r.state.whispers, [{ day: 1, text: '我在渡口看见龙了' }]);
    assert.ok(r.events.some((e) => e.t === 'FLAG' && e.d.key === 'whispers'));
    const rebuilt = fold([...events, ...r.events]);
    assert.deepEqual(rebuilt.whispers, r.state.whispers);
    assert.ok(anchorPool(PACK, r.state).includes('话语:我在渡口看见龙了'));
    assert.ok(renderDirect(r.state, r.facts, PACK).length > 0, '直读渲染不空');
  });

  test('环只留最近三句', () => {
    const { state } = newRun({ seed: 21 });
    let s = state;
    for (const w of ['一句', '两句', '三句', '四句']) s = step(s, [{ type: 'whisper', text: w }]).state;
    assert.equal(s.whispers.length, 3);
    assert.equal(s.whispers[2].text, '四句');
    assert.ok(!s.whispers.some((w) => w.text === '一句'));
  });
});
