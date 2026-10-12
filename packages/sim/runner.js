// 平衡模拟器（技术架构 §11）：无头、无 LLM；机器人策略直接对 core 下意图，KPI 门禁读内容包 kpis.json。
// 'delegate' 策略不是机器人——它就是游戏内管家本人（planDay/planDusk/auto_night），
// 用来证明"玩家全部委托"这条新玩法路径的平衡性与机器人均衡策略同带。
import { createRun, beginRun, resolveInput, planDay, planDusk, planNightStep, tradeDeals } from '../core/index.js';
import { operatorPolicy } from './bots.js';

/**
 * 跑 N 局。
 * @returns {{runs: Array, kpis: object}} 每局 {seed, policy, days, alive, ending, docs, deaths:[{cause}]}
 */
export function runSim(pack, { runs = 300, seed = 41001, policies = ['balanced'], maxDays = 62 } = {}) {
  const out = [];
  for (const policy of policies) {
    for (let i = 0; i < runs; i++) {
      const runSeed = seed + i * 7919 + policy.length;
      out.push(playOne(pack, runSeed, policy, maxDays));
    }
  }
  return { runs: out, kpis: computeKpis(out, policies), gates: pack.kpis.gates, generatedAt: new Date().toISOString() };
}

function playOne(pack, seed, policyName, maxDays) {
  const state = createRun(pack, { seed });
  const { events } = beginRun(state, pack);
  let s = state;
  const policy = operatorPolicy(policyName);
  let steps = 0;
  while (!s.over && s.day < maxDays && steps++ < 500) {
    s = policyName === 'delegate' ? takeTurnDelegate(s, pack) : takeTurn(s, pack, policy, policyName);
  }
  if (!s.over) { // 理论上 D60 必终局
    s.over = true; s.ending = { type: 'timeout', day: s.day };
  }
  const deaths = s.chars.filter((c) => !c.alive).map((c) => c.name);
  return {
    seed, policy: policyName, days: s.day,
    alive: s.chars.filter((c) => c.alive).length,
    ending: s.ending?.type || 'wiped',
    docs: s.docsSeen.length,
    knowledge: s.knowledge,
    deaths
  };
}

function takeTurn(s, pack, policy, policyName) {
  const step = (intents) => resolveInput(s, pack, intents).state;
  // 事件处理：一律选第一个无需消耗的选项
  if (s.activeEvent) {
    const card = pack.cardMap[s.activeEvent.cardId];
    const opt = card?.options?.find((o) => !o.cost && !o.requires)?.key ?? card?.options?.[0]?.key;
    if (opt) s = step([{ type: 'event_choice', option: opt }]);
  }
  const dayActs = policy.day(s, pack) || [];
  s = step([...dayActs, { type: 'advance' }]);
  if (s.over) return s;
  // 黄昏
  const plan = policy.dusk(s, pack);
  s = step([plan]);
  if (s.over || !s.night) return s;
  if (!s.night.home) {
    let g = 0;
    while (s.phase === 'night' && s.night && !s.night.home && g++ < 14) {
      if (s.activeEvent) {
        const card = pack.cardMap[s.activeEvent.cardId];
        const opt = card?.options?.find((o) => !o.cost && !o.requires)?.key ?? card?.options?.[0]?.key;
        if (opt) { s = step([{ type: 'event_choice', option: opt }]); continue; }
      }
      const before = s.night.slots;
      const act = policy.night(s, pack);
      if (!act) { s = step([{ type: 'night', action: 'retreat' }]); break; }
      s = step([act]);
      if (s.night && !s.night.home && s.night.slots === before) {
        // 卡住（无容器/门挡）→ 试换房间，再退
        const loc = pack.locMap[s.night.locId];
        const idx = loc.rooms.findIndex((r) => r.id === s.night.room);
        const next = loc.rooms[idx + 1];
        if (next) {
          const openAct = next.door === 'locked' ? { type: 'night', action: 'open', target: next.id }
            : next.door === 'rubble' ? { type: 'night', action: 'clear', target: next.id }
            : next.door === 'bars' ? { type: 'night', action: 'bars', target: next.id }
            : { type: 'night', action: 'move', target: next.id };
          const r2 = step([openAct]);
          s = r2;
          if (s.night && !s.night.home && s.night.room !== next.id) {
            const r3 = step([{ type: 'night', action: 'move', target: next.id }]);
            s = r3;
            if (s.night && !s.night.home && s.night.room !== next.id) { s = step([{ type: 'night', action: 'retreat' }]); break; }
          }
        } else { s = step([{ type: 'night', action: 'retreat' }]); break; }
      }
      if (!s.night || s.night.home) break;
    }
    if (s.phase === 'night' && s.night && !s.night.home) s = step([{ type: 'night', action: 'retreat' }]);
  }
  return s;
}

