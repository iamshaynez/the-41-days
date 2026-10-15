// 夜行节奏与回应（夜间双模修复批次）：
// 1) 一键方针不该被「零风险弃夜选项」截胡成进门即撤退（南市首访实测：照常/谨慎都整夜零探索）；
// 2) 谨慎方针「见人就绕」应绕开（ignore）而不是弃夜 retreat；
// 3) 微操夜答完一个岔路选项，同一批输入里夜要自己接着走（不逼玩家点「继续摸黑前进」）；
// 4) 念头（种下的方向）要点进黄昏方案卡——世界记着，管家也要记着；
// 5) 世界简报把待决事件/岔路的选项摆给裁判（自由文本才答得对题）；
// 6) 手动夜间动作不谎报微操（回放与活局一致）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, PACK } from '../helpers.js';
import { fold } from '../../packages/core/index.js';
import { planDusk } from '../../packages/core/src/delegate.js';
import { worldBrief } from '../../packages/server/narrate.js';

const DUSK = (loc, gear = []) => ({ type: 'dusk_assign', scavenger: 'bron', location: loc, gear, others: { anton: 'sleep', marta: 'sleep' } });

describe('方针夜：一次决策走完整夜', () => {
  test('照常方针到了南市：真去搜，不进门就「退出南市」', () => {
    const { state } = newRun({ seed: 91, roster: ['anton', 'marta', 'bron'] });
    let s = state;
    s.inventory.crowbar = 1;
    s = step(s, [{ type: 'advance' }]).state;
    // 黄昏方案卡按钮的真实意图序列：指派 + 方针，一批走完
    const r = step(s, [DUSK('market', ['crowbar']), { type: 'night_directive', stance: 'normal', text: '照常走一遭' }]);
    const end = r.facts.find((f) => f.k === 'night_end');
    assert.ok(end, '夜访应正常收尾');
    assert.notEqual(end.reason, 'abort', `照常方针不该进门就撤退（实际收尾原因：${end.reason}）`);
    const choice = r.facts.find((f) => f.k === 'night_choice');
    assert.ok(!choice || !String(choice.label).includes('退出'), `事件应答不该是弃夜选项：${choice?.label}`);
    assert.ok(
      r.facts.some((f) => ['night_search_hit', 'search_miss', 'night_move', 'night_open_container', 'night_unlock'].includes(f.k)),
      '整夜应有探索动作（实测修前：到达→自动退出，零探索）'
    );
  });

  test('谨慎方针遇上警惕的人：绕开继续，不是整夜撤退', () => {
    const { state } = newRun({ seed: 92, roster: ['anton', 'marta', 'bron'] });
    state.knownLocs.push('frontline');
    state.inventory.knife = 1;
    // 预置敌意巡逻兵已照面——这条岔路只考「警惕的人」（bailing）那一位
    let s = step(state, [{ type: 'advance' }]).state;
    s.locState.frontline = { searched: {}, npcState: { f_patrol: 'ignored' }, scriptsFired: {}, firstVisit: true };
    const r = step(s, [DUSK('frontline', ['knife']), { type: 'night_directive', stance: 'cautious', text: '不出声，见人就绕' }]);
    assert.ok(r.facts.some((f) => f.k === 'night_ignore'), '谨慎方针见人就绕 = ignore，接着翻');
    const end = r.facts.find((f) => f.k === 'night_end');
    assert.ok(end, '夜访应正常收尾');
    assert.notEqual(end.reason, 'abort', `不该弃夜撤退（实际：${end.reason}）`);
  });

  test('米缸卡（s_looter）必须有一条零风险、不弃夜的路', () => {
    const card = PACK.cardMap.s_looter;
    assert.ok(card, 's_looter 卡在册');
    const road = (card.options || []).find((o) => !o.riskCheck && !(o.cost || []).length && !o.effects?.abortNight);
    assert.ok(road, '照常/谨慎立场的自动应答需要一条「绕开继续搜」的路，否则到达即撤退');
  });
});

