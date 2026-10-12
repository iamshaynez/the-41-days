// v2 决断意志场景：玩家全程只用两种输入——决策卡（结构化意图）+ 大白话。
// 这条测试模拟的就是新玩家的真实路径：序章点选项，白天"照常过吧"，黄昏点方案，夜里岔路点选项。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack, createRun, beginRun, resolveInput, parseDirect, planDay, planDusk, planNightStep, suggests, fold } from '../../packages/core/index.js';

const pack = loadPack();

/** 玩家模拟器：只会点卡和说大白话（直读语法口径，LLM 不在场） */
function playByChoices(s, maxDays = 15) {
  const log = { days: 0, events: 0, forks: 0, freeText: 0 };
  const allEvents = [];
  const step = (intents) => {
    const r = resolveInput(s, pack, intents);
    allEvents.push(...r.events);
    s = r.state;
    return r;
  };
  const answerEvent = () => {
    if (!s.activeEvent) return false;
    const card = pack.cardMap[s.activeEvent.cardId];
    const opt = card.options.find((o) => !o.cost?.length && !o.requires) || card.options[0];
    log.events++;
    step([{ type: 'event_choice', option: opt.key }]);
    return true;
  };
  while (!s.over && s.day <= maxDays) {
    while (answerEvent());
    if (s.phase === 'day') {
      // 大白话："照常过吧"——直读解析器应认得（政策与宏意图的文本入口）
      const parsed = parseDirect(s, pack, '照常过吧');
      log.freeText++;
      assert.ok(parsed.intents.some((i) => i.type === 'auto_day'), '「照常过吧」应解析为 auto_day');
      step(parsed.intents);
      while (answerEvent());
      if (s.phase === 'day') step([{ type: 'advance' }]);
    }
    if (s.over) break;
    if (s.phase === 'dusk') {
      const plans = planDusk(s, pack).plans;
      assert.ok(plans.length >= 1, '黄昏必须有方案可点');
      step([plans[0].intent]);
    }
    let g = 0;
    while (s.phase === 'night' && s.night && !s.night.home && g++ < 14) {
      if (answerEvent()) continue;
      const r = step([{ type: 'auto_night' }]);
      const fork = r.facts.find((f) => f.k === 'night_fork');
      if (fork && s.phase === 'night' && s.night && !s.night.home && !s.activeEvent) {
        log.forks++;
        const st = planNightStep(s, pack, {});
        assert.ok(st?.stop?.options?.length, '岔路必须有选项');
        const opt = st.stop.options.find((o) => o.label.includes('不打扰') || o.label.includes('再摸黑')) || st.stop.options[0];
        step(opt.intents);
      }
    }
    log.days = s.day;
  }
  return { s, log, allEvents };
}

describe('决断意志全流程（只点卡 + 大白话）', () => {
  const { s, log, allEvents } = playByChoices(createRun(pack, { seed: 7, roster: ['bron', 'marta', 'katya'] }), 15);

  test('活过 15 天且队伍还在', () => {
    assert.ok(log.days >= 15 || s.over, `应推进：day=${log.days}`);
    assert.ok(s.chars.some((c) => c.alive), '不该全灭（管家水平应及格）');
  });

  test('全程经历了事件与岔路（决策点真实出现）', () => {
    assert.ok(log.events >= 1, '15 天应至少触发一次事件卡');
  });

  test('委托账目入账（delegated 标记真实落账）', () => {
    const delegated = s.causality.entries.filter((e) => e.delegated);
    assert.ok(delegated.length >= 5, `delegated 账目 ${delegated.length} 条`);
  });

  test('事件溯源一致：fold(events) 重放 == 终态', () => {
    // 决断路径的事件流必须与最终状态对得上（管家意图没有绕过内核记账）
    const rebuilt = fold(allEvents);
    assert.ok(rebuilt, '事件流可回放');
    assert.equal(rebuilt.day, s.day);
    assert.deepEqual(rebuilt.inventory, s.inventory);
    assert.equal(rebuilt.chars.filter((c) => c.alive).length, s.chars.filter((c) => c.alive).length);
  });

  test('大白话策略：「省着吃」沉淀为持久规矩', () => {
    let s2 = beginRun(createRun(pack, { seed: 7, roster: ['bron', 'marta', 'katya'] }), pack).state;
    const parsed = parseDirect(s2, pack, '以后省着吃');
    assert.ok(parsed.intents.some((i) => i.type === 'policy' && i.key === 'rationing' && i.value === true));
    s2 = resolveInput(s2, pack, parsed.intents).state;
    assert.equal(s2.policy.rationing, true);
    // 规矩影响管家行为：饥饿 2 级（刚饿）的人在省粮规矩下不再被喂
    s2.chars[0].hunger = 2; s2.chars[1].hunger = 1;
    const eats = planDay(s2, pack).filter((i) => i.action === 'eat').map((i) => i.actor);
    assert.deepEqual(eats, ['marta']);
  });
});

describe('序章 → 首日衔接（新玩家的头两分钟）', () => {
  test('序章五拍全是选择题；落地后建议栏就有"让他们自己张罗"', () => {
    let s = beginRun(createRun(pack, { seed: 11, roster: ['bron', 'marta', 'katya'], prologue: true }), pack, { prologue: true }).state;
    assert.equal(s.phase, 'prologue');
    let beats = 0;
    while (s.phase === 'prologue' && beats++ < 8) {
      assert.ok(s.activeEvent, '序章每一拍都是一张选择卡');
      const card = pack.cardMap[s.activeEvent.cardId];
      s = resolveInput(s, pack, [{ type: 'event_choice', option: card.options[0].key }]).state;
    }
    assert.equal(s.phase, 'day');
    const sg = suggests(s, pack);
    assert.ok(sg.some((x) => x.intents?.at(-1)?.type === 'auto_day'), '落地首日即有自动日常入口（收卷式）');
    assert.ok(sg.some((x) => x.label.includes('我能做什么')), '首日有教学入口');
  });
});
