// 事件卡选项结算（内核设计 §8：效果白名单 + riskCheck）与战争后日谈（§9）。
import { charById, combatModOf, aliveChars } from './state.js';
import { applyDayAction } from './dayActions.js';
import { genFrankoStock } from './trade.js';
import { recordCausal, eventVerb } from './causality.js';
import { buildStoryline } from './storyline.js';
import { maybeFireLocScript, combatRound } from './night.js';

/** 是否满足选项前置（物品/任一物品） */
export function optionAvailable(ctx, option) {
  const s = ctx.s;
  const req = option.requires || {};
  if (req.item && !ctx.hasItem(req.item)) return false;
  if (req.anyItem && !req.anyItem.some((i) => ctx.hasItem(i))) return false;
  if (req.doc && !s.docsSeen.includes(req.doc)) return false; // 文档门槛（濠鼠活证：先读过勘验才问得出口）
  if (req.flag && !s.eventFlags[req.flag]) return false;
  return true;
}
export function optionCostOk(ctx, option) {
  // cost 为“任选其一”的消耗组（同一物品可多件）——按组内第一件可用者
  for (const cst of option.cost || []) if (ctx.hasItem(cst.item, cst.n)) return true;
  return !(option.cost || []).length;
}

/** 玩家选了事件卡选项 */
export function chooseEventOption(ctx, optionKey) {
  const s = ctx.s;
  const ev = s.activeEvent;
  if (!ev) return { ok: false, reason: 'NO_EVENT' };
  const card = ctx.pack.cardMap[ev.cardId] || s.geCards?.[ev.cardId]; // C 层生成卡走 run 级卡册
  if (!card) return { ok: false, reason: 'NO_CARD' };
  const option = (card.options || []).find((o) => o.key === optionKey);
  if (!option) return { ok: false, reason: 'BAD_OPTION' };
  if (!optionAvailable(ctx, option) || !optionCostOk(ctx, option)) {
    ctx.fact('option_unavailable', { key: optionKey });
    return { ok: false, reason: 'UNAVAILABLE' };
  }
  s.activeEvent = null;
  ctx.emit('EVENT_CHOSEN', { cardId: card.id, option: optionKey });
  // 夜间 NPC 剧本落幕：若无更具体的处置（npcState 效果/战斗），记为"打过照面"，管家不再为他停问
  if (ev.night && s.night && !s.night.home) {
    const loc = ctx.pack.locMap[s.night.locId];
    const npc = (loc?.npcs || []).find((x) => x.firstScript === card.id);
    const st = npc && s.locState[s.night.locId];
    if (npc && st && !st.npcState[npc.id]) {
      st.npcState[npc.id] = 'greeted';
      ctx.emit('NPC_STATE', { loc: s.night.locId, npc: npc.id, state: 'greeted' });
    }
  }
  // 因果埋点：求助/捐赠/拒助（登记表见 causality.EVENT_VERBS）
  const verb = eventVerb(card.id, optionKey);
  if (verb) {
    const tgt = card.actor || card.for || null;
    // 夜间剧本卡的见证者只有外出者本人（CY-06）；序章卡打 prologue 标签（回忆录序章段）
    recordCausal(ctx, verb, {
      target: tgt,
      witnesses: ev.night && ev.actorId ? [ev.actorId] : undefined,
      note: card.title,
      tags: card.kind === 'prologue' ? ['prologue'] : []
    });
  }
  applyEffects(ctx, card, option, ev);
  // 夜访链续火（北津台或然 A 的三段）：选项落旗后，同地同夜续点下一拍
  if (s.night && !s.night.home && !s.activeEvent) {
    const loc = ctx.pack.locMap[s.night.locId];
    if (loc) maybeFireLocScript(ctx, loc, charById(s, s.night.charId) || { id: s.night.charId });
  }
  return { ok: true };
}

