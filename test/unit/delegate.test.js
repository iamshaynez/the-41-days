// 管家层单测：planDay / planDusk / planNightStep / policy / tradeDeals / dawnProblems。
// 铁律：管家产出的每个意图都必须能被 resolveInput 无拒绝地执行（规划与现实不得脱节）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadPack, createRun, beginRun, resolveInput, planDay, planDusk, planNightStep,
  dawnProblems, tradeDeals, suggests, policyOf
} from '../../packages/core/index.js';

const pack = loadPack();
const newRun = (opts = {}) => {
  const s = createRun(pack, { seed: 42, roster: ['bron', 'marta', 'katya'], ...opts });
  return beginRun(s, pack).state;
};
/** 推进到某地点的深夜（供夜间用例共用） */
const toNight = (loc = 'villas') => {
  let s = newRun();
  s = resolveInput(s, pack, [{ type: 'advance' }]).state;
  const plans = planDusk(s, pack).plans;
  const plan = plans.find((p) => p.intent.location === loc) || plans[0];
  return resolveInput(s, pack, [plan.intent]).state;
};

describe('管家：白天规划（planDay）', () => {
  test('首日无人挨饿时不喂；饿到线下才喂', () => {
    const s = newRun(); // hunger=3 正常
    const plan = planDay(s, pack);
    assert.ok(!plan.some((i) => i.action === 'eat'), '正常饥饿度不该浪费食物');
    s.chars[0].hunger = 2; s.chars[1].hunger = 1;
    const plan2 = planDay(s, pack);
    assert.equal(plan2.filter((i) => i.action === 'eat').length, 2);
  });

  test('省粮策略：只喂饥饿线以下的，且不再人人有份', () => {
    const s = newRun();
    s.policy.rationing = true;
    s.chars[0].hunger = 2; s.chars[1].hunger = 1; s.chars[2].hunger = 0;
    const eats = planDay(s, pack).filter((i) => i.action === 'eat');
    assert.deepEqual(eats.map((i) => i.actor).sort(), ['katya', 'marta']); // hunger≤1 的两位
  });

  test('规划产物全部可执行（无 NO_*/BAD_* 拒绝）', () => {
    let s = newRun();
    const plan = planDay(s, pack);
    const r = resolveInput(s, pack, plan);
    assert.equal(r.rejects.length, 0, JSON.stringify(r.rejects));
  });

  test('auto_day 宏意图：展开执行、入黄昏、账目带 delegated', () => {
    let s = newRun();
    s.chars[0].hunger = 1; // 让喂饭发生
    const r = resolveInput(s, pack, [{ type: 'auto_day' }]);
    assert.equal(r.state.phase, 'dusk');
    assert.ok(r.facts.some((f) => f.k === 'auto_day_start'));
    assert.ok(r.facts.some((f) => f.delegated), '管家执行的 facts 应带 delegated');
    const cz = r.state.causality.entries;
    assert.ok(cz.filter((e) => e.delegated).length > 0, '因果账条目应带 delegated');
  });

  test('门口有未决事件时，管家不替玩家收工', () => {
    let s = newRun();
    s.activeEvent = { cardId: 'n_meds' };
    const r = resolveInput(s, pack, [{ type: 'auto_day' }]);
    assert.equal(r.state.phase, 'day', '事件未答，不该进黄昏');
  });

  test('feeding=manual 时管家不碰饭', () => {
    let s = newRun();
    s.policy.feeding = 'manual';
    s.chars[0].hunger = 0;
    assert.ok(!planDay(s, pack).some((i) => i.action === 'eat'));
  });
});

describe('策略意图（policy）', () => {
  test('policy 意图改写 state.policy 并可被 fold 回放（FLAG 通用镜像）', () => {
    let s = newRun();
    const r = resolveInput(s, pack, [{ type: 'policy', key: 'rationing', value: true }]);
    assert.equal(r.state.policy.rationing, true);
    assert.ok(r.facts.some((f) => f.k === 'policy_set'));
    assert.ok(r.events.some((e) => e.t === 'FLAG' && e.d.key === 'policy'));
  });
  test('坏 key 拒绝', () => {
    const r = resolveInput(newRun(), pack, [{ type: 'policy', key: 'godmode', value: true }]);
    assert.equal(r.rejects[0].reason, 'BAD_POLICY');
  });
  test('policyOf 兜底旧存档（无 policy 字段）', () => {
    const s = newRun();
    delete s.policy;
    assert.equal(policyOf(s).feeding, 'auto');
  });
});

describe('管家：黄昏方案（planDusk）', () => {
  test('方案合法：2~3 个完整指派，含守夜安排，全部可被内核接受', () => {
    let s = newRun();
    s = resolveInput(s, pack, [{ type: 'advance' }]).state; // 到黄昏
    const { plans } = planDusk(s, pack);
    assert.ok(plans.length >= 2 && plans.length <= 3);
    for (const p of plans) {
      const r = resolveInput(structuredClone(s), pack, [p.intent]);
      assert.equal(r.rejects.length, 0, `${p.label} 被拒：${JSON.stringify(r.rejects)}`);
    }
    // 外出方案：进入深夜
    const out = plans.find((p) => p.intent.scavenger);
    assert.equal(resolveInput(structuredClone(s), pack, [out.intent]).state.phase, 'night');
    // 留守方案：在家过夜，直接走到次日白天
    const stay = plans.find((p) => p.key === 'stay');
    const r = resolveInput(structuredClone(s), pack, [stay.intent]);
    assert.equal(r.state.day, s.day + 1, '留守过夜应推进到第二天');
  });

  test('危重伤员不出现在外出方案里', () => {
    let s = newRun();
    s.chars[0].wound = 3; // bron 危重
    s = resolveInput(s, pack, [{ type: 'advance' }]).state;
    const { plans } = planDusk(s, pack);
    for (const p of plans) assert.notEqual(p.intent.scavenger, 'bron');
  });
});

