// L1 单元测试：六轴状态机（规则号 = 测试名，内核设计 §2）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, skipDayAtHome, PACK } from '../helpers.js';
import { Ctx } from '../../packages/core/index.js';

describe('饥饿 H-01~H-05', () => {
  test('H-02 每晨 -1 级，饱足只跌到正常', () => {
    let { state } = newRun({ roster: ['anton', 'marta', 'bron'] });
    const a = ch(state, 'anton');
    a.hunger = 4; a.moodPts = 2;
    state = skipDayAtHome(state);
    assert.equal(ch(state, 'anton').hunger, 3);
    state = skipDayAtHome(state);
    assert.equal(ch(state, 'anton').hunger, 2);
  });

  test('H-03 熟食 +2，生食 +1；饱足再吃拒绝浪费', () => {
    let { state } = newRun();
    const a = ch(state, 'anton');
    a.hunger = 1;
    state.inventory.meal = 1;
    let r = step(state, [{ type: 'act', actor: 'anton', action: 'eat', target: 'meal' }]);
    assert.equal(ch(r.state, 'anton').hunger, 3);
    state = r.state;
    state.inventory.raw = 1;
    r = step(state, [{ type: 'act', actor: 'anton', action: 'eat', target: 'raw' }]);
    assert.equal(ch(r.state, 'anton').hunger, 4);
    r = step(r.state, [{ type: 'act', actor: 'anton', action: 'eat', target: 'raw' }]);
    assert.equal(r.rejects[0]?.reason, 'FULL');
  });

  test('H-05 隔天餐策略：每 2 天 1 熟食可维生（12 天不低于饥饿档）', () => {
    let { state } = newRun({ roster: ['bron'] });
    let minHunger = 9;
    let meals = 0;
    for (let d = 0; d < 12; d++) {
      const acts = [];
      if (ch(state, 'bron').hunger <= 2 && ch(state, 'bron').alive) {
        state.inventory.meal = 1; // 隔离测试变量：外部供给
        acts.push({ type: 'act', actor: 'bron', action: 'eat', target: 'meal' });
        meals++;
      }
      state = skipDayAtHome(state, acts);
      minHunger = Math.min(minHunger, ch(state, 'bron').hunger);
    }
    assert.ok(minHunger >= 1, `最低饥饿档应 ≥1（实际 ${minHunger}，共 ${meals} 餐）`);
  });

  test('H-04(v1 修订) 濒死每晨 50% 转微恙起步（100 局统计 30~70%）', () => {
    let hits = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const { state } = newRun({ seed, roster: ['bron'] });
      const b = ch(state, 'bron');
      b.hunger = 0; b.sick = 0;
      const next = skipDayAtHome(state);
      if (ch(next, 'bron').sick >= 1) hits++;
    }
    assert.ok(hits >= 30 && hits <= 70, `转病率 ${hits}% 应落在 30~70`);
  });
});

describe('伤病 I-05/I-08', () => {
  test('I-05+I-08 裹创布（医护）+卧床：重伤两晨归零', () => {
    let { state } = newRun({ roster: ['marta', 'bron'] });
    const b = ch(state, 'bron');
    b.wound = 2;
    state.inventory.bandage = 3;
    const s2 = step(state, [{ type: 'act', actor: 'marta', action: 'treat', target: 'bandage', patient: 'bron' }]);
    assert.equal(ch(s2.state, 'bron').wound, 0, '医护双降：2→1→0');
    const s3 = step(s2.state, [{ type: 'act', actor: 'bron', action: 'rest' }, { type: 'advance' }]);
    assert.ok(ch(s3.state, 'bron').alive);
  });

  test('I-08 危重缺医护：三晨内大概率死亡', () => {
    let dead = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const { state } = newRun({ seed, roster: ['anton', 'pavel'] }); // 无辛夷
      const p = ch(state, 'pavel');
      p.wound = 3;
      let s = state;
      for (let i = 0; i < 3 && ch(s, 'pavel').alive; i++) s = skipDayAtHome(s);
      if (!ch(s, 'pavel').alive) dead++;
    }
    assert.ok(dead >= 30, `三晨内死亡率 ${dead}/60 应 ≥50%`);
  });

  test('I-06 伤 2 不上裹创布 3 天后可能感染/恶化', () => {
    let hit = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const { state } = newRun({ seed, roster: ['bron', 'katya'] });
      const b = ch(state, 'bron');
      b.wound = 2; b.woundUntreatedDays = 3;
      const s = skipDayAtHome(state);
      if (ch(s, 'bron').sick >= 1 || ch(s, 'bron').wound === 3) hit++;
    }
    assert.ok(hit >= 10, `感染/恶化 ${hit}/50 应 ≥20%`);
  });
});