function applyEffects(ctx, card, option, ev) {
  const s = ctx.s, e = option.effects || {};
  // 消耗（cost 组取第一个持有项；consumeChoice 同）
  for (const cst of option.cost || []) {
    if (ctx.hasItem(cst.item, cst.n)) { ctx.takeItem(cst.item, cst.n, '事件'); break; }
  }
  if (e.consumeChoice) {
    for (const it of e.consumeChoice) if (ctx.hasItem(it)) { ctx.takeItem(it, 1, '事件'); break; }
  }
  // 心情：all / softHearted+default / 指定角色 / actor
  if (e.mood) {
    const m = e.mood;
    if (m.all !== undefined) {
      if (ev.night && ev.actorId) { const c = charById(s, ev.actorId); if (c) ctx.mood(c, m.all, card.id, { helpMul: false }); }
      else for (const c of aliveChars(s)) ctx.mood(c, m.all, card.id);
    }
    if (m.softHearted !== undefined) {
      for (const c of aliveChars(s)) ctx.mood(c, c.softHearted ? m.softHearted : m.default, card.id);
    } else if (m.default !== undefined) {
      for (const c of aliveChars(s)) ctx.mood(c, m.default, card.id);
    }
    for (const [id, v] of Object.entries(m)) {
      if (['all', 'default', 'softHearted', 'actor'].includes(id)) continue;
      const c = charById(s, id); if (c) ctx.mood(c, v, card.id);
    }
    if (m.actor !== undefined && ev.actorId) {
      const c = charById(s, ev.actorId); if (c) ctx.mood(c, m.actor, card.id);
    }
  }
  if (e.reputation) for (const [k, v] of Object.entries(e.reputation)) ctx.reputation(k, v);
  if (e.items) for (const [k, v] of Object.entries(e.items)) ctx.addItem(k, v, '事件'); // 得物（别传日卡/GE 白名单同款）
  if (e.knowledge) ctx.addKnowledge(e.knowledge, card.id);
  if (e.flags) {
    const flags = { ...s.eventFlags };
    let shovel = s.shovelReturnDay;
    for (const [k, v] of Object.entries(e.flags)) {
      if (k === 'shovel_return_day') { shovel = s.day + parseInt(String(v).replace('+', ''), 10); continue; }
      // "+N" = 相对天数旗标（停火窗口/灯塔倒计时这类）
      if (typeof v === 'string' && v.startsWith('+')) flags[k] = s.day + parseInt(v.slice(1), 10);
      else flags[k] = v;
    }
    s.eventFlags = flags;
    ctx.emit('FLAG', { key: 'eventFlags', val: structuredClone(flags) });
    if (shovel !== s.shovelReturnDay) { s.shovelReturnDay = shovel; ctx.emit('FLAG', { key: 'shovelReturnDay', val: shovel }); }
    // 出江陵线：拒绝之后，鲁舟不再泊船
    if (flags.franko_gone) {
      s.franko = null;
      s.frankoNextDay = 9999;
      ctx.emit('FLAG', { key: 'frankoNextDay', val: 9999 });
    }
  }
  if (e.ap_cost) {
    const c = ev.actorId ? charById(s, ev.actorId) : null;
    if (c) { ctx.spendAp(c, e.ap_cost); }
  }
  if (e.flagTonight === 'assist_neighbor') s.assistTonight = true;
  if (e.npcState && ev.night) {
    const st = s.locState[s.night?.locId || ''];
    if (st) for (const [k, v] of Object.entries(e.npcState)) st.npcState[k] = v;
  }
  if (e.abortNight && s.night) { // 撤离夜访
    const n = s.night;
    ctx.emit('NIGHT_ENDED', { loc: n.locId, reason: 'abort' });
    s.night = null; s.phase = 'dawn';
    ctx.fact('night_abort', {});
  }
  if (e.openTrade) {
    if (e.openTrade === 'hospital') {
      const stock = hospitalStock(ctx);
      s.franko = { merchant: 'hospital', stock };
      ctx.emit('FRANKO_ARRIVE', { stock });
      ctx.fact('hospital_trade_open', {});
    }
    return;
  }
  if (e.stealValue !== undefined) {
    // 夜窃效果（逃兵那类）：按价值扣物
    let left = e.stealValue;
    const items = ctx.pack.items.filter((i) => (s.inventory[i.id] || 0) > 0).sort((a, b) => b.value - a.value);
    for (const it of items) { while ((s.inventory[it.id] || 0) > 0 && left > 0) { ctx.takeItem(it.id, 1, '失窃'); left -= it.value; } }
  }
  if (e.text) ctx.fact('event_text', { text: e.text });
  if (e.wound && ev.actorId) {
    const c = charById(s, ev.actorId); if (c) ctx.setWound(c, c.wound + e.wound);
  }
  // riskCheck（GE-03 白名单：一次检定，伤上限 1）
  if (option.riskCheck) {
    const rc = option.riskCheck;
    let mod = 0;
    if (ev.actorId) {
      const c = charById(s, ev.actorId);
      if (c) {
        mod = rc.stealth ? (c.traits?.stealthy || 0) : rc.combat ? combatModOf(c) + 1 : 0;
        if (rc.ambush) mod += 1;
      }
    }
    const r = ctx.check(card.id + ':' + option.key, mod);
    const br = r.outcome === 'fail' ? rc.onFail : (r.outcome === 'cost' ? { ...(rc.onPass || {}), ...(rc.onCost || {}) } : rc.onPass);
    if (br) applyEffects(ctx, card, { key: option.key + ':r', label: '', effects: br, cost: [] }, ev);
    // 检定失败转入战斗（修 v1 遗留：onFail.combat 曾被静默丢弃——偷袭失败从没真打起来过）
    if (br?.combat && ev.night && s.night && !s.night.home) {
      const loc = ctx.pack.locMap[s.night.locId];
      const npc = (loc?.npcs || []).find((x) => x.id === br.combat);
      const c = ev.actorId ? charById(s, ev.actorId) : null;
      if (npc && c) combatRound(ctx, npc, c, { surprise: false });
    }
  }
}

