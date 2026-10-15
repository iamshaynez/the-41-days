// 念头演化（三级分流）：誓（影响人物结局）/ 史种（影响历史）/ 杂念（静默快散）。
// 誓——点名地点的话立成誓：晨报一行「未践·第N天」、夜访到地即践（列传改写）、
//      反复说从不做会被记账（「说过N遍」进列传）、上限 3 条立新挤旧；
// 史种——提到史锚（北津台/家书/麦城/军心）的话落进城里人耳朵：不进面板、
//      几天后在对应晨位池长出一张为它定制的停问卡（动态注入变体池）；
// 杂念——其余：不回声、不占面板、三天自散。
// 撤除：今日卡「种下的念头」专栏、三日回声、简报杂念广播（只报活誓）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK } from '../helpers.js';
import { Ctx } from '../../packages/core/index.js';
import { dawnProblems, planDusk } from '../../packages/core/src/delegate.js';
import { mainlineAskTick } from '../../packages/core/src/mainline.js';
import { buildEnding } from '../../packages/core/index.js';
import { tickDirections } from '../../packages/core/src/causality.js';

const VOW = '带铁撬去大族宅区拆可用的板材'; // 点名地点 → 誓
const HIST = '北津台该有人举火';             // 史锚 → 史种
const MISC = '这个冬天要撑过去';             // 杂念

describe('三级分流：种下那刻就分好', () => {
  test('点名地点 → 誓（带 target）；史锚 → 史种；其余 → 杂念', () => {
    let s = newRun({ seed: 801 }).state;
    s = step(s, [{ type: 'advance' }]).state; // 到白天相位之外也行——direction 全相位可种
    s = step(s, [{ type: 'direction', text: VOW }]).state;
    s = step(s, [{ type: 'direction', text: HIST }]).state;
    s = step(s, [{ type: 'direction', text: MISC }]).state;
    const dirs = Object.values(s.directions);
    assert.ok(dirs.some((d) => d.kind === 'vow' && d.target === 'villas'), '点名宅区 → 誓·target=villas');
    assert.ok(dirs.some((d) => d.kind === 'hist' && d.seed === 'beacon'), '北津台 → 史种·beacon');
    assert.ok(dirs.some((d) => d.kind === 'misc'), '其余 → 杂念');
  });
});

describe('誓：立、践、赖账', () => {
  test('晨报常驻一行「未践·第N天」；不占今日卡专栏', () => {
    const { state } = newRun({ seed: 802 });
    state.day = 5;
    state.directions = { v1: { id: 'v1', text: VOW, kind: 'vow', target: 'villas', day: 2, lastDay: 2, alive: true, watered: 0 } };
    const line = dawnProblems(state, PACK).find((p) => p.key === 'vow_v1');
    assert.ok(line && /未践/.test(line.text) && /大族宅区/.test(line.text), `誓要占晨报一行（${line?.text}）`);
    assert.equal(line.sev, 0, 'sev0 不拦概述');
  });

  test('夜访到地即践：alive 落 false、当事人心情 +1、事实落账', () => {
    let s = newRun({ seed: 803, roster: ['anton', 'marta', 'bron'] }).state;
    s = step(s, [{ type: 'advance' }]).state;
    s = step(s, [{ type: 'direction', subject: 'marta', text: '让辛夷去医棚看看药' }]).state;
    const marta = ch(s, 'marta');
    const moodBefore = marta.moodPts;
    s.inventory.knife = 1; s.knownLocs.push('hospital');
    const r = step(s, [{ type: 'dusk_assign', scavenger: 'marta', location: 'hospital', gear: [], others: {} }]);
    const v = Object.values(r.state.directions).find((d) => d.kind === 'vow');
    assert.ok(v && v.alive === false && v.fulfilledDay, '到地即践');
    assert.ok(r.facts.some((f) => f.k === 'vow_fulfilled'), '践约事实落账');
    assert.ok(ch(r.state, 'marta').moodPts > moodBefore || !ch(r.state, 'marta').alive, '当事人心情 +1');
  });

  test('赖账进列传：未践+反复提 → 终局卷念你说过几遍；践了 → 放下了', () => {
    const base = newRun({ seed: 804, roster: ['anton', 'marta', 'bron'] });
    // 未践 + 浇水两次
    let s = base.state;
    s.directions = { v1: { id: 'v1', text: '替文简查查公安的下落', kind: 'vow', target: 'post', subject: 'anton', day: 3, lastDay: 20, alive: true, watered: 2 } };
    let ending = buildEnding(s, PACK);
    let anton = ending.chars.find((c) => c.id === 'anton');
    assert.ok(/遍|不再数/.test(anton.fate), `赖账要念进列传（${anton.fate}）`);
    // 践了
    s.directions.v1 = { ...s.directions.v1, alive: false, fulfilledDay: 12 };
    ending = buildEnding(s, PACK);
    anton = ending.chars.find((c) => c.id === 'anton');
    assert.ok(/放下/.test(anton.fate), `践约要写「放下」（${anton.fate}）`);
  });

  test('上限 3：立第 4 誓挤掉最旧的（转未践到底）', () => {
    let s = newRun({ seed: 805 }).state;
    s = step(s, [{ type: 'advance' }]).state;
    for (const t of ['去南市看看', '去医棚看看药', '去宅区拆板材', '去里社上一炷香']) { // 四处都是开局识途之地
      s = step(s, [{ type: 'direction', text: t }]).state;
    }
    const vows = Object.values(s.directions).filter((d) => d.kind === 'vow');
    assert.equal(vows.filter((d) => d.alive).length, 3, '活誓至多 3');
    assert.ok(vows.some((d) => !d.alive && !d.fulfilledDay), '最旧的转未践到底');
  });
});