describe('心情 M-01~M-10/M-14', () => {
  test('M-02+M-10 伦理向量：杀无辜，阿禾(×2.0)跌得比江鳅(×0.8)狠', () => {
    const { state } = newRun({ roster: ['yura', 'danilo'] });
    const y = ch(state, 'yura'), d = ch(state, 'danilo');
    y.moodPts = 2; d.moodPts = 2; y.moodCounts = {}; d.moodCounts = {};
    const ctx = new Ctx(state, PACK);
    ctx.mood(y, -10, '夺命', { ethics: 'killCiv' });
    ctx.mood(d, -10, '夺命', { ethics: 'killCiv' });
    assert.ok(y.moodPts < d.moodPts, `阿禾 ${y.moodPts} 应低于江鳅 ${d.moodPts}`);
  });

  test('M-03 钝化：-2 连续 4 次累计 ≈ -6', () => {
    const { state } = newRun({ roster: ['bron'] });
    const b = ch(state, 'bron');
    b.moodPts = 10; b.moodCounts = {};
    const ctx = new Ctx(state, PACK);
    for (let i = 0; i < 4; i++) ctx.mood(b, -2, '测试事件');
    assert.equal(b.moodPts, 4, '-2×(1+.8+.64*.75下限…) 实际衰减');
  });

  test('M-14 崩溃链三晨内未安抚 → 离队或自伤；+4 安抚逆转', () => {
    let ended = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const { state } = newRun({ seed, roster: ['bron', 'marta'] });
      const b = ch(state, 'bron');
      b.moodPts = -15; b.breakdown = { stage: 1 }; b.soothed = 0;
      let s = state;
      for (let i = 0; i < 3 && ch(s, 'bron').alive && ch(s, 'bron').breakdown; i++) s = skipDayAtHome(s);
      if (!ch(s, 'bron').alive || ch(s, 'bron').wound >= 2) ended++;
    }
    assert.ok(ended >= 28, `崩溃三晨结局 ${ended}/30`);
    const { state } = newRun({ roster: ['bron', 'marta'] });
    const b = ch(state, 'bron');
    b.moodPts = -15; b.breakdown = { stage: 1 }; b.soothed = 4;
    const s = skipDayAtHome(state);
    assert.ok(!ch(s, 'bron').breakdown, '安抚 +4 应解除崩溃链');
  });
});

describe('疲劳 F 与温度 T', () => {
  test('F-02/F-03 守夜疲劳 +1', () => {
    let { state } = newRun({ roster: ['bron'] });
    state = step(state, [{ type: 'act', actor: 'bron', action: 'guard' }, { type: 'advance' }]).state;
    state = step(state, [{ type: 'dusk_assign', scavenger: null, others: { bron: 'guard' } }]).state;
    assert.equal(ch(state, 'bron').fatigue, 1);
  });

  test('T-04 严寒无取暖：三夜后过半队伍患病（体弱者 40%/夜）', () => {
    let sickRuns = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const { state } = newRun({ seed, roster: ['anton', 'katya'] });
      let s = state;
      s.winterActive = true; s.winterStart = 1; s.winterEnd = 99;
      for (let i = 0; i < 3; i++) {
        s.inventory.firewood = 0; s.inventory.fuel = 0;
        s = skipDayAtHome(s);
      }
      if (s.chars.some((c) => c.sick >= 1)) sickRuns++;
    }
    assert.ok(sickRuns >= 15, `三严寒夜患病率 ${sickRuns}/30 应 ≥50%`);
  });
});
