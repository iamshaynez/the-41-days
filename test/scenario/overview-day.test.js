// 概述日（长线体验-v0.2 §4.4「系统疲劳的解药」）场景：
// 平淡的日子由叙事者一句话收卷，只在事件/状态突变处停下问玩家——
// 41 天不再是被均匀拉长的白开水。反设计清单禁跳过键，压缩只准走这条门。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, skipDayAtHome, PACK } from '../helpers.js';
import { fold, planDusk } from '../../packages/core/index.js';
import { overviewThreshold } from '../../packages/core/src/pacing.js';
import { renderDirect } from '../../packages/server/narrate.js';

/** 造一个「第 N-1 天黄昏」的干净现场：人无火警、粮充足、无未决事件。
 *  把已经过去的那些天补成真实的样子（主线步已入册、堂屋已评过史、过窗卡已发过），
 *  一句在家过夜的指派 → 破晓即进入第 N 天的概述裁决。 */
function nightToDawn(day, { seed = 1, policy = null, hunger = 4, famine = false } = {}) {
  const { state } = newRun({ seed });
  const s = state;
  s.day = day - 1; s.phase = 'dusk'; s.night = null; s.activeEvent = null;
  for (const c of s.chars) { c.hunger = hunger; c.wound = 0; c.sick = 0; c.moodPts = 4; c.fatigue = 0; c.breakdown = null; }
  s.inventory = { ...s.inventory, meal: 8, canned: 4, raw: 4, firewood: 6, bandage: 2, meds: 2, wood: 10, parts: 10 };
  if (famine) { // 断粮火警：柜里一粒粮都不剩（不触发"有粮不喂"的良心账级联）
    for (const k of ['meal', 'canned', 'raw', 'meat', 'veg']) delete s.inventory[k];
    for (const c of s.chars) c.hunger = 1; // 破晓后挨到濒死
  }
  s.facilities.stove = 1;
  // 前情补账：过去的大事步都已入册、堂屋都评过史（不然评史积压会把每个清晨都占掉）
  s.mainline = [];
  for (const st of PACK.mainline.steps) {
    const d = st.dayWindow?.[0] ?? st.day;
    if (d < day) { s.mainline.push({ day: d, stepId: st.id, pens: [], mirrors: [] }); s.firedOnce['ml_' + st.id] = true; }
  }
  s.ensemble.coveredSteps = s.mainline.map((e) => e.stepId);
  for (const card of PACK.cards.filter((c) => c.kind === 'timeline')) {
    const lo = card.when?.dayWindow?.[0];
    if (lo !== undefined && lo < day) s.firedOnce[card.id] = true; // 时间轴卡窗口内必发：窗口已开即已发过
  }
  if (policy) s.policy = { ...s.policy, ...policy };
  return step(s, [{ type: 'dusk_assign', scavenger: null, others: {} }]);
}

/** 扫种子找一个「第 N 天破晓真正安静」的现场（无急件/无堂屋/无大事步） */
function findQuietDawn(day, { policy = null, hunger = 4, famine = false } = {}) {
  for (let seed = 1; seed <= 80; seed++) {
    const r = nightToDawn(day, { seed, policy, hunger, famine });
    if (r.state.activeEvent) continue;
    if (r.facts.some((f) => f.k === 'ensemble')) continue;
    if (r.state.mainline?.some((e) => e.day === day && e.stepId)) continue;
    return { seed, r };
  }
  throw new Error(`找不到安静的第 ${day} 天（扫了 80 个种子）`);
}