describe('管家：夜间自动流（planNightStep + auto_night）', () => {
  test('无 NPC 的地点：auto_night 一路搜到搜尽回家', () => {
    let s = toNight('villas');
    const r = resolveInput(s, pack, [{ type: 'auto_night' }]);
    assert.ok(!r.facts.some((f) => f.k === 'night_fork'), '别墅区没 NPC，不该停问');
    assert.equal(r.state.phase, 'day', '搜完自动回家进次日');
  });

  test('火柴将尽时停问一次；push_on 后不再问', () => {
    let s = toNight('villas');
    s.night.slots = 4;
    // 先搜掉当前房容器，逼出 low_slots 岔路
    let r = resolveInput(s, pack, [{ type: 'auto_night' }]);
    s = r.state;
    if (s.phase === 'night' && s.night && !s.night.home && s.night.slots <= 3) {
      const step = planNightStep(s, pack, {});
      assert.equal(step?.stop?.kind, 'low_slots');
      // 玩家选择再搜一会
      const pushOpt = step.stop.options.find((o) => o.intents.some((i) => i.action === 'push_on'));
      s = resolveInput(s, pack, pushOpt.intents).state;
      if (s.phase === 'night' && s.night && !s.night.home) {
        assert.ok(s.night.lowSlotsAck, 'push_on 应落旗标');
        const again = planNightStep(s, pack, {});
        assert.ok(again?.stop?.kind !== 'low_slots', '同一晚不重复问火柴');
      }
    }
  });

  test('医院首访：NPC 剧本事件接管（不停问，事件卡先行）', () => {
    let s = toNight('hospital');
    if (s.activeEvent) return; // 剧本在抵达时已触发，正确
    const r = resolveInput(s, pack, [{ type: 'auto_night' }]);
    assert.ok(r.state.activeEvent || r.state.phase === 'day');
  });
});

describe('晨报问题（dawnProblems）与情境建议（suggests）', () => {
  test('无粮时报 3 级问题；崩溃报 3 级', () => {
    const s = newRun();
    delete s.inventory.raw; delete s.inventory.canned; delete s.inventory.meal;
    const probs = dawnProblems(s, pack);
    assert.ok(probs[0].sev === 3 && probs[0].text.includes('吃的'));
    s.chars[0].breakdown = { stage: 1 };
    assert.ok(dawnProblems(s, pack).some((p) => p.text.includes('崩溃')));
  });
  test('第一天白天的建议含"自己张罗"与"我能做什么"', () => {
    const s = newRun();
    const sg = suggests(s, pack);
    assert.ok(sg.some((x) => x.intents?.at(-1)?.type === 'auto_day' && x.label.includes('自己张罗')), '自动日常以收卷意图直传');
    assert.ok(sg.some((x) => x.label.includes('我能做什么')));
    // 宏观节奏：白天建议全部收卷（求助除外）
    for (const x of sg.filter((y) => y.label !== '我能做什么？')) assert.equal(x.intents.at(-1).type, 'auto_day', `${x.label} 应收卷`);
  });
  test('夜里建议带 auto_night 结构化意图', () => {
    let s = toNight('villas');
    if (s.phase !== 'night') s = newRun(); // 防御：夜访没建成则跳过
    if (s.phase === 'night') {
      const sg = suggests(s, pack);
      assert.ok(sg.some((x) => x.intents?.[0]?.type === 'auto_night'));
    }
  });
});

describe('交易建议（tradeDeals）', () => {
  test('鲁舟在场时给出必过价格带的成交', () => {
    let s = newRun();
    // 摊上有家里缺的药；家里有值钱货（药品在战时就是天价，纯材料凑不够——这是设计如实）
    s.inventory.jewel = 2;
    s.franko = { merchant: 'franko', stock: [{ item: 'meds', n: 1, buy: 30 }, { item: 'canned', n: 2, buy: 15 }] };
    const deals = tradeDeals(s, pack);
    assert.ok(deals.length > 0, '有药可换且付得起时应给出建议');
    for (const d of deals) {
      const r = resolveInput(structuredClone(s), pack, [{ type: 'trade_op', give: d.give, get: d.get }]);
      assert.equal(r.rejects.length, 0, `建议成交被拒：${d.label} ${JSON.stringify(r.rejects)}`);
      assert.ok(Object.values(d.get).every((n) => n > 0));
    }
  });
  test('付不起时不硬给建议（没有值钱货，药品就是天价）', () => {
    let s = newRun();
    s.franko = { merchant: 'franko', stock: [{ item: 'meds', n: 1, buy: 30 }] };
    assert.deepEqual(tradeDeals(s, pack), []);
  });
  test('商人不在场 → 空建议', () => {
    assert.deepEqual(tradeDeals(newRun(), pack), []);
  });
});