describe('微操夜：岔路答完自己接着走', () => {
  test('答完「上前说话」，同批输入里夜自动续跑到下一停点', () => {
    const { state } = newRun({ seed: 93, roster: ['anton', 'marta', 'bron'] });
    state.knownLocs.push('frontline');
    state.inventory.knife = 1;
    let s = step(state, [{ type: 'advance' }]).state;
    s.locState.frontline = { searched: {}, npcState: {}, scriptsFired: {}, firstVisit: true };
    s = step(s, [DUSK('frontline', ['knife'])]).state;
    // 自己走：停在第一个岔路（f_patrol）
    const r1 = step(s, [{ type: 'auto_night' }]);
    assert.ok(r1.facts.some((f) => f.k === 'night_fork'), '微操流应停在岔路');
    assert.ok(r1.state.night && !r1.state.night.home, '夜还在半途');
    // 玩家点「上前说话」——按钮只发一个单步 dialogue 意图
    const r2 = step(r1.state, [{ type: 'night', action: 'dialogue', target: 'f_patrol' }]);
    assert.ok(r2.facts.some((f) => f.k === 'night_dialogue'), '说话这一步应执行');
    assert.ok(
      r2.facts.some((f) => f.k === 'night_fork' || f.k === 'night_end'),
      '同一批输入里夜要接着走（下一岔路或收尾）——修前会停在原地等玩家再点「继续」'
    );
  });

  test('同一岔路只问一次（night_fork 不重复落账）', () => {
    const { state } = newRun({ seed: 933, roster: ['anton', 'marta', 'bron'] });
    state.knownLocs.push('frontline');
    state.inventory.knife = 1;
    let s = step(state, [{ type: 'advance' }]).state;
    s.locState.frontline = { searched: {}, npcState: {}, scriptsFired: {}, firstVisit: true };
    s = step(s, [DUSK('frontline', ['knife'])]).state;
    // 连发两个 auto_night（岔路选项自带续跑的场景）：停在岔路后不重复记账
    const r = step(s, [{ type: 'auto_night' }, { type: 'auto_night' }]);
    const forks = r.facts.filter((f) => f.k === 'night_fork');
    assert.equal(forks.length, 1, '同一岔路只问一次');
    assert.ok(r.state.night?.atFork, '停在岔路的状态要可见');
  });
});

describe('念头进方案卡：世界记着，管家也记着', () => {
  test('惦记大族宅区带铁撬——黄昏首选方案照念头走', () => {
    const { state } = newRun({ seed: 94, roster: ['anton', 'marta', 'bron'] });
    state.inventory.crowbar = 2;
    const seeded = step(structuredClone(state), [{ type: 'direction', subject: null, text: '带铁撬去大族宅区拆可用的板材木料' }]).state;
    const plans = planDusk(seeded, PACK);
    assert.equal(plans.plans[0].intent.location, 'villas', '首选方案应照念头去大族宅区');
    assert.ok(plans.plans[0].intent.gear.includes('crowbar'), '应带上铁撬');
    assert.ok(/誓|惦记/.test(plans.plans[0].hint), `hint 应注明这是照着誓走：${plans.plans[0].hint}`);
    // 对照：没种念头时，首选仍是常规排序（南市在前）
    const control = planDusk(state, PACK);
    assert.equal(control.plans[0].intent.location, 'market', '无念头时按常规排序');
  });

  test('念头点名的人手（大柯式托付）：不出现在默认三人局的方案里也不报错', () => {
    const { state } = newRun({ seed: 941, roster: ['anton', 'marta', 'bron'] });
    const seeded = step(state, [{ type: 'direction', subject: 'marta', text: '辛夷想替这个家扛料，走一趟医棚' }]).state;
    const plans = planDusk(seeded, PACK);
    assert.ok(plans.plans.length >= 2, '方案卡照常出牌');
    assert.ok(plans.plans[0].intent.location === 'hospital' || plans.plans.some((p) => p.intent.location === 'hospital'), '点名的地点应进方案');
  });

  test('一句话点名两处（去宅区……回里社）：最早提及的是目的地', () => {
    // 玩家原话（见晨报种子卡）：「带铁撬去大族宅区拆可用的板材木料，天黑前回府库里社」
    const { state } = newRun({ seed: 942, roster: ['anton', 'marta', 'bron'] });
    const seeded = step(state, [{ type: 'direction', subject: null, text: '带铁撬去大族宅区拆可用的板材木料，天黑前回府库里社' }]).state;
    const plans = planDusk(seeded, PACK);
    assert.equal(plans.plans[0].intent.location, 'villas', '目的地是最早提及的大族宅区，不是返程路过的里社');
  });
});

