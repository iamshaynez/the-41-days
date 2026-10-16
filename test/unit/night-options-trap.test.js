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
import { describeIntent } from '../../packages/server/narrate.js';

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

  test('已了结的话头亮给谋士：回应卡发过（卡级在册）→ 日/黄昏两卡都点名「别再出相关选项」', () => {
    const s = duskState();
    s.firedOnce = { ...s.firedOnce, hs_beacon: true };
    for (const card of ['day', 'dusk']) {
      const brief = cardBrief(s, PACK, card);
      assert.match(brief, /已了结的话头/, `${card} 卡要有已了结清单`);
      assert.match(brief, /北津台.*别再出相关选项|别再出相关选项.*北津台/, '点名主题与禁令（谋士看着历史重提的解药）');
    }
    const clean = duskState();
    assert.ok(!/已了结的话头/.test(cardBrief(clean, PACK, 'day')), '没有已了结主题时不硬塞');
  });

  test('已种下的话头亮给谋士：史种活着未发芽 → 日/黄昏点名「等发芽，别再提」（实测：谋士天天出惦记北津台、天天点了只浇水）', () => {
    const s = duskState();
    s.directions = { d1: { id: 'd1', text: '北津台该有人举火', kind: 'hist', seed: 'beacon', day: 18, lastDay: 18, alive: true, watered: 0 } };
    for (const card of ['day', 'dusk']) {
      const brief = cardBrief(s, PACK, card);
      assert.match(brief, /已种下的话头/, `${card} 卡要有已种下清单`);
      assert.match(brief, /北津台/, '点名已种主题');
    }
    const clean = duskState();
    assert.ok(!/已种下的话头/.test(cardBrief(clean, PACK, 'day')), '没有已种主题时不硬塞');
  });

  test('过窗的话头亮给谋士：明晨已出回应卡窗口 → 归入已了结（提了也长不出来）', () => {
    const s = duskState();
    s.day = 40; // hs_beacon 窗口 [29,36]：day+1 > 36
    const brief = cardBrief(s, PACK, 'day');
    assert.match(brief, /已了结的话头.*北津台|北津台.*已了结的话头/, '过窗主题按已了结压制');
  });

  test('选项对账·标签与意图一致（实测：选项、行为、结果对不上）：写着别处的地点/点错人的标签整条丢弃', () => {
    const s = duskState();
    s.knownLocs.push('hospital');
    const out = validateOptions(PACK, s, {
      options: [
        { label: '去医棚翻药', intents: [{ type: 'dusk_assign', scavenger: 'bron', location: 'market', gear: [], others: {} }] }, // 标签医棚、意图南市
        { label: '让辛夷去南市', intents: [{ type: 'dusk_assign', scavenger: 'bron', location: 'market', gear: [], others: {} }] }, // 点名辛夷、实际石大
        { label: '石大去南市搬粮', intents: [{ type: 'dusk_assign', scavenger: 'bron', location: 'market', gear: [], others: {} }] } // 对得上
      ]
    }, { card: 'dusk' });
    assert.equal(out.length, 1, '只有对得上的留下');
    assert.equal(out[0].label, '石大去南市搬粮');
  });

  test('选项对账·部分失败不静默：做不到的意图被滤后，黄昏整条丢弃、白天加注「已略去」', () => {
    const s = duskState();
    const out = validateOptions(PACK, s, {
      options: [
        { label: '去南市搬粮捎带治疗', intents: [
          { type: 'dusk_assign', scavenger: 'bron', location: 'market', gear: [], others: {} },
          { type: 'act', actor: 'bron', action: 'treat', target: 'bandage' } // 黄昏不可行，会被滤
        ] }
      ]
    }, { card: 'dusk' });
    assert.equal(out.length, 0, '黄昏选项被修剪过就整条丢（标签承诺的是全套）');
    const { state: ds } = newRun({ seed: 98 }); // 白天相位（今日卡的生成语境）
    ds.facilities.stove = 1; // 有灶：做饭可行；治疗（没绷带没伤员）被滤
    const day = validateOptions(PACK, ds, {
      options: [{ label: '做饭并给伤员换药', intents: [
        { type: 'act', actor: 'bron', action: 'cook' },
        { type: 'act', actor: 'bron', action: 'treat', target: 'bandage' }
      ] }]
    }, { card: 'day' });
    assert.equal(day.length, 1, '白天保留能做的部分');
    assert.match(day[0].hint, /做不到的部分已略去/, '但要说清楚砍了什么');
  });

  test('拒绝反馈带主语（describeIntent）：哪件事没成说得清', () => {
    const s = duskState();
    const d1 = describeIntent(s, PACK, { type: 'dusk_assign', scavenger: 'bron', location: 'market', gear: [], others: {} });
    assert.match(d1, /石大.*南市/, '黄昏指派有人名有地名');
    const d2 = describeIntent(s, PACK, { type: 'act', actor: 'marta', action: 'treat', target: 'bandage' });
    assert.match(d2, /辛夷.*治/, '白昼动作有人名有动词');
    const d3 = describeIntent(s, PACK, { type: 'dusk_assign', scavenger: null, location: null, gear: [], others: {} });
    assert.match(d3, /留守/, '留守派派也叫留守');
  });

  test('饥荒警报进黄昏简报：只剩 N 顿时点明「出门的人必须去富粮的地方」', () => {
    const s = duskState();
    for (const k of ['meal', 'canned', 'raw', 'meat', 'veg']) s.inventory[k] = 0;
    s.inventory.raw = 2; // 3 张嘴 ≈ 0.7 天
    const brief = cardBrief(s, PACK, 'dusk');
    assert.match(brief, /只剩约 \d+ 顿口粮/, '警报带顿数');
    assert.match(brief, /富粮/, '指明方向');
    const day = cardBrief(s, PACK, 'day');
    assert.ok(!/未践的誓：「/.test(day), '不再给谋士可抄写的誓文本');
  });

  test('危机过滤：断粮 ≤2 顿时，黄昏金选项砍掉留守与非粮地，白天砍掉纯念头类', () => {
    const s = duskState();
    for (const k of ['meal', 'canned', 'raw', 'meat', 'veg']) s.inventory[k] = 0;
    s.inventory.raw = 2;
    s.knownLocs.push('hospital', 'sewer');
    const out = validateOptions(PACK, s, {
      options: [
        { label: '今晚都不出门', intents: [{ type: 'dusk_assign', scavenger: null, location: null, gear: [], others: {} }] },
        { label: '去医棚翻药', intents: [{ type: 'dusk_assign', scavenger: 'bron', location: 'hospital', gear: [], others: {} }] },
        { label: '去南市搬粮', intents: [{ type: 'dusk_assign', scavenger: 'bron', location: 'market', gear: [], others: {} }] },
        { label: '再许一遍那个誓', intents: [{ type: 'direction', subject: 'bron', text: '一定要找到吃的' }] }
      ]
    }, { card: 'dusk' });
    assert.ok(out.some((o) => o.label === '去南市搬粮'), '富粮地保留');
    assert.ok(!out.some((o) => o.label === '今晚都不出门'), '饥荒夜不留守选项');
    assert.ok(!out.some((o) => o.label === '去医棚翻药'), '零粮地砍掉');
    assert.ok(!out.some((o) => o.label === '再许一遍那个誓'), '纯念头砍掉');
    const day = validateOptions(PACK, s, { options: [{ label: '惦记着那个誓', intents: [{ type: 'direction', subject: 'bron', text: '守约' }] }] }, { card: 'day' });
    assert.equal(day.length, 0, '白天饥荒不出纯念头选项');
  });

  test('黄昏简报标注搜空地点：全容器搜过的地点标「已搜空，别当正经去处反复派」', () => {
    const s = duskState();
    const loc = PACK.locMap.market;
    const conts = (loc.rooms || []).flatMap((r) => r.containers || []);
    assert.ok(conts.length > 0, '前提：南市有容器');
    s.locState.market = { searched: Object.fromEntries(conts.map((c) => [c.id, s.day])), npcState: {} };
    const brief = cardBrief(s, PACK, 'dusk');
    assert.match(brief, /南市（[^）]*已搜空——重访才有回补/, '搜空地点带标注（产出线在前、搜空标记随内；指路重访，不是劝退——回补只在到达时掷骰）');
    assert.match(brief, /夜里出门只能一个人/, '夜路单人规矩写明（「大家都出去」的期望管理）');
    const clean = duskState();
    assert.ok(!/已搜空/.test(cardBrief(clean, PACK, 'dusk')), '没搜过/没搜空的地点不标');
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
