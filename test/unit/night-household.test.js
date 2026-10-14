// 夜之家政（内核设计 v0.1 §2.4 F 系落地 + 三处潜伏修复）：
// 1) F-03 恢复：安睡过夜 −1（地板）/−2（睡床，床位够）；守卫换守半宿 −1
// 2) F-05 排班：床位数 ≥ 睡床人数（不足者优先给卧床/重伤病/最累者）；守卫安静夜睡椅打盹净零
// 3) 修复：advanceDay 先于 tickHealth 清 bedRest/guardTonight —— 卧床养伤的破晓恢复从未生效（rested 恒 false）
// 4) 排班疲劳感知：planDusk 不选疲惫者守卫；planDay 给力竭者排卧床
// 5) P2 换守：夜访者提前收工回家接守，原守卫睡后半宿
// 6) P1 物资参数住内容包：lootRolls/lootHitChance/refillMinDays/refillChance
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK } from '../helpers.js';
import { resolveInput, Ctx, fold } from '../../packages/core/index.js';
import { planDusk, planDay, nightHomeView } from '../../packages/core/src/delegate.js';
import { tickFatigue } from '../../packages/core/src/vitals.js';

const STAY = { type: 'dusk_assign', scavenger: null, others: {} };
const toNight = (s) => step(s, [{ type: 'advance' }]).state; // 白天 → 黄昏

describe('F-03 安睡恢复：夜是三口人的夜', () => {
  test('无床安睡 −1；床位不足时最累者优先得床 −2', () => {
    let s = newRun({ seed: 201 }).state;
    s = toNight(s);
    ch(s, 'anton').fatigue = 2; ch(s, 'marta').fatigue = 2;
    s.facilities.bed = 1; // 一张床，两个疲惫的人
    s = step(s, [STAY]).state;
    const heals = [ch(s, 'anton').fatigue, ch(s, 'marta').fatigue];
    assert.deepEqual(heals.sort(), [0, 1], '得床者 −2（2→0），地板者 −1（2→1）');
  });

  test('安睡恢复落账（FATIGUE_CHANGED 带 why）+ 事实供叙事', () => {
    let s = newRun({ seed: 202 }).state;
    s = toNight(s);
    ch(s, 'anton').fatigue = 1;
    s.facilities.bed = 1;
    const r = step(s, [STAY]);
    const ev = r.events.find((e) => e.t === 'FATIGUE_CHANGED' && e.d.char === 'anton');
    assert.ok(ev, '恢复要落事件账');
    assert.equal(ev.d.why, '睡床安睡');
    assert.ok(r.facts.some((f) => f.k === 'night_rest' && f.char === 'anton' && f.bed), '事实带 bed 标记');
  });

  test('修复：卧床养伤的破晓恢复真正生效（修前 rested 恒 false，伤永不好）', () => {
    let s = newRun({ seed: 203 }).state;
    s = toNight(s);
    const bron = ch(s, 'bron');
    bron.wound = 2; bron.woundTreatedDay = s.day; bron.bedRest = true; // 治过 + 卧床
    s = step(s, [STAY]).state;
    assert.equal(ch(s, 'bron').wound, 1, 'I 表 treated+rested → 伤 2→1（修前恒 2）');
  });

  test('恢复分两档：夜睡床只渐进养伤，即刻见效须白天刻意卧床', () => {
    // 两个伤员都治过、都有床睡；一个白天刻意卧床（deepRested），一个只夜睡
    let s = newRun({ seed: 213 }).state;
    s = toNight(s);
    const a = ch(s, 'anton'), b = ch(s, 'marta');
    for (const c of [a, b]) { c.wound = 2; c.woundTreatedDay = s.day; c.bedRest = false; }
    a.bedRest = true; // 白天卧床
    s.facilities.bed = 2;
    s = step(s, [STAY]).state;
    assert.equal(ch(s, 'anton').wound, 1, '治过 + 白日卧床：即刻 2→1');
    assert.equal(ch(s, 'marta').wound, 2, '治过 + 只夜睡床：渐进养（woundRestDays 推进），不当夜见效');
    assert.ok(ch(s, 'marta').woundRestDays >= 1, '渐进恢复在推进');
  });
});

