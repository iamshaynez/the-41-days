// 夜间岔路死循环（实测截图复现）：谋士在夜卡上出的「戏文轨」选项点不动夜——
// scene 意图不清 atFork、自愈续跑被 !atFork 拦住，夜停在原地，卡原样回来；
// 玩家反复点，反复落一段戏文与玩家行，夜永不收尾。
// 规矩：方略卡（day）保留戏文轨；提问卡（夜访/黄昏）不收非答案——
// 夜卡金选项必须真能应答夜间（night_directive / night 动作 / auto_night 续跑）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, PACK } from '../helpers.js';
import { planNightStep, planDusk } from '../../packages/core/src/delegate.js';
import { validateOptions, cardBrief } from '../../packages/server/options.js';

/** 造一个停在岔路的微操夜（frontline 有警惕的巡逻兵，seed 93 与 night-flow 同源） */
function nightAtFork() {
  const { state } = newRun({ seed: 93, roster: ['anton', 'marta', 'bron'] });
  state.knownLocs.push('frontline');
  state.inventory.knife = 1;
  let s = step(state, [{ type: 'advance' }]).state;
  s.locState.frontline = { searched: {}, npcState: {}, scriptsFired: {}, firstVisit: true };
  s = step(s, [{ type: 'dusk_assign', scavenger: 'bron', location: 'frontline', gear: ['knife'], others: { anton: 'sleep', marta: 'sleep' } }, { type: 'auto_night' }]).state;
  return s;
}

describe('夜卡不收戏文：非答案不包装成选项', () => {
  test('截图原样复现：意图全被滤的「走坟文轨」在夜卡上必须整条丢弃', () => {
    const s = nightAtFork();
    assert.ok(s.night && !s.night.home, '测试前提：夜在半途');
    const out = validateOptions(PACK, s, {
      options: [{ label: '走坟文轨', hint: '她行动力仅1、皮里带风险自担', intents: [{ type: 'act', actor: 'anton', action: 'read' }] }]
    }, { card: 'night' });
    assert.equal(out.length, 0, '夜卡不收戏文兜底——修前会包成 scene 选项，点了夜不走');
  });

  test('夜卡收真答案：方针、夜动作、续跑都过', () => {
    const s = nightAtFork();
    const out = validateOptions(PACK, s, {
      options: [
        { label: '照常走完这一夜', intents: [{ type: 'night_directive', stance: 'normal', text: '照常走完这一夜' }] },
        { label: '不打扰他，接着翻', intents: [{ type: 'night', action: 'ignore', target: 'f_patrol' }, { type: 'auto_night' }] }
      ]
    }, { card: 'night' });
    assert.equal(out.length, 2, '真答案照常放出');
    assert.ok(out.every((o) => o.intents.some((i) => ['night_directive', 'night', 'auto_night'].includes(i.type))), '每个夜卡选项都要带夜间意图');
  });

  test('夜卡不收纯念头／白天动作（阶段不符的静默空转）', () => {
    const s = nightAtFork();
    const out = validateOptions(PACK, s, {
      options: [
        { label: '惦记着明天的路', intents: [{ type: 'direction', subject: 'bron', text: '明天去医棚看看药' }] }
      ]
    }, { card: 'night' });
    assert.equal(out.length, 0, '纯念头在夜卡上是「看起来能点、点了没用」的陷阱');
  });

  test('黄昏提问卡同样不收戏文兜底；方略卡（day）照收', () => {
    const { state } = newRun({ seed: 98 });
    const s = step(state, [{ type: 'advance' }]).state;
    const junk = { options: [{ label: '讲个故事宽宽心', hint: '人心也要吃饭', intents: [{ type: 'act', actor: 'anton', action: 'sleep', bad: true }] }] };
    assert.equal(validateOptions(PACK, s, junk, { card: 'dusk' }).length, 0, '黄昏是世界的问题，不收戏文非答案');
    const day = validateOptions(PACK, state, junk, { card: 'day' });
    assert.equal(day.length, 1, '方略卡保留戏文轨（设计用途：说得出口的事交给舞台接）');
    assert.equal(day[0].intents[0].type, 'scene');
    assert.match(day[0].hint, /戏文/);
  });
});

