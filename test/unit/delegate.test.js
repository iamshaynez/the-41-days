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
  // 直接构造指派（不借 planDusk 的排序——排序是状态感知的，夜用例不该跟着变）
  const who = s.chars.find((c) => c.alive && c.wound < 3 && c.sick < 3);
  return resolveInput(s, pack, [{ type: 'dusk_assign', scavenger: who.id, location: loc, gear: [], others: {} }]).state;
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

  test('地点排序看得见状态：搜空的降权，没翻过的优先（实测：选项里全是搜空的地点，没有出路）', () => {
    let s = newRun();
    s = resolveInput(s, pack, [{ type: 'advance' }]).state;
    // 南市全搜空；医棚没去过（全新鲜）——首方案必须指向有货的地方
    const market = pack.locMap.market;
    const conts = (market.rooms || []).flatMap((r) => r.containers || []);
    s.locState.market = { searched: Object.fromEntries(conts.map((c) => [c.id, 1])), npcState: {} };
    s.knownLocs.push('hospital');
    const top = planDusk(s, pack).plans.find((p) => p.intent.scavenger && p.intent.location);
    assert.notEqual(top.intent.location, 'market', '不派去搜空的南市');
    assert.ok(top.intent.location === 'church' || top.intent.location === 'hospital', '首方案指向没翻过的起步地（府库/医棚皆可）');
  });

  test('全搜空也有出路：最久未访的排第一（回补在重访时掷骰），hint 点明重访', () => {
    let s = newRun();
    s = resolveInput(s, pack, [{ type: 'advance' }]).state;
    s.day = 20;
    // 两个已知地点都搜空：南市 day2 搜的、宅区 day12 搜的——南市更久没走，回补期望高
    for (const [locId, day] of [['market', 2], ['villas', 12]]) {
      const loc = pack.locMap[locId];
      const conts = (loc.rooms || []).flatMap((r) => r.containers || []);
      s.locState[locId] = { searched: Object.fromEntries(conts.map((c) => [c.id, day])), npcState: {} };
    }
    s.knownLocs = ['home', 'market', 'villas'];
    const top = planDusk(s, pack).plans.find((p) => p.intent.scavenger && p.intent.location);
    assert.equal(top.intent.location, 'market', '全空时派去最久未访的（重访才有回补）');
    assert.match(top.hint, /重访/, 'hint 告诉玩家这是重访碰回补，不是白跑');
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

  test('路子进选项（玩家看见→选择→角色实现）：没斧时今日卡出「先打斧再劈柴」，没铁砧时出「搭铁砧」', () => {
    // 没斧、铁砧在手、料齐：策略选项直接亮出这条链
    let s = newRun();
    s.inventory.firewood = 0; s.inventory.wood = 2; s.inventory.comp = 3; s.inventory.axe = 0;
    s.facilities.metal = 1; s.homeFurniture = 3;
    let sg = suggests(s, pack);
    const forge = sg.find((x) => /打把斧头|先打斧/.test(x.label) && x.intents?.some((i) => i.action === 'craft' && i.target === 'make_axe'));
    assert.ok(forge, `出「先打斧再劈柴」策略行：${sg.map((x) => x.label).join('｜')}`);
    assert.ok(forge.intents.some((i) => i.action === 'chop'), '打完斧头接着劈（同批链式）');
    assert.equal(forge.intents.at(-1).type, 'auto_day', '照旧收卷');
    // 没斧也没铁砧、入冬在即、料齐：亮出「搭铁砧」这条路
    s.facilities.metal = 0; s.inventory.wood = 8; s.inventory.parts = 12; s.inventory.comp = 6;
    s.day = Math.max(1, (s.winterStart || 10) - 3);
    sg = suggests(s, pack);
    assert.ok(sg.some((x) => /铁砧/.test(x.label) && x.intents?.some((i) => i.action === 'build' && i.target === 'metal')), '出「搭铁砧」策略行');
    // 柴足时不出（不唠叨）
    s.inventory.firewood = 8;
    assert.ok(!suggests(s, pack).some((x) => /斧头|铁砧/.test(x.label)), '柴足不唠叨');
  });

  test('输入即实现（角色张罗，考虑用户 input）：打「劈柴补柴」没斧但可造——先造后劈，不再被「没有斧头」挡死', () => {
    const s = newRun();
    s.inventory.firewood = 0; s.inventory.wood = 2; s.inventory.comp = 3; s.inventory.axe = 0;
    s.facilities.metal = 1; s.homeFurniture = 3;
    s.facilities.stove = 1; // 别让建造序抢人
    const r = resolveInput(structuredClone(s), pack, [{ type: 'act', actor: s.chars[0].id, action: 'chop' }]);
    assert.ok(r.facts.some((f) => f.k === 'self_reliant'), '角色自足落账（先造后劈）');
    assert.ok(r.facts.some((f) => f.k === 'chop'), '斧头打出来，柴也劈上了');
    assert.ok((r.state.inventory.firewood || 0) >= 1, '真劈出柴');
  });

  test('求生本能（玩家不施法）：断粮时托管日自动刨野菜——不依赖关键词与选项，代价照记', () => {
    const s = newRun();
    for (const k of ['meal', 'canned', 'raw', 'meat', 'veg']) s.inventory[k] = 0;
    const plan = planDay(s, pack);
    assert.ok(plan.some((i) => i.action === 'forage' && i.delegated), '管家自动安排刨野菜（角色自己努力活下去）');
    // E2E：托管一整天，家里真的有了口粮，心情真的掉了——玩家承担后果
    const r = resolveInput(structuredClone(s), pack, [{ type: 'auto_day' }]);
    assert.ok((r.state.inventory.veg || 0) >= 1, '蔬米入账');
    const moods = r.state.chars.map((c) => c.moodPts);
    assert.ok(moods.some((m) => m < 0) || r.facts.some((f) => f.k === 'forage'), '苦活的代价落在人身上');
    // 有粮时不多挖（不是农场）
    const s2 = newRun();
    s2.inventory.raw = 6;
    assert.ok(!planDay(s2, pack).some((i) => i.action === 'forage'), '有粮不挖——保底不是产业');
  });

  test('道德换资源·搜身：放倒的人可搜出携带物（道德账照记），活人搜不得', () => {
    let s = toNight('market');
    if (s.phase !== 'night' || !s.night) return; // 防御：夜访没建成
    const npc = (pack.locMap.market.npcs || [])[0];
    assert.ok(npc && (npc.carry || []).length, '前提：溃兵带携带物（内容契约——杀夺要有产）');
    s.locState.market.npcState[npc.id] = 'down';
    const r = resolveInput(s, pack, [{ type: 'night', action: 'search', target: npc.id }]);
    assert.ok(r.facts.some((f) => f.k === 'night_rob'), '搜身落道德账（steal_civ——从人身上拿东西）');
    assert.ok(r.facts.some((f) => f.k === 'night_search_hit'), '真拿到东西（kill→search 链有产）');
    assert.equal(s.locState.market.npcState[npc.id], 'looted', '搜过记账（不重复产）');
    // 活人搜不得
    const s2 = toNight('market');
    if (s2.phase === 'night' && s2.night) {
      const npc2 = (pack.locMap.market.npcs || [])[0];
      s2.locState.market.npcState[npc2.id] = 'greeted';
      const r2 = resolveInput(s2, pack, [{ type: 'night', action: 'search', target: npc2.id }]);
      assert.ok(!r2.facts.some((f) => f.k === 'night_rob'), '活人身上搜不得');
    }
  });

  test('保底活路·挖野菜：任何处境都挖得到（最低效口粮），代价是心情——想活总有办法，体面难', () => {
    const s = newRun();
    s.inventory.veg = 0;
    const before = s.chars[0].moodPts;
    const r = resolveInput(s, pack, [{ type: 'act', actor: s.chars[0].id, action: 'forage' }]);
    assert.equal(r.state.inventory.veg, 1, '挖到 1 蔬菜（两蔬一锅的最低效口粮——饿不死，也吃不饱）');
    assert.ok(r.facts.some((f) => f.k === 'forage'), '落账');
    assert.ok(r.state.chars[0].moodPts < before, '心情受损（苦活屈辱）');
    const w = newRun(); w.winterActive = true;
    const r2 = resolveInput(w, pack, [{ type: 'act', actor: w.chars[0].id, action: 'forage' }]);
    assert.equal((r2.state.inventory.veg || 0) - 0, 1, '冬天也有挖（保底不因季节断）');
    assert.ok(r2.state.chars[0].moodPts < r.state.chars[0].moodPts - 0.5, '冬天心情代价更大');
  });

  test('管家常识·燃料保障：柴见底时有斧有家具，托管日自动劈——玩家不学链路', () => {
    let s = newRun();
    s.inventory.firewood = 0; s.inventory.wood = 0; s.inventory.book = 0;
    s.inventory.axe = 1; s.homeFurniture = 3;
    const plan = planDay(s, pack);
    assert.ok(plan.some((i) => i.type === 'act' && i.action === 'chop' && i.delegated), '管家自动安排劈柴');
    // 托管收卷一整天，柴真的多起来（E2E：auto_day 走完）
    const r = resolveInput(structuredClone(s), pack, [{ type: 'auto_day' }]);
    assert.ok((r.state.inventory.firewood || 0) >= 1, `劈出真柴（得 ${r.state.inventory.firewood}）`);
  });

  test('管家常识·工具前置：柴见底、没斧、铁砧在手且料齐——先造斧再劈（同日链式）', () => {
    const s = newRun();
    s.inventory.firewood = 0; s.inventory.wood = 2; s.inventory.book = 0; s.inventory.comp = 3;
    s.inventory.axe = 0; s.homeFurniture = 3; s.facilities.metal = 1;
    const plan = planDay(s, pack);
    assert.ok(plan.some((i) => i.type === 'act' && i.action === 'craft' && i.target === 'make_axe'), '管家先造斧');
  });

  test('管家常识·设施前置：入冬在即、缺斧缺铁砧、料齐——建造序里升起铁砧', () => {
    const s = newRun();
    s.day = Math.max(1, (s.winterStart || 10) - 3); s.winterActive = false;
    s.inventory.firewood = 0; s.inventory.wood = 8; s.inventory.parts = 12; s.inventory.comp = 6;
    s.inventory.axe = 0; s.homeFurniture = 3;
    s.facilities.stove = 1; s.facilities.metal = 0; // 别让炉灶抢建造位
    const plan = planDay(s, pack);
    assert.ok(plan.some((i) => i.type === 'act' && i.action === 'build' && i.target === 'metal'), '冬前缺斧链时管家建铁砧');
  });

  test('管家常识·按需派工：粮荒时黄昏首选富粮地（医棚零粮让位给宅区）', () => {
    let s = newRun();
    s = resolveInput(s, pack, [{ type: 'advance' }]).state;
    // 粮荒：全家只剩 1 份口粮
    for (const k of ['meal', 'canned', 'raw', 'meat', 'veg']) s.inventory[k] = 0;
    s.inventory.raw = 1;
    // 医棚（threat 0、零粮）与宅区（threat 1、富粮）都没翻过——旧排序医棚在前
    const top = planDusk(s, pack).plans.find((p) => p.intent.scavenger && p.intent.location);
    assert.notEqual(top.intent.location, 'hospital', '粮荒时不该首选零粮的医棚');
    assert.ok(['market', 'villas', 'church'].includes(top.intent.location), `首选富粮地（实际 ${top.intent.location}）`);
  });

  test('工具链教学（实测：砍柴火→没有斧头，链路断裂）：拒绝带路径、劈柴出名实相符的柴', () => {
    // 没斧头：拒绝要说清斧头从哪来（打造/军辎营），不是一句「没有斧头」把人挡死
    let s = newRun();
    s.inventory.axe = 0; s.homeFurniture = 3;
    const r1 = resolveInput(structuredClone(s), pack, [{ type: 'act', actor: s.chars[0].id, action: 'chop' }]);
    const nt = r1.facts.find((f) => f.k === 'no_tool');
    assert.ok(nt, 'no_tool 落账');
    assert.ok(nt.how && /打造|军辎营|铁砧/.test(nt.how), `拒绝要带获取路径：${nt.how}`);
    // 有斧头：劈家具出板材也出柴（「劈柴」名实相符——板材能代柴烧饭，柴能取暖）
    s.inventory.axe = 1;
    const r2 = resolveInput(s, pack, [{ type: 'act', actor: s.chars[0].id, action: 'chop' }]);
    assert.ok(r2.facts.some((f) => f.k === 'chop'), '劈成');
    assert.ok((r2.state.inventory.firewood || 0) >= 1, '劈家具至少得 1 柴（取暖只认柴）');
    assert.ok((r2.state.inventory.wood || 0) >= 2, '也得板材（烧饭/建材）');
  });

  test('柴将尽预警进晨报：有斧指劈家具，没斧指打造/夜访路径', () => {
    const s = newRun();
    s.inventory.firewood = 0; s.inventory.wood = 1;
    const line = dawnProblems(s, pack).find((p) => p.key === 'fuel_low');
    assert.ok(line, '柴将尽占一行');
    assert.ok(/斧/.test(line.text), '要点出斧头链路');
    // 有斧有家具：指向劈旧家具
    s.inventory.axe = 1; s.homeFurniture = 2;
    const line2 = dawnProblems(s, pack).find((p) => p.key === 'fuel_low');
    assert.ok(/劈/.test(line2.text), '有斧时指劈家具');
  });

  test('白天能做的事要看得见：疲惫补觉 / 家里没翻完的角落 / 劈家具攒柴', () => {
    // 玩家实测反馈：白天能做的太少。先把已有动作一键化亮出来——
    // 补觉、搜家、劈柴都是既有机制，缺的是入口。
    const s = newRun();
    s.chars[0].fatigue = 2; s.chars[0].ap = 3; // 有人疲惫且有力气打盹
    s.inventory.axe = 1; s.homeFurniture = 2;
    s.inventory.firewood = 0; s.inventory.wood = 0;
    s.house.opened.kitchen = true; s.house.searched = {}; // 厨房开着、柜子没翻
    const sg = suggests(s, pack);
    assert.ok(sg.some((x) => x.label.includes('补一觉') && x.intents.some((i) => i.action === 'sleep' && i.actor === s.chars[0].id)), '疲惫补觉一键（带人名的动作）');
    assert.ok(sg.some((x) => x.label.includes('翻') && x.intents.some((i) => i.action === 'search_home')), '家里没翻完的角落一键');
    assert.ok(sg.some((x) => x.label.includes('劈') && x.intents.some((i) => i.action === 'chop')), '劈家具攒柴一键（柴与板材见底时）');
    for (const x of sg) if (x.intents) assert.equal(x.intents.at(-1).type, 'auto_day', `${x.label} 也要收卷`);
    // 不缺柴时不出劈柴行
    s.inventory.firewood = 6;
    assert.ok(!suggests(s, pack).some((x) => x.label.includes('劈')), '柴够了就不唠叨');
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
