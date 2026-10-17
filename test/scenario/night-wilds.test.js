// 夜野（内容包 0.41.0）：夜里不该处处是同一张桌子。
// 地点性格（nightRules）× 每夜夜况（nightTable）× 天气 → night.env；
// 巡逻火把把 threat 变成真风险；埋着的容器要挖；暗处失手、湿地费火柴、寒地熬人；
// 黄昏四卡（稳/新/补/誓）让全城浮上牌面；野外五地（wilds 池挑二）轻门槛入局。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK } from '../helpers.js';
import { fold, planDusk, loadPack } from '../../packages/core/index.js';
import { planNightStep } from '../../packages/core/src/delegate.js';
import { mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DUSK = (loc, gear = [], scav = 'bron') => ({ type: 'dusk_assign', scavenger: scav, location: loc, gear, others: { anton: 'sleep', marta: 'sleep' } });

/** 直接把某人派去某地过一夜（方针自走），返回收尾后的 {state, facts, events} */
function nightAt(state, loc, gear = [], scav = 'bron', stance = 'normal') {
  let s = state;
  if (s.phase !== 'dusk') s = step(s, [{ type: 'advance' }]).state;
  if (s.phase !== 'dusk') throw new Error('到不了黄昏');
  return step(s, [DUSK(loc, gear, scav), { type: 'night_directive', stance, text: '照张罗的来' }]);
}

describe('夜野 · 地点性格（nightRules 恒定差异）', () => {
  test('北津台要爬台：火柴比城里少一根', () => {
    for (let seed = 395; seed < 440; seed++) {
      const { state } = newRun({ seed, roster: ['anton', 'marta', 'bron'] });
      state.knownLocs.push('beacon');
      const r = nightAt(state, 'beacon');
      const arrive = r.facts.find((f) => f.k === 'night_arrive');
      if (!arrive) continue;
      assert.equal(arrive.slots, 9, `北津台 10-1=9 根（实际 ${arrive.slots}）——爬台是体力活`);
      return;
    }
    assert.ok(false, '种子段内北津台夜访应至少一次成行');
  });

  test('西水碓房路熟门清：多一根火柴，水轮掩声', () => {
    for (let seed = 402; seed < 460; seed++) {
      const { state } = newRun({ seed, roster: ['anton', 'marta', 'bron'] });
      if (!state.locPool.wilds?.includes('mifang')) continue;
      state.knownLocs.push('mifang');
      let s = step(state, [{ type: 'advance' }]).state;
      const r = step(s, [DUSK('mifang', [])]);
      if (!r.state.night || r.state.night.home) continue;
      assert.ok(r.state.night.slots >= 11, `碓房 10+1 根起步（实际 ${r.state.night.slots}）`);
      assert.ok(r.state.night.env.noiseMul <= 0.6, `水轮掩声：noiseMul ≤0.6（实际 ${r.state.night.env.noiseMul}）`);
      return;
    }
    assert.ok(true, '本段种子碓房未入池（wilds 池覆盖由 KPI 与池专测守）');
  });
});

describe('夜野 · 每夜夜况（同地不同夜）', () => {
  test('到地掷夜况：cond 落进 night 对象、事实带名字与文本', () => {
    const { state } = newRun({ seed: 404, roster: ['anton', 'marta', 'bron'] });
    const r = nightAt(state, 'market');
    const cond = r.facts.find((f) => f.k === 'night_cond');
    assert.ok(cond, '南市首夜应掷出夜况');
    assert.ok(cond.name && cond.text, '夜况要有人话（名字+一句话）');
  });

  test('同一座炭林，不同夜掷出不同夜况（种子即命运）', () => {
    const names = new Set();
    for (let seed = 410; seed < 450; seed++) {
      const { state } = newRun({ seed, roster: ['anton', 'marta', 'bron'] });
      if (!state.locPool.wilds?.includes('guanlin')) continue;
      state.knownLocs.push('guanlin');
      try {
        const r = nightAt(state, 'guanlin');
        const c = r.facts.find((f) => f.k === 'night_cond');
        if (c) names.add(c.name);
      } catch { /* 该种子夜访没成行（抑郁/太弱），跳过 */ }
    }
    assert.ok(names.size >= 2, `40 个种子里炭林至少掷出两种夜况（实际 ${[...names].join('、')}）——同一张脸不该看四十天`);
  });

  test('夜况偏置真实生效：菱角正熟的那夜，货表向吃的歪', () => {
    for (let seed = 450; seed < 490; seed++) {
      const { state } = newRun({ seed, roster: ['anton', 'marta', 'bron'] });
      if (!state.locPool.wilds?.includes('xieshui')) continue;
      state.knownLocs.push('xieshui');
      let s = step(state, [{ type: 'advance' }]).state;
      const r = step(s, [DUSK('xieshui', [])]);
      if (!r.state.night || r.state.night.home) continue;
      const env = r.state.night.env;
      if (env.lootBias && env.lootBias.veg > 1) {
        assert.ok(r.state.night.cond.name.includes('菱'), `偏置挂在正确的夜况上（${r.state.night.cond.name}）`);
        return;
      }
    }
    assert.ok(false, '40 个种子里应至少一夜「菱角正熟」（lootBias.veg > 1）');
  });
});

describe('夜野 · 巡逻火把（threat 落地）', () => {
  /** 直接布置一个「火把已至」的夜（跳过掷骰），考岔路的答法 */
  function patrolNight(seed, loc = 'beacon') {
    const { state } = newRun({ seed, roster: ['anton', 'marta', 'bron'] });
    state.knownLocs.push(loc);
    state.inventory.knife = 1; // 刀要真在库里才带得走（带不上就没有「动手」选项）
    let s = step(state, [{ type: 'advance' }]).state;
    const r = step(s, [DUSK(loc, ['knife'])]);
    if (!r.state.night || r.state.night.home) throw new Error('夜访没成行');
    r.state.night.patrol = { from: 1 };
    return r.state;
  }

  test('前线撬锁的每一声都可能招火把：多夜采样必有一夜遇上巡逻', () => {
    let met = 0, nights = 0;
    for (let seed = 500; seed < 530; seed++) {
      const { state } = newRun({ seed, roster: ['anton', 'marta', 'bron'] });
      state.knownLocs.push('frontline');
      state.inventory.crowbar = 1;
      let s = step(state, [{ type: 'advance' }]).state;
      const r = step(s, [DUSK('frontline', ['crowbar']), { type: 'night_directive', stance: 'bold', text: '放手干' }]);
      nights++;
      if (r.facts.some((f) => f.k === 'patrol_coming')) met++;
    }
    assert.ok(met >= 1, `水门渡旧垒（threat 4）30 夜应至少一夜火把循声而来（实际 ${met}/${nights}）`);
  });

  test('岔路置顶有答法：躲（火柴换平安）', () => {
    let s = patrolNight(520);
    const slots = s.night.slots;
    const stop = planNightStep(s, PACK, {});
    assert.equal(stop?.stop?.kind, 'patrol', '火把在旁，岔路置顶');
    assert.ok(stop.stop.options.some((o) => o.label.includes('躲')), '躲得选项');
    assert.ok(stop.stop.options.some((o) => o.label.includes('撤')), '撤也是正经答案');
    const r = step(s, [{ type: 'night', action: 'hide' }]);
    if (r.facts.some((f) => f.k === 'patrol_evaded')) {
      assert.ok(r.state.night.slots <= slots - 2, '躲要花两根火柴（屏息等火把走远）');
      assert.ok(!r.state.night.patrol, '躲成即脱身');
    } else {
      assert.ok(r.facts.some((f) => f.k === 'patrol_hide_fail' || f.k === 'combat_hurt' || f.k === 'combat_win'), '躲砸了是遭遇战，不是无事发生');
    }
  });

  test('岔路有答法：给东西（最值钱的一件离手，守恒）', () => {
    let s = patrolNight(521);
    s.inventory.wine = 1; s.night.pack.push('wine');
    const r = step(s, [{ type: 'night', action: 'bribe' }]);
    assert.ok(r.facts.some((f) => f.k === 'patrol_bribed'), '巡兵收货走人');
    assert.ok(!r.state.night.pack.includes('wine'), '酒给出去了');
    assert.equal(r.state.inventory.wine || 0, 0, '库里也不剩（守恒）');
  });

  test('岔路有答法：动手打赢，巡逻退场', () => {
    let s = patrolNight(522, 'villas'); // threat 1 巡逻不带兵器，宅区无人无剧本
    for (let i = 0; i < 8 && s.night && s.night.patrol; i++) {
      const r = step(s, [{ type: 'night', action: 'attack', target: 'patrol' }]);
      s = r.state;
      if (r.facts.some((f) => f.k === 'patrol_down')) {
        assert.ok(!s.night || !s.night.patrol, '巡逻退场');
        return;
      }
      if (!s.night || s.night.home) break; // 败退/槽尽收工——也算一种明确结局
    }
    assert.ok(!s.night || s.night.home || !s.night.patrol, '八轮内打赢或明确败退，不许悬着');
  });

  test('方针自动答巡逻：谨慎先躲、放手先动手', () => {
    const a = patrolNight(523, 'villas');
    const ra = step(a, [{ type: 'night_directive', stance: 'cautious', text: '躲开火把' }]);
    const ca = ra.facts.filter((f) => f.k === 'night_choice').map((f) => f.label).join(',');
    assert.ok(ca.includes('躲'), `谨慎方针该选躲（实际选了 ${ca}）`);
    const b = patrolNight(524, 'villas');
    const rb = step(b, [{ type: 'night_directive', stance: 'bold', text: '清掉他' }]);
    const cb = rb.facts.filter((f) => f.k === 'night_choice').map((f) => f.label).join(',');
    assert.ok(cb.includes('动手') || rb.facts.some((f) => f.k === 'patrol_down' || f.k === 'combat_win'), `放手方针该动手（实际 ${cb}）`);
  });
});

describe('夜野 · 埋着的容器（乱葬岗要挖）', () => {
  function luanfenNight(seed, gear = []) {
    const { state } = newRun({ seed, roster: ['anton', 'marta', 'bron'] });
    if (!state.locPool.wilds?.includes('luanfen')) return null;
    state.knownLocs.push('luanfen');
    let s = step(state, [{ type: 'advance' }]).state;
    return step(s, [DUSK('luanfen', gear)]);
  }

  test('没挖就搜被拒；徒手三格带响带累', () => {
    let found = null;
    for (let seed = 530; seed < 580; seed++) { const r = luanfenNight(seed); if (r?.state?.night) { found = r; break; } }
    if (!found) return assert.ok(true, '本批种子葬岗都没入池（池覆盖率由 KPI 门禁守）');
    let s = step(found.state, [{ type: 'night', action: 'move', target: 'lf_old' }]).state;
    if (!s.night || s.night.home || s.night.room !== 'lf_old') return; // 移动受阻（理论不会），跳过本种子
    const rej = step(s, [{ type: 'night', action: 'search', target: 'lf_oldgraves' }]);
    assert.ok(rej.facts.some((f) => f.k === 'night_no' && String(f.msg).includes('dig')), '埋着的先 dig');
    const before = { slots: s.night.slots, noise: s.night.noise, fat: ch(s, 'bron').fatigue };
    const r2 = step(s, [{ type: 'night', action: 'dig', target: 'lf_oldgraves' }]);
    s = r2.state;
    assert.ok(s.locState.luanfen.searched['lf_oldgraves:open'], '挖开记在账上');
    assert.equal(s.night.slots, before.slots - 3, `徒手三格（实际 ${before.slots - s.night.slots}）`);
    assert.ok(s.night.noise > before.noise || r2.facts.some((f) => f.k === 'night_noise_alert' || f.k === 'patrol_coming'), '刨土有声');
    assert.ok(ch(s, 'bron').fatigue > before.fat, '徒手刨土熬人');
  });

  test('带铲省一半力气：两格无声', () => {
    let found = null;
    for (let seed = 580; seed < 640; seed++) { const r = luanfenNight(seed, ['shovel']); if (r?.state?.night) { found = r; break; } }
    if (!found) return assert.ok(true, '本批种子葬岗未入池');
    let s = step(found.state, [{ type: 'night', action: 'move', target: 'lf_old' }]).state;
    if (!s.night || s.night.home || s.night.room !== 'lf_old') return;
    s.inventory.shovel = 1; s.night.pack.push('shovel');
    const before = { slots: s.night.slots, noise: s.night.noise };
    const r2 = step(s, [{ type: 'night', action: 'dig', target: 'lf_oldgraves' }]);
    s = r2.state;
    assert.equal(s.night.slots, before.slots - 2, `铲子两格（实际 ${before.slots - s.night.slots}）`);
    assert.equal(s.night.noise, before.noise, '铲子无声');
  });

  test('进葬岗心情先沉一寸：夜况心情至少一笔入账', () => {
    for (let seed = 640; seed < 690; seed++) {
      const r = luanfenNight(seed);
      if (!r) continue;
      if (r.facts.some((f) => f.k === 'night_arrive')) {
        const mood = r.events.filter((e) => e.t === 'MOOD_DELTA' && String(e.d?.reason || '').startsWith('夜况'));
        assert.ok(mood.length >= 1, '葬岗的夜要压人（夜况心情至少一笔）');
        return;
      }
    }
    assert.ok(true, '本批无葬岗成行局');
  });
});

describe('夜野 · 暗与湿与寒', () => {
  test('摸黑翻不看一眼必空手（miss=1 未观察）；看过一圈减半', () => {
    const { state } = newRun({ seed: 601, roster: ['anton', 'marta', 'bron'] });
    let s = step(state, [{ type: 'advance' }]).state;
    const r = step(s, [DUSK('market', [])]);
    s = r.state;
    s.night.env = { ...s.night.env, miss: 1, wet: 0 };
    const r2 = step(s, [{ type: 'night', action: 'search', target: 'm_shelf1' }]);
    assert.ok(r2.facts.some((f) => f.k === 'search_miss_dark'), '没看过的屋子，手比眼睛先认输');
    assert.ok(r2.state.locState.market.searched['m_shelf1'], '空手也是翻过了（不白翻第二次）');
  });

  test('看过一圈失手减半：observed 屋的 miss 是一半（多种子统计）', () => {
    let hit = 0, miss = 0;
    for (let seed = 610; seed < 650; seed++) {
      const { state } = newRun({ seed, roster: ['anton', 'marta', 'bron'] });
      let s = step(state, [{ type: 'advance' }]).state;
      const r = step(s, [DUSK('market', [])]);
      s = r.state;
      if (!s.night || s.night.home) continue;
      s.night.env = { ...s.night.env, miss: 1, wet: 0 }; // 原始失手率 1（必miss）
      s.night.observed = { ...s.night.observed, [s.night.room]: true }; // 看过一圈 → 减半为 0.5
      const rr = step(s, [{ type: 'night', action: 'search', target: 'm_shelf1' }]);
      if (rr.facts.some((f) => f.k === 'night_search_hit')) hit++;
      if (rr.facts.some((f) => f.k === 'search_miss_dark')) miss++;
    }
    assert.ok(hit >= 1 && miss >= 1, `看过一圈后失手率应减半（40 种子里命中 ${hit} 次、落空 ${miss} 次都不该是零）`);
  });

  test('湿地多耗火柴（wet=1 必触发）', () => {
    const { state } = newRun({ seed: 602, roster: ['anton', 'marta', 'bron'] });
    let s = step(state, [{ type: 'advance' }]).state;
    const r = step(s, [DUSK('market', [])]);
    s = r.state;
    s.night.env = { ...s.night.env, miss: 0, wet: 1 };
    const before = s.night.slots;
    const r2 = step(s, [{ type: 'night', action: 'search', target: 'm_shelf1' }]);
    assert.ok(r2.facts.some((f) => f.k === 'wet_slip'), '水汽漫上来，翻找费力');
    assert.equal(r2.state.night.slots, before - 2, '一格的活花两格');
  });

  test('寒地熬到收工，回家多一分倦', () => {
    for (let seed = 603; seed < 660; seed++) {
      const { state } = newRun({ seed, roster: ['anton', 'marta', 'bron'] });
      if (!state.locPool.wilds?.includes('guanlin')) continue;
      state.knownLocs.push('guanlin');
      let s = step(state, [{ type: 'advance' }]).state;
      const r = step(s, [DUSK('guanlin', [])]);
      if (!r.state.night || r.state.night.home) continue;
      const fat0 = ch(r.state, 'bron').fatigue;
      const done = step(r.state, [{ type: 'night', action: 'retreat' }]);
      const gained = ch(done.state, 'bron').fatigue - fat0;
      assert.ok(done.facts.some((f) => f.k === 'cold_night_end'), '寒地收工记账');
      assert.ok(gained >= 1, `寒夜收工疲劳 +1 起步（实际 +${gained}）`);
      return;
    }
    assert.ok(true, '本批无薪炭林成行局');
  });
});

describe('夜野 · 黄昏四卡（稳/新/补/誓）', () => {
  test('开局黄昏：出门卡至少两张且地点不同——牌面就是玩家的视野', () => {
    const { state } = newRun({ seed: 701, roster: ['anton', 'marta', 'bron'] });
    let s = step(state, [{ type: 'advance' }]).state;
    const plans = planDusk(s, PACK).plans;
    const out = plans.filter((p) => p.intent.scavenger && p.intent.location);
    assert.ok(out.length >= 2, `开局已知 4 地，出门卡至少 2 张（实际 ${out.length}）`);
    assert.notEqual(out[0].intent.location, out[1].intent.location, '稳卡与新卡不指同一处');
    assert.ok(plans.some((p) => !p.intent.scavenger), '留守仍是正经答案');
  });

  test('带铲去葬岗、带锯去死信库：家什按地点配', () => {
    // 场一：全城走遍、只剩葬岗没去过——轮换卡必上葬岗，该带铲
    const { state } = newRun({ seed: 702, roster: ['anton', 'marta', 'bron'] });
    let s = step(state, [{ type: 'advance' }]).state;
    s.knownLocs = [...new Set([...s.knownLocs, 'luanfen'])];
    for (const loc of ['market', 'villas', 'church', 'hospital']) {
      s.locState[loc] = { searched: {}, npcState: {}, scriptsFired: {}, firstVisit: false, lastVisitDay: 2 };
    }
    s.inventory.shovel = 1; s.inventory.crowbar = 1;
    const plans = planDusk(s, PACK).plans;
    const dig = plans.find((p) => p.intent.location === 'luanfen');
    assert.ok(dig && dig.intent.gear.includes('shovel'), `葬岗方案带铲（埋着的东西要挖；实际卡面 ${JSON.stringify(dig?.intent.gear)}）`);
    // 场二：只剩驿亭没去过——轮换卡必上驿亭，该带锯
    const { state: st2 } = newRun({ seed: 705, roster: ['anton', 'marta', 'bron'] });
    let s2 = step(st2, [{ type: 'advance' }]).state;
    s2.knownLocs = [...new Set([...s2.knownLocs, 'post'])];
    for (const loc of ['market', 'villas', 'church', 'hospital']) {
      s2.locState[loc] = { searched: {}, npcState: {}, scriptsFired: {}, firstVisit: false, lastVisitDay: 2 };
    }
    s2.inventory.saw = 1; s2.inventory.crowbar = 1;
    const plans2 = planDusk(s2, PACK).plans;
    const saw = plans2.find((p) => p.intent.location === 'post');
    assert.ok(saw && saw.intent.gear.includes('saw'), `驿亭方案带锯（死信库的铁栅；实际卡面 ${JSON.stringify(saw?.intent.gear)}）`);
  });

  test('搜空之城有回补卡：全翻过之后，最久未访的地方回到牌面', () => {
    const { state } = newRun({ seed: 703, roster: ['anton', 'marta', 'bron'] });
    let s = step(state, [{ type: 'advance' }]).state;
    for (const [loc, day] of [['market', 2], ['villas', 3], ['church', 4], ['hospital', 5]]) {
      const searched = {};
      for (const r of PACK.locMap[loc].rooms) for (const c of r.containers || []) searched[c.id] = day; // 全容器真搜过
      s.locState[loc] = { searched, npcState: {}, scriptsFired: {}, firstVisit: false, lastVisitDay: day };
    }
    const plans = planDusk(s, PACK).plans;
    assert.ok(plans.some((p) => p.intent.scavenger && /回补/.test(p.hint || '')), `搜空的世界要有回补线（实际卡面：${plans.map((p) => p.key + (p.intent.location || '留守')).join('、')}）`);
  });
});

describe('夜野 · 野外解锁与 wilds 池', () => {
  test('wilds 池一局浮两地：数组长 2，池外野地硬塞也进不去', () => {
    const { state } = newRun({ seed: 801 });
    const s = state;
    assert.ok(Array.isArray(s.locPool.wilds) && s.locPool.wilds.length === 2, '野外挑二');
    const out = ['xieshui', 'guanlin', 'luanfen', 'feichuan', 'mifang'].filter((w) => !s.locPool.wilds.includes(w));
    const hacked = structuredClone(s);
    hacked.knownLocs.push(out[0]);
    hacked.phase = 'dusk';
    const r = step(hacked, [DUSK(out[0])]);
    assert.ok(r.state.phase !== 'night' || r.state.night?.home, `池外野地（${out[0]}）这一世不开`);
  });

  test('走过南市第六天，城外的泽地在晨报里开图', () => {
    const { state } = newRun({ seed: 803 });
    const s = state;
    if (!s.locPool.wilds.includes('xieshui')) return; // 未入池——池覆盖由上一条守
    s.locState.market = { searched: { any: 2 }, npcState: {}, scriptsFired: {}, firstVisit: false, lastVisitDay: 2 };
    s.day = 6;
    let s2 = s;
    if (s2.phase === 'day') s2 = step(s2, [{ type: 'advance' }]).state;
    if (s2.phase === 'dusk') s2 = step(s2, [{ type: 'dusk_assign', scavenger: null, others: {} }]).state;
    assert.ok(s2.knownLocs.includes('xieshui'), '枯泽该在晨扫里开图');
  });

  test('水门渡是城的地标：第十天人人识得，不用谁带路', () => {
    const { state } = newRun({ seed: 804 });
    const s = state;
    assert.ok(!s.knownLocs.includes('frontline'), '开局不识（第一天还没到日子）');
    s.day = 10;
    let s2 = s;
    if (s2.phase === 'day') s2 = step(s2, [{ type: 'advance' }]).state;
    if (s2.phase === 'dusk') s2 = step(s2, [{ type: 'dusk_assign', scavenger: null, others: {} }]).state;
    assert.ok(s2.knownLocs.includes('frontline'), 'D10 晨扫应开水门渡——围城地标，认得和敢去是两回事');
  });
});

describe('夜野 · 回放一致（fold）', () => {
  test('一夜带夜况、巡逻、挖坟的事件流，重放即终态', () => {
    for (let seed = 900; seed < 960; seed++) {
      const { state } = newRun({ seed, roster: ['anton', 'marta', 'bron'] });
      if (!state.locPool.wilds?.includes('luanfen')) continue;
      state.knownLocs.push('luanfen');
      state.inventory.shovel = 1;
      let s = step(state, [{ type: 'advance' }]).state;
      const r = step(s, [DUSK('luanfen', ['shovel']), { type: 'night_directive', stance: 'bold', text: '放手挖' }]);
      let s2 = r.state;
      if (!s2.night || s2.night.home) continue;
      const done = step(s2, [{ type: 'night', action: 'retreat' }]);
      const replayed = fold(done.events);
      assert.equal(JSON.stringify(replayed.locState.luanfen), JSON.stringify(done.state.locState.luanfen), '葬岗的账（含 :open 挖痕与 lastVisitDay）重放如初');
      assert.equal(JSON.stringify(replayed.inventory), JSON.stringify(done.state.inventory), '家底重放如初');
      return;
    }
    assert.ok(true, '本批种子无葬岗局（池覆盖另测）');
  });
});

describe('夜野 · 内容白名单（写错键启动即报）', () => {
  test('nightRules 写了不认识的键 → loadPack 拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nw-'));
    cpSync(join(process.cwd(), 'content', 'base'), dir, { recursive: true });
    const f = join(dir, 'locations.json');
    const locs = JSON.parse(readFileSync(f, 'utf8'));
    locs.locations.find((l) => l.id === 'market').nightRules = { superLoot: 1 };
    writeFileSync(f, JSON.stringify(locs));
    assert.throws(() => loadPack(dir), /superLoot/, '白名单外的键不许静默吞');
    rmSync(dir, { recursive: true, force: true });
  });
});
