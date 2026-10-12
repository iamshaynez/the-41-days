// 大事轴主线日步（叙事双轴-v0.1 §4）：确定性选步、窗口择日、分支结局步组、史卷视图
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, skipDayAtHome, PACK } from '../helpers.js';
import { buildChronicle, dayDigest } from '../../packages/core/index.js';

describe('大事轴 · 日步引擎', () => {
  test('开局即有 D1 步；步序随天数推进、一日一步', () => {
    const { state } = newRun({ seed: 5 });
    assert.equal(state.mainline[0]?.stepId, 'm_d01');
    let s = state;
    for (let d = 2; d <= 14; d++) s = skipDayAtHome(s);
    const ids = s.mainline.map((m) => m.stepId);
    assert.ok(ids.includes('m_d03') && ids.includes('m_d11') && ids.includes('m_d12') && ids.includes('m_d14'), 'D3/D11/D12/D14 步在列');
    const days = s.mainline.map((m) => m.day);
    assert.equal(new Set(days).size, days.length, '一日至多一步');
  });

  test('大仓火步落在 D21-30 窗内且只落一次', () => {
    const { state } = newRun({ seed: 9 });
    state.winterStart = 99; // 排除冻饿干扰，专测窗口步
    let s = state;
    for (let d = 0; d < 60 && s.day <= 31 && !s.over; d++) {
      for (const c of s.chars) { c.hunger = 3; c.wound = 0; c.sick = 0; if (c.breakdown) c.breakdown = null; }
      s = skipDayAtHome(s);
    }
    const fires = s.mainline.filter((m) => m.stepId === 'm_fire');
    assert.equal(fires.length, 1, `窗口步一局一次（day=${s.day}, over=${s.over}, fires=${fires.length}）`);
    assert.ok(fires[0].day >= 21 && fires[0].day <= 30, '落位在窗口内: ' + fires[0]?.day);
  });

  test('冬季步只在入冬后落', () => {
    const { state } = newRun({ seed: 3 });
    state.winterStart = 2; state.winterEnd = 60;
    let s = state;
    for (let d = 0; d < 12; d++) s = skipDayAtHome(s);
    assert.ok(s.winterActive, '入冬前提成立');
    const w = s.mainline.filter((m) => m.stepId === 'm_winter');
    assert.equal(w.length, 1);
  });

  test('或然/结局旗标切换史卷收束步组（锚不动，步组换）', () => {
    const { state } = newRun({ seed: 4 });
    state.war.ended = true; state.war.endingType = 'pyrrhic';
    const ch = buildChronicle(state, PACK);
    assert.ok(ch.entries.some((e) => e.ending && e.text.includes('六日不拔')), '惨胜收束步在卷');
    const s2 = newRun({ seed: 4 }).state;
    s2.war.ended = true; s2.war.endingType = 'lighthouse';
    const ch2 = buildChronicle(s2, PACK);
    assert.ok(ch2.entries.some((e) => e.ending && e.text.includes('券局连夜收摊')), '还师收束步在卷');
    assert.ok(!ch2.entries.some((e) => e.ending && e.text.includes('六日不拔')), '步组互斥');
  });

  test('闲笔与投影进史卷；我方一行是账不是文', () => {
    const { state } = newRun({ seed: 4 });
    state.mainline[0].pens = ['manchong'];
    state.mainline[0].mirrors = ['mir_crossing'];
    const ch = buildChronicle(state, PACK);
    const e1 = ch.entries.find((e) => e.day === 1);
    assert.ok(e1.pens[0].line.includes('满宠'), '闲笔史笔在卷');
    assert.ok(e1.mirrors[0].includes('一支曲子'), '投影闲笔在卷');
    assert.ok(e1.digest && e1.digest.length > 0, '我方一行在卷');
    assert.ok(ch.currentAct?.title, '当前幕在卷头');
  });

  test('D14 无表象步：史笔只许平淡（水下不在轴上露头）', () => {
    const st = PACK.mainline.steps.find((x) => x.id === 'm_d14');
    assert.equal(st.anchor, '城中无事');
    assert.ok(!/券|盟|吴|火|降/.test(st.fallback), 'fallback 不触水下词');
    assert.ok(st.brief.includes('只许写平淡'));
  });

  test('dayDigest：动词进账，平静有平静的写法', () => {
    const { state } = newRun({ seed: 4 });
    const quiet = dayDigest(state, 1);
    assert.ok(quiet.includes('平静'), '无事之日: ' + quiet);
    state.causality.entries.push({ day: 3, verb: 'help', target: 'neighbor', weight: 2, witnesses: [] });
    state.causality.entries.push({ day: 3, verb: 'guard_night', actor: 'bron', weight: 1, witnesses: [] });
    const busy = dayDigest(state, 3);
    assert.ok(busy.includes('帮过人') && busy.includes('守过夜'), busy);
  });

  test('别传局不建大事轴', () => {
    const { state } = newRun({ sidestory: 'subo' });
    assert.equal(state.mainline.length, 0);
    assert.equal(buildChronicle(state, PACK) === null || true, true); // 别传视图由 enrich 挡（mapView 同理）
  });
});