function hospitalStock(ctx) {
  // 医院药剂师：药换食物（E-08）——小摊
  return [
    { item: 'bandage', n: 1, buy: 24 },
    { item: 'herbmed', n: 2, buy: 18 },
    { item: 'meds', n: 1, buy: 30 }
  ];
}

// —— 战争后日谈（N 系）——
const DEED_TIERS = {
  kill_civ: { bad: 1, weight: 6 },
  steal_civ: { bad: 1, weight: 3 },
  kill_enemy: { neutral: 1, weight: 2 },
  help: { good: 1, weight: 3 },
  donate: { good: 1, weight: 4 }
};
export function buildEnding(state, pack) {
  const s = state;
  const alive = s.chars.filter((c) => c.alive);
  const dead = s.chars.filter((c) => !c.alive);
  const chars = [...alive, ...dead].map((c) => {
    const deeds = s.deeds.filter((d) => d.actor === c.id);
    let good = 0, bad = 0;
    for (const d of deeds) {
      const t = DEED_TIERS[d.type];
      if (!t) continue;
      if (t.good) good += t.weight; if (t.bad) bad += t.weight;
    }
    const fate = !c.alive
      ? `没能撑过去。第 ${deathsDay(s, c.id)} 天，橘里的墙上多了一个名字。`
      : bad > good + 4 ? '活下来了，但有些夜晚会突然惊醒，手先于他摸向不存在的刀。'
      : good > bad + 4 ? '活下来了。战争结束后很久，还有人敲他家的门——为了道谢，不是为了讨债。'
      : '活下来了。就是活下来了。在这个年头，这四个字已经够写一整页。';
    return { id: c.id, name: c.name, alive: c.alive, fate };
  });
  // 三件事（EX-02）：戏剧分 top3
  const drama = [];
  for (const d of s.deeds) {
    const w = DEED_TIERS[d.type]?.weight || 1;
    drama.push({ day: d.day, text: `${d.actor} · ${d.type} · ${d.target}`, w });
  }
  const three = drama.sort((a, b) => b.w - a.w || b.day - a.day).slice(0, 3);
  // 别传结局（长线体验-v0.2 §3.4）：按旗标选变体，史书体/批注进史册格
  if (s.sidestory) {
    const def = pack.sideMap[s.sidestory.id];
    const variant = (def.ending.variants || []).find((v) => (v.whenFlags || []).every((f) => s.eventFlags[f]));
    const chosen = variant || def.ending.default;
    const ending = {
      type: 'sidestory',
      day: s.day,
      sidestory: { id: def.id, title: def.title },
      chars,
      threeThings: three,
      docs: s.docsSeen,
      knowledge: s.knowledge,
      storyline: (() => { const st2 = buildStoryline(s, pack); st2.title = `${def.title} · ${chosen.title}`; st2.annals = [{ text: chosen.text, note: chosen.note, ending: 'side_' + def.id }]; return st2; })()
    };
    return ending;
  }
  return {
    type: s.war.endingType || 'wiped',
    day: s.day,
    chars,
    threeThings: three,
    docs: s.docsSeen,
    knowledge: s.knowledge,
    // 因果引擎：这一局的完整故事线与人的账（CY-33/EPI-01）
    storyline: buildStoryline(s, pack)
  };
}
function deathsDay(s, id) {
  const d = s.deeds.find((x) => x.actor === id && x.type === 'died');
  return d ? d.day : s.day;
}
