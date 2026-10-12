// 念头（direction）生命周期场景（命运导演 P1）：
// 种下 → 登记/FLAG/fact → 浇水 → 上限挤出让位 → 晨间回声 → 枯萎 → 锚池/世界简报可见。
// 念头是介于命令（act）与规矩（policy）之间的第三种动词：玩家种方向，世界慢慢消化。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, PACK } from '../helpers.js';
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
    assert.ok(line.includes('教她认字') && line.includes('心里'), `渲染应含念头原文：${line}`);
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

  test('第四颗念头：最老的淡出让位（fact direction_faded）', () => {
    const { state } = newRun({ seed: 13 });
    let s = state;
    const texts = ['教她认字', '把账写下去', '夜里别一个人出门', '学琴'];
    for (const t of texts) s = step(s, [{ type: 'direction', subject: 'marta', text: t }]).state;
    const alive = Object.values(s.directions).filter((d) => d.alive);
    assert.equal(alive.length, 3, '同时至多三颗');
    assert.ok(!alive.some((d) => d.text === '教她认字'), '最老的已淡出');
  });

  test('晨间回声：种下次日世界记得（fact direction_echo）', () => {
    const { state } = newRun({ seed: 14 });
    const r0 = step(state, [{ type: 'direction', subject: 'marta', text: '教她认字' }]);
    const r1 = step(r0.state, [{ type: 'advance' }]);
    assert.equal(r1.state.phase, 'dusk');
    const r2 = step(r1.state, [{ type: 'dusk_assign', scavenger: null, others: {} }]);
    assert.equal(r2.state.day, 2, '过了一天');
    assert.ok(r2.facts.some((f) => f.k === 'direction_echo' && f.char === 'marta'), `次日晨间应有回声：${r2.facts.map((f) => f.k).join(',')}`);
  });

  test('十天没人再提：念头枯萎（fact direction_faded）', () => {
    const { state } = newRun({ seed: 15 });
    const r0 = step(state, [{ type: 'direction', subject: 'marta', text: '教她认字' }]);
    let s = r0.state;
    let faded = false;
    for (let d = 0; d < 13 && !s.over && !faded; d++) {
      const r = step(s, [{ type: 'advance' }]);
      const r2 = step(r.state, [{ type: 'dusk_assign', scavenger: null, others: {} }]);
      s = r2.state;
      faded = r2.facts.some((f) => f.k === 'direction_faded');
    }
    assert.ok(faded, '十天后枯萎');
    assert.ok(Object.values(s.directions).every((d) => !d.alive), '没有活着的念头');
  });

  test('念头进锚池与世界简报——裁判、叙事者、编剧都看得见', () => {
    const { state } = newRun({ seed: 16 });
    const s = step(state, [{ type: 'direction', subject: 'anton', text: '把账写下去' }]).state;
    const pool = anchorPool(PACK, s);
    assert.ok(pool.includes('念头:文简·把账写下去'), `锚池应含念头：${pool.join(' ')}`);
    const brief = worldBrief(s, PACK);
    assert.ok(brief.includes('把账写下去') && brief.includes('念头'), `简报应含念头：${brief}`);
  });

  test('念头的主人不在了：回声不再响（但登记不失败）', () => {
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