describe('F-02/F-05 守夜经济：安静夜打盹净零，遇袭之夜 +1', () => {
  test('安静夜：守卫睡椅打盹，疲劳不动；夜访者照旧 +1', () => {
    let s = newRun({ seed: 204 }).state;
    s = toNight(s);
    ch(s, 'anton').fatigue = 0;
    const r = step(s, [{ type: 'dusk_assign', scavenger: null, others: { anton: 'guard' } }]);
    assert.equal(ch(r.state, 'anton').fatigue, 0, '安静夜守卫净零（F-05 睡椅抵过 F-02）');
  });

  test('遇袭之夜守卫 +1；夜访者无论静否 +1（夜访未眠）', () => {
    const { state } = newRun({ seed: 205 });
    const ctx = new Ctx(state, PACK, [], []);
    const a = ch(state, 'anton'), b = ch(state, 'marta');
    a.awakeTonight = true; b.awakeTonight = true;
    ctx.nightGuard = new Set(['anton']); ctx.outTonight = 'marta'; ctx.nightRaided = true;
    tickFatigue(ctx);
    assert.equal(a.fatigue, 1, '遇袭守卫 +1');
    assert.equal(b.fatigue, 1, '夜访者 +1');
    assert.equal(ctx.events.find((e) => e.t === 'FATIGUE_CHANGED' && e.d.char === 'marta').d.why, '夜访未眠');

    const { state: s2 } = newRun({ seed: 206 });
    const ctx2 = new Ctx(s2, PACK, [], []);
    const g = ch(s2, 'bron');
    g.awakeTonight = true; ctx2.nightGuard = new Set(['bron']); ctx2.outTonight = null; ctx2.nightRaided = false;
    tickFatigue(ctx2);
    assert.equal(g.fatigue, 0, '安静夜守卫不动（打盹抵过，不落账）');
  });
});

describe('排班疲劳感知：管家不再把人熬垮', () => {
  test('planDusk 守卫优先选不累的', () => {
    const s = toNight(newRun({ seed: 207 }).state);
    ch(s, 'anton').fatigue = 2; ch(s, 'anton').combat = 5; // 最能打的已力竭
    ch(s, 'marta').fatigue = 0; ch(s, 'marta').combat = 1;
    const plans = planDusk(s, PACK);
    const out = plans.plans.filter((p) => p.intent.scavenger);
    const guardPlan = out[0] || plans.plans[0];
    const guardId = Object.entries(guardPlan.intent.others).find(([, v]) => v === 'guard')?.[0];
    assert.equal(guardId, 'marta', '力竭者不再被排守夜（有别人时）');
  });

  test('planDay 给力竭者排卧床', () => {
    const s = newRun({ seed: 208 }).state; // 白天
    ch(s, 'anton').fatigue = 2;
    const intents = planDay(s, PACK);
    assert.ok(intents.some((i) => i.type === 'act' && i.actor === 'anton' && i.action === 'rest'), '力竭者要有卧床安排');
  });
});

describe('夜访卡的家里一行（nightHomeView）', () => {
  test('夜访中：守卫与安睡者点名', () => {
    let s = toNight(newRun({ seed: 209 }).state);
    s.inventory.crowbar = 1;
    s = step(s, [{ type: 'dusk_assign', scavenger: 'anton', location: 'market', gear: [], others: { marta: 'guard', bron: 'sleep' } }]).state;
    const home = nightHomeView(s);
    assert.equal(home.guard, '辛夷');
    assert.deepEqual(home.asleep, ['石大']);
  });
});