/** 管家自驾一整局：事件一律选首个零成本项（与机器人同口径），白天 auto_day，黄昏第一方案，夜里 auto_night 遇岔路选第一项 */
function takeTurnDelegate(s, pack) {
  const step = (intents) => resolveInput(s, pack, intents).state;
  const answerEvent = () => {
    if (!s.activeEvent) return false;
    const card = pack.cardMap[s.activeEvent.cardId];
    const opt = card?.options?.find((o) => !o.cost && !o.requires)?.key ?? card?.options?.[0]?.key;
    if (opt) s = step([{ type: 'event_choice', option: opt }]);
    return true;
  };
  while (answerEvent());
  // 商人在门口时的成交已并入 planDay（水下交易：管家每访自取一笔建议单）
  s = step([{ type: 'auto_day' }]);
  if (s.over) return s;
  while (answerEvent());
  if (s.phase === 'day') s = step([{ type: 'advance' }]);
  if (s.phase !== 'dusk') return s;
  const plans = planDusk(s, pack).plans;
  if (!plans.length) return s;
  s = step([plans[0].intent]);
  let g = 0;
  while (s.phase === 'night' && s.night && !s.night.home && g++ < 14) {
    if (answerEvent()) continue;
    s = step([{ type: 'auto_night' }]);
    if (s.phase === 'night' && s.night && !s.night.home && !s.activeEvent) {
      const forkStep = planNightStep(s, pack, {});
      if (forkStep?.stop?.options?.length) s = step(forkStep.stop.options[0].intents);
      else if (!forkStep) s = step([{ type: 'night', action: 'retreat' }]);
    }
  }
  return s;
}

function computeKpis(runs, policies) {  const by = {};
  for (const p of policies) {
    const rs = runs.filter((r) => r.policy === p);
    if (!rs.length) continue;
    const sorted = rs.map((r) => r.days).sort((a, b) => a - b);
    const median = (a) => a[Math.floor(a.length / 2)];
    const wiped = rs.filter((r) => r.ending === 'wiped');
    const ceasefire = rs.filter((r) => r.ending === 'ceasefire' || r.ending === 'contract_end');
    by[p] = {
      n: rs.length,
      median_days: median(sorted),
      median_alive_days: median(rs.map((r) => r.days).sort((a, b) => a - b)),
      any_survivor_to_end: rs.filter((r) => r.alive > 0 && r.ending !== 'wiped' && r.ending !== 'timeout').length / rs.length,
      wipe_rate: wiped.length / rs.length,
      ceasefire_rate: ceasefire.length / rs.length,
      docs_median: median(rs.map((r) => r.docs).sort((a, b) => a - b)),
      raid_wipe_unknown: null
    };
  }
  return by;
}

/** 门禁断言（CI 用）：返回 {pass, failures[]} */
export function checkGates(report, gates) {
  const failures = [];
  const bal = report.kpis.balanced;
  if (!bal) failures.push('缺 balanced 策略样本');
  else {
    const g = gates;
    const inBand = (v, b) => (b.min === undefined || v >= b.min) && (b.max === undefined || v <= b.max);
    if (!inBand(bal.median_days, g.run_length_days_median)) failures.push(`中位局时长 ${bal.median_days} 越带 ${JSON.stringify(g.run_length_days_median)}`);
    if (!inBand(bal.any_survivor_to_end, g.any_survivor_to_end)) failures.push(`有人活到停火比例 ${bal.any_survivor_to_end.toFixed(2)} 越带 ${JSON.stringify(g.any_survivor_to_end)}`);
    if (!inBand(bal.docs_median, g.docs_per_run_median)) failures.push(`每局文档中位数 ${bal.docs_median} 越带 ${JSON.stringify(g.docs_per_run_median)}`);
    // 恶魔策略（若在样本里）：存活率应显著低于均衡
    const devil = report.kpis.devil;
    if (devil && bal.any_survivor_to_end - devil.any_survivor_to_end < 0.05) failures.push('恶魔策略未受到足够惩罚（存活率差 <5pp）');
  }
  return { pass: failures.length === 0, failures };
}