describe('世界简报：把待决的选项摆给裁判', () => {
  test('夜间待决事件的选项 key/label 进简报', () => {
    const { state } = newRun({ seed: 95, roster: ['anton', 'marta', 'bron'] });
    let s = step(state, [{ type: 'advance' }]).state;
    s = step(s, [DUSK('market')]).state; // 首访触发米缸卡
    assert.ok(s.activeEvent, '应触发米缸卡');
    const brief = worldBrief(s, PACK);
    assert.ok(brief.includes('share='), '选项 key 应进简报（裁判才有得对）');
    assert.ok(brief.includes('放下食物') && brief.includes('退出南市'), '选项 label 应进简报');
  });

  test('夜间岔路（未决 NPC）的选项也进简报', () => {
    const { state } = newRun({ seed: 96, roster: ['anton', 'marta', 'bron'] });
    state.knownLocs.push('frontline');
    state.inventory.knife = 1;
    let s = step(state, [{ type: 'advance' }]).state;
    s.locState.frontline = { searched: {}, npcState: {}, scriptsFired: {}, firstVisit: true };
    s = step(s, [DUSK('frontline', ['knife'])]).state;
    const brief = worldBrief(s, PACK);
    assert.ok(brief.includes('上前说话'), '岔路选项 label 应进简报');
    assert.ok(/岔路/.test(brief), '应标明这是待答的岔路');
  });
});

describe('回放一致：手动夜间动作不谎报微操', () => {
  test('活状态与 fold 回放的 night.micro 一致', () => {
    const { state, events } = newRun({ seed: 97, roster: ['anton', 'marta', 'bron'] });
    let s = step(state, [{ type: 'advance' }]).state;
    const r1 = step(s, [DUSK('villas')]);
    const r2 = step(r1.state, [{ type: 'night', action: 'search' }]); // 纯手动一步，不带 auto
    assert.ok(r2.state.night && !r2.state.night.home, '夜还在进行');
    assert.ok(!r2.state.night.micro, '手动一步不等于切换微操模式');
    const evs = [...events, ...r1.events, ...r2.events];
    const idx = evs.map((e) => e.t).lastIndexOf('NIGHT_PATCH');
    const replay = fold(evs.slice(0, idx + 1));
    assert.equal(replay.night?.micro ?? false, r2.state.night.micro ?? false, '回放与活局的 micro 口径要一致（修前回放被硬编码成 true）');
  });
});

describe('场景：微操夜的逃生门——剩下的一夜交给方针', () => {
  test('微操夜停在岔路时切方针：一击走完剩余整夜（老记录续玩同享）', () => {
    // 找一个「自己走」入夜后真的停在夜里的种子（事件卡或岔路都算停）
    for (let seed = 400; seed <= 440; seed++) {
      const { state } = newRun({ seed });
      let s = state;
      const take = (intents) => { const r = step(s, intents); s = r.state; return r; };
      if (s.activeEvent) { const c = PACK.cardMap[s.activeEvent.cardId]; take([{ type: 'event_choice', option: c?.options?.[0]?.key || 'a' }]); }
      take([{ type: 'advance' }]); // D1 白天收卷 → 黄昏
      if (s.phase !== 'dusk') continue;
      const plans = planDusk(s, PACK).plans.filter((p) => p.intent.scavenger);
      if (!plans.length) continue;
      take([plans[0].intent, { type: 'auto_night' }]); // 「自己走」微操入夜
      if (s.phase !== 'night' || !s.night || s.night.home) continue;
      if (!s.activeEvent && !s.night.atFork) take([{ type: 'auto_night' }]); // 走到第一个停点
      if (s.phase !== 'night' || !s.night || s.night.home) continue; // 这个种子夜一口气走完了，换下一个
      const slotsBefore = s.night.slots;
      take([{ type: 'night_directive', stance: 'normal', text: '剩下的一夜照常走' }]);
      assert.notEqual(s.phase, 'night', '交方针后当批就该走完整夜');
      assert.ok(!s.night || s.night.home, '夜应收工回家');
      assert.ok(s.day >= 2, '应已破晓次日');
      assert.ok(s.night === null || s.night.slots <= slotsBefore);
      return;
    }
    assert.ok(false, '40 个种子里没造出微操夜停点');
  });
});