describe('P2 换守：收工回家，接替守夜', () => {
  test('换守一夜：夜收工、守卫易人、原守卫半宿将息、接守者夜访未眠、fold 一致', () => {
    const base = newRun({ seed: 210 });
    let s = base.state;
    s = toNight(s);
    ch(s, 'marta').fatigue = 1; ch(s, 'anton').fatigue = 0;
    s.inventory.crowbar = 1;
    let r = step(s, [{ type: 'dusk_assign', scavenger: 'anton', location: 'market', gear: ['crowbar'], others: { marta: 'guard', bron: 'sleep' } }]);
    s = r.state;
    assert.ok(s.night && !s.night.home, '夜访在途');
    const events = [...base.events, ...r.events];
    r = step(s, [{ type: 'night', action: 'handover' }]);
    s = r.state;
    events.push(...r.events);
    assert.ok(!s.night, '夜应收工');
    assert.ok(r.facts.some((f) => f.k === 'guard_handover'), '换守事实落账');
    assert.equal(ch(s, 'anton').fatigue, 1, '夜访+接守者照加（夜访未眠）');
    assert.equal(ch(s, 'anton').guardTonight, false, '天亮排班复位');
    assert.equal(ch(s, 'marta').fatigue, 0, '原守卫半宿将息 −1');
    // 回放铁律：fold(事件流) 与活局一致
    const replay = fold(events);
    assert.equal(ch(replay, 'marta').fatigue, 0, '回放：原守卫同样半宿将息');
    assert.equal(ch(replay, 'anton').fatigue, 1, '回放：接守者同样 +1');
  });
});

describe('P1 物资参数住内容包（manifest.night）', () => {
  const tweakPack = (mut) => {
    const p = structuredClone(PACK);
    mut(p);
    return p;
  };
  test('回填：refillChance=0 永不回填；=1 且过冷却必回填', () => {
    const run = (pack) => {
      let s = newRun({ seed: 211 }).state;
      s = toNight(s);
      s.inventory.crowbar = 1;
      // 预置：两天前搜过的容器
      s.locState.market = { searched: { m_shelf1: s.day - 2, m_cold: s.day - 2 }, npcState: {}, scriptsFired: {}, firstVisit: false };
      s = resolveInput(s, pack, [{ type: 'dusk_assign', scavenger: 'anton', location: 'market', gear: [], others: {} }]).state;
      return s.locState.market.searched.m_shelf1 != null ? 'kept' : 'refilled';
    };
    assert.equal(run(tweakPack((p) => { p.manifest.night = { ...(p.manifest.night || {}), refillChance: 0 }; })), 'kept', 'chance 0 → 永不回填');
    assert.equal(run(tweakPack((p) => { p.manifest.night = { ...(p.manifest.night || {}), refillMinDays: 1, refillChance: 1 }; })), 'refilled', '过冷却 + chance 1 → 必回填');
  });

  test('战利品：lootRolls 数进内容包——掷 N 次得 N 件（hitChance=1、定量表）', () => {
    const lootPack = (rolls) => tweakPack((p) => {
      p.manifest.night = { ...(p.manifest.night || {}), lootRolls: rolls, lootHitChance: 1 };
      const room = p.locMap.market.rooms.find((r) => r.id === 'front');
      room.containers = [{ id: 'm_test', name: '定量箱', type: 'open', loot: [{ item: 'water', count: [1, 1], w: 1 }] }];
    });
    const searchOnce = (pack) => {
      let s = newRun({ seed: 212 }).state;
      s = toNight(s);
      s = resolveInput(s, pack, [{ type: 'dusk_assign', scavenger: 'anton', location: 'market', gear: [], others: {} }]).state;
      // 方针走完夜会全搜——直接看事件账里 water 的入账次数
      const r2 = resolveInput(s, pack, [{ type: 'night', action: 'search', target: 'm_test' }]);
      return r2.events.filter((e) => e.t === 'ITEM_MOVED' && e.d.item === 'water').reduce((a, e) => a + e.d.delta, 0);
    };
    assert.equal(searchOnce(lootPack(2)), 2, '双掷=两件');
    assert.equal(searchOnce(lootPack(1)), 1, '单掷=一件');
  });
});