describe('史种：不进面板，长在史书里', () => {
  test('种下不占晨报（杂念史种都不占）；到窗口注入晨位池', () => {
    const { state } = newRun({ seed: 806 });
    state.day = 29; state.phase = 'day';
    state.directions = { h1: { id: 'h1', text: HIST, kind: 'hist', seed: 'beacon', day: 6, lastDay: 6, alive: true, watered: 0 } };
    assert.ok(!dawnProblems(state, PACK).some((p) => String(p.key).startsWith('vow_')), '史种不占晨报');
    let fired = null;
    for (let seed = 1; seed <= 20; seed++) {
      const { state: sx } = newRun({ seed });
      sx.day = 29; sx.phase = 'day';
      sx.directions = { h1: { id: 'h1', text: HIST, kind: 'hist', seed: 'beacon', day: 6, lastDay: 6, alive: true, watered: 0 } };
      mainlineAskTick(new Ctx(sx, PACK, [], []));
      if (sx.activeEvent?.cardId === 'hs_beacon') { fired = seed; break; }
    }
    assert.ok(fired, `20 个种子里史种卡应至少入选一次（hs_beacon）`);
  });

  test('内容契约：史种回应卡在册（北津台/家书/麦城/军心各一张）', () => {
    for (const id of ['hs_beacon', 'hs_letters', 'hs_maicheng', 'hs_army']) {
      const c = PACK.cardMap[id];
      assert.ok(c, `${id} 在册`);
      assert.ok((c.options || []).length >= 2, `${id} 有得选`);
    }
  });
});

describe('杂念：静默快散', () => {
  test('三天自散、无回声（direction_echo 退役）', () => {
    const { state } = newRun({ seed: 807 });
    state.day = 5;
    state.directions = { m1: { id: 'm1', text: MISC, kind: 'misc', day: 1, lastDay: 1, alive: true, watered: 0 } };
    const ctx = new Ctx(state, PACK, [], []);
    tickDirections(ctx);
    assert.equal(state.directions.m1.alive, false, '第 4 天破晓即散（day1 种，day5 已过 3 天）');
    assert.ok(ctx.facts.some((f) => f.k === 'direction_faded'), '散时一笔带过');
    assert.ok(!ctx.facts.some((f) => f.k === 'direction_echo'), '杂念不再回声');
  });
});

describe('呈现撤除：今日卡不再有「种下的念头」专栏', () => {
  test('planDusk 照誓排地点的通道保留（黄金昏提级不回归）', () => {
    const s = newRun({ seed: 808 }).state;
    s.day = 2; s.phase = 'dusk';
    s.inventory.crowbar = 2;
    s.directions = { v1: { id: 'v1', text: VOW, kind: 'vow', target: 'villas', day: 1, lastDay: 1, alive: true, watered: 0 } };
    const plans = planDusk(s, PACK);
    assert.equal(plans.plans[0].intent.location, 'villas', '首选方案仍照誓走');
    assert.ok(plans.plans[0].hint.includes('誓') || plans.plans[0].hint.includes('惦记'), 'hint 注明照誓走');
  });
});