describe('场景：概述日——平淡日一句话收卷', () => {
  test('中盘平淡日：破晓一笔带过，直落黄昏，不再停在白天', () => {
    const { r } = findQuietDawn(18); // A3「还军」首日前的空档（阈值 1：平淡即概述）
    assert.equal(r.state.phase, 'dusk', `第 18 天应直落黄昏，实际停在 ${r.state.phase}`);
    assert.ok(r.facts.some((f) => f.k === 'day_overview'), '应落 day_overview 一笔');
    assert.ok(!r.facts.some((f) => ['eat', 'cook', 'craft', 'build', 'auto_day_start'].includes(f.k)), '例行流水不该进正文');
    assert.equal(r.state.quietStreak, 1, '连平静默账应记 1');
    assert.equal(r.state.overviewDays, 1, '概述日计数应记 1');
  });

  test('概述日的账要一致：fold 回放与终态相同（概述没有第二条状态通道）', () => {
    // 真局真走：自然推进（概述发生在破晓那一批里），撞见第一个概述日即校验事件流回放
    for (let seed = 1; seed <= 60; seed++) {
      const { state, events } = newRun({ seed });
      let s = state, all = [...events], found = false;
      let guard = 0;
      const take = (intents) => { const r = step(s, intents); all.push(...r.events); s = r.state; return r; };
      while (s.day < 34 && guard++ < 200 && !s.over && !found) {
        const r = s.activeEvent
          ? take([{ type: 'event_choice', option: (PACK.cardMap[s.activeEvent.cardId] || (s.geCards || {})[s.activeEvent.cardId])?.options?.[0]?.key || 'a' }])
          : s.phase === 'day' ? take([{ type: 'auto_day' }])
          : s.phase === 'dusk' ? take([planDusk(s, PACK).plans[0].intent]) // 照管家的方案谋生（不然饿死在中盘，永远等不到安静日）
          : s.phase === 'night' && s.night && !s.night.home ? take([{ type: 'night_directive', stance: 'normal', text: '照常' }])
          : null;
        if (!r) break;
        if (r.facts.some((f) => f.k === 'day_overview')) found = true;
      }
      if (!found) continue;
      const rebuilt = fold(all);
      assert.deepEqual(rebuilt, s, `seed ${seed} 概述日的收卷必须完全走事件流`);
      return;
    }
    assert.ok(false, '60 个种子里没有一个自然走到概述日');
  });

  test('门口有事的日子不概述：急件永远优先', () => {
    for (let seed = 1; seed <= 80; seed++) {
      const r = nightToDawn(18, { seed });
      if (!r.state.activeEvent) continue;
      assert.equal(r.state.phase, 'day', '有急件的白天要停下来等玩家应门');
      assert.ok(!r.facts.some((f) => f.k === 'day_overview'), '急件日不得概述');
      return;
    }
    assert.ok(false, '80 个种子里没找到一个有急件的第 18 天');
  });

  test('大事步的日子不概述：史与家要在同一页上', () => {
    const r = nightToDawn(19, { seed: 3 }); // D19 主线步（A3）
    assert.ok(r.state.mainline?.some((e) => e.day === 19 && e.stepId), 'D19 应有大事步');
    assert.equal(r.state.phase, 'day', '大事步的白天要整页留给玩家');
    assert.ok(!r.facts.some((f) => f.k === 'day_overview'));
  });

  test('晨报有火警不概述：断粮之家等不了一笔带过', () => {
    const { r } = findQuietDawn(18, { famine: true }); // 破晓即断粮、人挨到濒死
    assert.equal(r.state.phase, 'day', '火警日必须停在白天让玩家想办法');
    assert.ok(!r.facts.some((f) => f.k === 'day_overview'));
  });

  test('幕阈值是内容数值：中盘一平即收，末路永字不收', () => {
    assert.equal(overviewThreshold(PACK, 'A2'), 1);
    assert.equal(overviewThreshold(PACK, 'A3'), 1);
    assert.equal(overviewThreshold(PACK, 'A4'), 1);
    assert.ok(overviewThreshold(PACK, 'A5') >= 99, '末路五日每天都是整页');
    assert.ok(overviewThreshold(PACK, 'A1') >= 2, '首幕要给玩家完整的头几天');
  });

  test('玩家关掉「概述日」规矩：日子照旧逐件细过', () => {
    const { r } = findQuietDawn(18, { policy: { overviewDays: false } });
    assert.equal(r.state.phase, 'day', '关掉概述日后白天照常停问');
    assert.ok(!r.facts.some((f) => f.k === 'day_overview'));
  });

  test('连平加深：第二天的概述笔更省（streak 进档）', () => {
    for (let seed = 1; seed <= 80; seed++) {
      const r1 = nightToDawn(20, { seed });
      if (r1.state.activeEvent || r1.facts.some((f) => f.k === 'ensemble')) continue;
      if (!r1.facts.some((f) => f.k === 'day_overview')) continue; // D20 不安静，换种子
      const r2 = step(r1.state, [{ type: 'dusk_assign', scavenger: null, others: {} }]); // D21 破晓
      if (r2.state.activeEvent || r2.facts.some((f) => f.k === 'ensemble')) continue;
      const ov2 = r2.facts.find((f) => f.k === 'day_overview');
      if (!ov2) continue; // D21 被别的事占了，换种子
      assert.equal(ov2.streak, 2, '连平第二日 streak 应为 2');
      assert.ok(r2.state.quietStreak >= 2);
      return;
    }
    assert.ok(false, '80 个种子里没凑出连平两天');
  });

  test('确定性：同种子同一天，概述与否、笔落几何，重跑不变', () => {
    const a = nightToDawn(18, { seed: 9 });
    const b = nightToDawn(18, { seed: 9 });
    assert.equal(a.state.phase, b.state.phase);
    assert.equal(a.state.day, b.state.day);
    assert.equal(JSON.stringify(a.facts.map((f) => f.k)), JSON.stringify(b.facts.map((f) => f.k)));
  });

  test('直读渲染：概述日是一笔小字，不是一页流水', () => {
    const line = renderDirect(
      { seed: 5, day: 18, chars: [], inventory: {} },
      [{ k: 'day_overview', day: 18, streak: 1, ate: 2, built: null }],
      PACK
    );
    assert.ok(/无事|平常|平平|一天/.test(line), `概述行应落在概述模板上：${line}`);
    assert.ok(!line.includes('\n'), `概述日正文只该一行：${line}`);
    const deep = renderDirect(
      { seed: 5, day: 18, chars: [], inventory: {} },
      [{ k: 'day_overview', day: 18, streak: 5, ate: 2, built: null }],
      PACK
    );
    assert.ok(deep.length <= line.length + 6, '连平多日概述应更省笔');
  });
});