describe('黄昏卡不收非答案：守誓／改约类纯念头不留', () => {
  /** 白天收卷直落黄昏（与上面 junk 用例同一条捷径） */
  function duskState() {
    const { state } = newRun({ seed: 98 });
    return step(state, [{ type: 'advance' }]).state;
  }

  test('守誓／改约只有 direction 意图（可行但不派工）——黄昏卡必须整条丢弃', () => {
    const s = duskState();
    assert.equal(s.phase, 'dusk', '测试前提：停在黄昏');
    const out = validateOptions(PACK, s, {
      options: [
        { label: '守誓：冒雨登北津台', hint: '说出去的话要作数', intents: [{ type: 'direction', subject: 'anton', text: '冒雨登北津台' }] },
        { label: '改约', hint: '推到天晴再说', intents: [{ type: 'direction', subject: 'anton', text: '北津台的事推到天晴' }] }
      ]
    }, { card: 'dusk' });
    assert.equal(out.length, 0, '黄昏等的是派工（dusk_assign）——纯念头是「点得动、夜不开始」的陷阱（实测死循环）');
  });

  test('真派工照常放行：出门践誓与在家留守都是答案', () => {
    const s = duskState();
    s.knownLocs.push('beacon');
    const out = validateOptions(PACK, s, {
      options: [
        { label: '今晚都不出门', intents: [{ type: 'dusk_assign', scavenger: null, location: null, gear: [], others: { anton: 'sleep', marta: 'sleep' } }] },
        { label: '冒雨登北津台（践誓）', intents: [{ type: 'dusk_assign', scavenger: 'anton', location: 'beacon', gear: [], others: { marta: 'sleep' } }] },
        { label: '派工之外的杂念', intents: [{ type: 'dusk_assign', scavenger: 'anton', location: 'beacon', gear: [], others: {} }, { type: 'direction', subject: 'anton', text: '看好台上的柴' }] }
      ]
    }, { card: 'dusk' });
    assert.equal(out.length, 3, '带 dusk_assign 的选项（哪怕附带念头）都过');
  });

  test('内核行为锚定：黄昏只有 direction 意图时 phase 不动（这就是循环本身），dusk_assign 才入夜', () => {
    let s = duskState();
    s = step(s, [{ type: 'direction', subject: 'anton', text: '冒雨登北津台' }]).state;
    assert.equal(s.phase, 'dusk', '念头不派工——黄昏还在原地等答案');
    s = step(s, [{ type: 'dusk_assign', scavenger: null, location: null, gear: [], others: {} }]).state;
    assert.notEqual(s.phase, 'dusk', '派了工夜才开始/收尾');
  });

  test('黄昏提示词写明派工契约（dusk_assign 单意图 + 践誓指引）——删了契约模型就会拿念头凑数', () => {
    const s = duskState();
    const brief = cardBrief(s, PACK, 'dusk');
    assert.match(brief, /"type":"dusk_assign"/, '黄昏卡提示词必须给出 dusk_assign 意图格式');
    assert.match(brief, /黄昏不收 direction/, '念头白天说的规矩要写明');
  });
});

describe('内核行为锚定：岔路等的是答案，戏文不替玩家答', () => {
  test('夜停岔路时 scene 意图不推进夜——岔路仍在原地等（修的是选项包装，不是替答）', () => {
    let s = nightAtFork();
    const stopBefore = planNightStep(s, PACK, { approach: s.night.directive?.stance })?.stop?.kind;
    assert.ok(stopBefore, '测试前提：停在岔路上');
    const r = step(s, [{ type: 'scene', text: '薄姑贴着墙走，心里的算盘打得比脚步还响' }]);
    s = r.state;
    assert.ok(s.night && !s.night.home, '夜还在半途');
    assert.ok(s.night.atFork, '岔路未被戏文解除——道德与安全的决断永远归玩家');
    const stopAfter = planNightStep(s, PACK, { approach: s.night.directive?.stance })?.stop?.kind;
    assert.equal(stopAfter, stopBefore, '停点原样');
  });

  test('真答案（ignore + auto_night）一击走掉：同批续跑到下一停点或收尾', () => {
    let s = nightAtFork();
    const r = step(s, [{ type: 'night', action: 'ignore', target: 'f_patrol' }, { type: 'auto_night' }]);
    assert.ok(r.facts.some((f) => f.k === 'night_ignore'), '应答生效');
    assert.ok(
      r.facts.some((f) => f.k === 'night_fork') || r.state.phase !== 'night' || !r.state.night,
      '同批输入里夜要接着走（不弹回同一张卡）'
    );
  });
});
