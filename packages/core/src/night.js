// 夜间探索引擎（内核设计 §6：时间槽/门与容器/声响/检定/战斗/NPC）。
// 门状态记在 night.unlocked/cleared/sawed（不污染内容对象）；locState 经事件记账。
// 夜野 v0.1：地点不再是同一张桌子——nightRules（恒定性格）× nightTable（每夜夜况）× 天气（跨地变数）
// 三层合成 night.env（槽/声/巡逻/失手/湿陷/寒），开局掷定随 NIGHT_STARTED 落盘可回放。
import { charById, combatModOf, moodLevel, aliveChars } from './state.js';
import { findDoc, docAvailable, applyDayAction } from './dayActions.js';
import { recordCausal } from './causality.js';
import { locInPool } from './unlock.js';
import { stepGateOk } from './mainline.js';

/** 天气对夜的影响系数（manifest.night.env 可覆写；不认识的天气回落恒等） */
const WEATHER_ENV = {
  rain: { noiseMul: 0.7, miss: 0.1, wet: 0.1 },
  fog: { miss: 0.2, patrolMul: 0.7 },
  snow: { patrolMul: 0.8 },
  clear: { patrolMul: 1.15 },
  cold: {}
};

/** threat → 巡逻基线：写显 nightRules.patrol 的地点按写的算；
 *  没写的按威胁推导（threat≤1 无巡逻——教堂与空宅的安静是性格，不是漏洞） */
function patrolBase(loc) {
  if (loc.nightRules && loc.nightRules.patrol !== undefined) return loc.nightRules.patrol;
  return Math.max(0, (loc.threat || 0) - 1) * 0.055;
}

/** 掷夜况并合成环境（纯读 loc/manifest/weather——fold 走 NIGHT_STARTED 载荷，不重算） */
export function rollNightEnv(ctx, loc) {
  const s = ctx.s;
  const rules = loc.nightRules || {};
  const nc = ctx.pack.manifest.night || {};
  const weatherEnv = { ...WEATHER_ENV[s.weather] };
  Object.assign(weatherEnv, (nc.env && nc.env[s.weather]) || {});
  // 夜况：地点夜况表掷一条（无表的地点 env 仍是天气的函数——夜夜仍有小变数）
  const table = loc.nightTable || [];
  const cond = table.length ? ctx.rng.weighted(table.map((c) => ({ w: c.w || 1, c }))).c : null;
  const fx = cond?.fx || {};
  const clamp01 = (x) => Math.max(0, Math.min(0.6, x));
  const env = {
    slots: (rules.slots || 0) + (fx.slots || 0),
    noiseMul: (rules.noiseMul ?? 1) * (fx.noiseMul ?? 1) * (weatherEnv.noiseMul ?? 1),
    patrol: Math.max(patrolBase(loc), fx.patrol || 0) * (weatherEnv.patrolMul ?? 1),
    miss: clamp01((rules.miss || 0) + (fx.miss || 0) + (weatherEnv.miss || 0)),
    wet: clamp01((rules.wet || 0) + (fx.wet || 0) + (weatherEnv.wet || 0)),
    cold: !!(rules.cold || fx.cold),
    lootBias: Object.keys(rules.lootBias || {}).length || Object.keys(fx.lootBias || {}).length
      ? { ...(rules.lootBias || {}), ...(fx.lootBias || {}) } : null
  };
  return { cond, env };
}

/** 夜访中的环境读数（老档/别传无 env 字段 → 全默认，行为与 0.40 一致） */
export function nightEnvOf(n, loc) {
  return n?.env || { slots: 0, noiseMul: 1, patrol: 0, miss: 0, wet: 0, cold: false, lootBias: null };
}

/** 地点恒定的进门心情（乱葬岗这一类：地方本身压人，与夜况无关） */
function rulesMood(loc) {
  return loc.nightRules?.moodOnEnter || 0;
}

export function startNight(ctx, { scavenger, location, gear = [], others = {} }) {
  const s = ctx.s, pack = ctx.pack;
  if (s.phase !== 'dusk') return { ok: false, reason: 'NOT_DUSK' };
  if (location && !s.knownLocs.includes(location)) return { ok: false, reason: 'UNKNOWN_LOC' };
  // 周目池裁剪（城市扩展）：knownLocs 被硬塞也要拦——池外的城门这一世不开
  if (location && !locInPool(s, pack, location)) return { ok: false, reason: 'UNKNOWN_LOC' };
  for (const [id, plan] of Object.entries(others || {})) {
    const c = charById(s, id);
    if (!c) continue;
    if (plan === 'guard') { c.guardTonight = true; c.awakeTonight = true; ctx.emit('CHAR_FLAG', { char: id, key: 'guardTonight', val: true }); ctx.emit('CHAR_FLAG', { char: id, key: 'awakeTonight', val: true }); recordCausal(ctx, 'guard_night', { actor: id, target: 'home' }); }
    else if (plan === 'nurse') nightNurse(ctx, c);
    else if (plan === 'work') nightWork(ctx, c);
    else { c.awakeTonight = false; ctx.emit('CHAR_FLAG', { char: id, key: 'awakeTonight', val: false }); }
  }
  // A-3 协防承诺兑现：白天答应替邻居守门（n_thugs 的 flagTonight），这一夜家里人手都在门外街上——
  // 卡面写着「今夜不可外出」，机制说到做到：出门指派自动降级为在家过夜（不卡阶段、不吃拒绝）
  const assistOverride = s.assistTonight && scavenger && location;
  if (assistOverride) ctx.fact('assist_night', {});
  if (!scavenger || !location || assistOverride) {
    for (const c of s.chars.filter((x) => x.alive)) if (!c.guardTonight) { c.awakeTonight = false; ctx.emit('CHAR_FLAG', { char: c.id, key: 'awakeTonight', val: false }); }
    s.night = { home: true };
    s.phase = 'night';
    ctx.emit('NIGHT_STARTED', { home: true });
    return { ok: true, home: true };
  }
  const c = charById(s, scavenger);
  if (!c) return { ok: false, reason: 'NO_CHAR' };
  // 仅危重者禁外出；饥饿/轻重伤者仍可勉强夜访（虚弱惩罚在检定里，原作口径）
  if (c.wound >= 3 || c.sick >= 3) { ctx.fact('too_weak', { char: c.id }); return { ok: false, reason: 'TOO_WEAK' }; }
  if (c.hunger === 0 || c.wound === 2 || c.sick === 2) ctx.fact('weak_scavenge', { char: c.id });
  if (moodLevel(c.moodPts).key === 'depressed' && ctx.rng.chance(0.5)) { ctx.fact('depressed_refuse', { char: c.id, what: '外出' }); return { ok: false, reason: 'DEPRESSED' }; }
  const loc = pack.locMap[location];
  if (!s.locState[location]) { s.locState[location] = { searched: {}, npcState: {}, scriptsFired: {}, firstVisit: true }; ctx.emit('LOC_NEW', { loc: location }); }
  const st = s.locState[location];
  // E-10 重访演化：搜过足够久的容器有几率被外界重新填上（低质重抽）——
  // 参数住内容包（manifest.night），围城不该是可再生农场
  const nc = ctx.pack.manifest.night || {};
  const refillMinDays = nc.refillMinDays ?? 2;
  const refillChance = nc.refillChance ?? 0.6;
  const refillMul = loc.nightRules?.refillMul ?? 1; // 野外的东西长得回来，城里的东西搬空就空了
  for (const r of loc.rooms) {
    for (const cont of r.containers || []) {
      const when = st.searched[cont.id];
      if (when && s.day - when >= refillMinDays && ctx.rng.chance(Math.min(0.95, refillChance * refillMul))) {
        delete st.searched[cont.id];
        ctx.emit('LOC_REFILL', { loc: location, cont: cont.id });
        ctx.fact('container_refilled', { name: cont.name });
      }
    }
  }
  const carried = [];
  let slotsUsed = 0;
  for (const g of gear) {
    if (!ctx.hasItem(g)) continue;
    ctx.takeItem(g, 1, '携带');
    carried.push(g);
    slotsUsed += pack.itemMap[g].slots || 1;
  }
  // 夜野：掷夜况、合成环境——env 随 night 对象落进 NIGHT_STARTED，回放即重建
  const { cond, env } = rollNightEnv(ctx, loc);
  s.night = {
    home: false, locId: location, charId: c.id,
    room: loc.rooms[0].id, slots: pack.manifest.nightSlots + (s.nightPrep || 0) + env.slots,
    noise: 0,
    pack: carried, packSlots: slotsUsed, cap: c.backpack, observed: {},
    unlocked: {}, cleared: {}, sawed: {}, firstVisit: st.firstVisit,
    gear: [...carried], lowSlotsAck: false,
    env, ...(cond ? { cond: { id: cond.id, name: cond.name, text: cond.text } } : {})
  };
  c.awakeTonight = true;
  ctx.emit('CHAR_FLAG', { char: c.id, key: 'awakeTonight', val: true });
  recordCausal(ctx, 'volunteer', { actor: c.id, target: location });
  // 誓·到地即践（念头演化）：今晚去的就是立誓要去的——结账，晨报撤行，当事人 +1
  for (const d of Object.values(s.directions || {})) {
    if (d.kind !== 'vow' || !d.alive || d.target !== location) continue;
    d.alive = false; d.fulfilledDay = s.day;
    ctx.setFlag('directions', structuredClone(s.directions));
    ctx.fact('vow_fulfilled', { id: d.id, subject: d.subject, text: d.text, day: s.day });
    const vower = d.subject ? charById(s, d.subject) : null;
    if (vower) ctx.mood(vower, 1, '誓约落地');
  }
  s.phase = 'night';
  ctx.emit('NIGHT_STARTED', { loc: location, char: c.id, night: s.night });
  if (s.nightPrep) { ctx.fact('prep_used', { char: c.id, n: s.nightPrep }); s.nightPrep = 0; ctx.emit('FLAG', { key: 'nightPrep', val: 0 }); }
  ctx.fact('night_arrive', { char: c.id, loc: loc.name, slots: s.night.slots });
  if (s.night.cond) {
    ctx.fact('night_cond', { loc: loc.name, name: s.night.cond.name, text: s.night.cond.text, slots: env.slots || 0, patrol: env.patrol > 0 });
    const enterMood = (cond.fx?.mood || 0) + (rulesMood(loc) || 0);
    if (enterMood) ctx.mood(c, enterMood, `夜况：${s.night.cond.name}`);
  }
  // 停火窗口（灰雀线三选择的第三路）：乐谱生效期内，前线没有枪声
  const hushed = location === 'frontline' && (s.eventFlags.crossing_hushed_until || 0) >= s.day;
  if (hushed) ctx.fact('crossing_hushed', {});
  if (!hushed) { maybeFireLocScript(ctx, loc, c); if (!s.activeEvent) maybeFireNpcScript(ctx, loc); }
  return { ok: true };
}

/** 地点脚本触发器（for: "loc:<id>"）：按 scavenger/旗标/文档门槛触发一次性夜访事件 */
export function maybeFireLocScript(ctx, loc, c) {
  const s = ctx.s;
  if (s.activeEvent) return;
  const st = s.locState[loc.id];
  for (const card of ctx.pack.cards.filter((x) => x.for === 'loc:' + loc.id)) {
    if (st.scriptsFired[card.id]) continue;
    const w = card.when || {};
    if (w.requiresChar && w.requiresChar !== c.id) continue;
    if (w.requiresChars && !w.requiresChars.every((id) => charById(s, id))) continue;
    if (w.requiresFlag && !s.eventFlags[w.requiresFlag]) continue;
    if (!stepGateOk(s, ctx.pack, w)) continue; // 主线门控（史实共振）：夜访也能撞上锚步余波
    if (w.requiresDoc && !s.docsSeen.includes(w.requiresDoc)) continue;
    st.scriptsFired[card.id] = true;
    ctx.emit('SCRIPT_FIRED', { loc: loc.id, script: card.id });
    s.activeEvent = { cardId: card.id, night: true, actorId: c.id };
    ctx.emit('EVENT_FIRED', { cardId: card.id, night: true, actorId: c.id });
    ctx.fact('event', { cardId: card.id, title: card.title });
    return;
  }
}

function nightError(ctx, msg) { ctx.fact('night_no', { msg }); return { ok: false, reason: msg }; }

export function applyNightAction(ctx, intent) {
  const s = ctx.s, n = s.night;
  if (s.phase !== 'night' || !n || n.home) return nightError(ctx, '不在夜间探索中');
  if (n.slots <= 0) return forceEnd(ctx, 'slots_out');
  const c = charById(s, n.charId);
  const loc = ctx.pack.locMap[n.locId];
  const room = () => loc.rooms.find((r) => r.id === n.room);

  switch (intent.action) {
    case 'move': {
      const idx = loc.rooms.findIndex((r) => r.id === intent.target);
      const cur = loc.rooms.findIndex((r) => r.id === n.room);
      if (idx < 0 || Math.abs(idx - cur) !== 1) return nightError(ctx, '房间不相邻');
      const dest = loc.rooms[idx];
      const d = dest.door;
      if (d === 'locked' && !n.unlocked[dest.id]) {
        if (c.traits?.breach && carried(ctx, 'crowbar')) {
          ctx.takeItem('crowbar', 1, '归还后带回'); ctx.addItem('crowbar', 1, '取回'); // 消防员随身破门=免槽免声
          n.unlocked[dest.id] = true; ctx.fact('night_breach', { room: dest.name });
        } else return nightError(ctx, '门锁着——先 open（撬棍/开锁器）');
      }
      if (d === 'rubble' && !n.cleared[dest.id]) return nightError(ctx, '瓦砾堵路——需要铲子 clear');
      if (d === 'bars' && !n.sawed[dest.id]) return nightError(ctx, '铁栅栏——需要锯子 bars');
      spend(ctx, 1);
      n.room = dest.id;
      ctx.fact('night_move', { room: dest.name });
      maybeFireNpcScript(ctx, loc);
      return { ok: true };
    }
    case 'open': {
      const dest = loc.rooms.find((r) => r.id === (intent.target || ''));
      if (dest && dest.door === 'locked' && !n.unlocked[dest.id]) {
        const idx = loc.rooms.findIndex((r) => r.id === dest.id);
        const cur = loc.rooms.findIndex((r) => r.id === n.room);
        if (Math.abs(idx - cur) !== 1) return nightError(ctx, '房间不相邻');
        if (carried(ctx, 'lockpick')) {
          spend(ctx, 1);
          if (ctx.rng.chance(0.5)) { removeCarried(ctx, 'lockpick'); ctx.takeItem('lockpick', 1, '折断'); ctx.fact('lockpick_broke', {}); }
          n.unlocked[dest.id] = true;
          ctx.fact('night_unlock', { room: dest.name, quiet: true });
        } else if (carried(ctx, 'crowbar') || ctx.hasItem('crowbar')) {
          if (!carried(ctx, 'crowbar')) { swapCarried(ctx, 'crowbar'); }
          spend(ctx, 1); addNoise(ctx, 1);
          n.unlocked[dest.id] = true;
          ctx.fact('night_unlock', { room: dest.name, quiet: false });
        } else return nightError(ctx, '没有撬棍或开锁器');
        return { ok: true };
      }
      const conts = room().containers || [];
      const cont = conts.find((x) => x.id === intent.target && x.type === 'locked')
        || conts.find((x) => x.type === 'locked' && !s.locState[n.locId].searched[x.id + ':open']);
      if (!cont) return nightError(ctx, '这里没有可撬的锁');
      spend(ctx, 1); addNoise(ctx, 1);
      s.locState[n.locId].searched[cont.id + ':open'] = true;
      ctx.emit('LOC_SEARCHED', { loc: n.locId, cont: cont.id + ':open' });
      ctx.fact('night_open_container', { name: cont.name });
      return { ok: true };
    }
    case 'clear': {
      const dest = loc.rooms.find((r) => r.id === (intent.target || ''));
      if (!dest || dest.door !== 'rubble' || n.cleared[dest.id]) return nightError(ctx, '无瓦砾可清');
      if (!carried(ctx, 'shovel')) return nightError(ctx, '没有铲子');
      spend(ctx, 2); addNoise(ctx, 1);
      n.cleared[dest.id] = true;
      ctx.fact('night_clear', { room: dest.name });
      return { ok: true };
    }
    case 'bars': {
      const dest = loc.rooms.find((r) => r.id === (intent.target || ''));
      if (!dest || dest.door !== 'bars' || n.sawed[dest.id]) return nightError(ctx, '无栅栏可锯');
      if (!carried(ctx, 'saw')) return nightError(ctx, '没有锯子');
      spend(ctx, 1); addNoise(ctx, 1);
      n.sawed[dest.id] = true;
      ctx.fact('night_saw', { room: dest.name });
      return { ok: true };
    }
    case 'observe': {
      spend(ctx, 1);
      const r = room();
      n.observed[r.id] = true;
      const npcsHere = (loc.npcs || []).map((x) => x.name);
      ctx.fact('night_observe', { room: r.name, containers: (r.containers || []).map((x) => x.name), npcs: npcsHere });
      return { ok: true };
    }
    case 'search': {
      const r = room();
      const st = s.locState[n.locId];
      // 搜身（道德换资源的主链）：放倒的人身上有他背着的东西——拿走要记账。
      // 活人身上搜不得（那叫抢活人，另一回事——先放倒再说，账更重）
      {
        const npcHere = (loc.npcs || []).find((x) => x.id === intent.target);
        if (npcHere) {
          if (st.npcState[npcHere.id] !== 'down') return nightError(ctx, '他还没倒下——搜身是对倒下的人做的事');
          spend(ctx, 1);
          st.npcState[npcHere.id] = 'looted';
          ctx.emit('NPC_STATE', { loc: n.locId, npc: npcHere.id, state: 'looted' });
          ctx.addDeed(c.id, 'steal_civ', npcHere.id);
          recordCausal(ctx, 'steal_civ', { actor: 'player', via: c.id, target: npcHere.id, witnesses: [c.id], note: npcHere.name });
          ctx.mood(c, -2, '搜身', { ethics: 'stealCiv' });
          ctx.fact('night_rob', { npc: npcHere.name });
          lootNight(ctx, { id: npcHere.id, name: npcHere.name, loot: npcHere.carry || [] }, c);
          return { ok: true };
        }
      }
      const cont = r.containers?.find((x) => x.id === intent.target) || r.containers?.find((x) => !st.searched[x.id]);
      if (!cont) return nightError(ctx, '没有可搜的容器了');
      if (cont.type === 'buried' && !st.searched[cont.id + ':open']) return nightError(ctx, '埋着的东西——先 dig 挖开（铲子省力，徒手也能挖）');
      if (cont.type === 'locked' && !st.searched[cont.id + ':open']) return nightError(ctx, '容器上着锁，先 open');
      if (st.searched[cont.id]) return nightError(ctx, '搜过了');
      spend(ctx, 1);
      const env = nightEnvOf(n, loc);
      // 黑暗失手（夜野）：看不清的屋子摸黑翻——先 observe 看过一圈，失手减半
      const miss = env.miss * (n.observed[r.id] ? 0.5 : 1);
      if (miss > 0 && ctx.rng.chance(miss)) {
        st.searched[cont.id] = s.day;
        ctx.emit('LOC_SEARCHED', { loc: n.locId, cont: cont.id, day: s.day });
        ctx.fact('search_miss_dark', { name: cont.name });
        return { ok: true };
      }
      // 湿陷（夜野）：水汽漫上来的一格白翻——泽地与船舱的夜比城里短
      if (env.wet > 0 && ctx.rng.chance(env.wet)) {
        spend(ctx, 1);
        ctx.fact('wet_slip', { name: cont.name });
      }
      st.searched[cont.id] = s.day;
      ctx.emit('LOC_SEARCHED', { loc: n.locId, cont: cont.id, day: s.day });
      lootNight(ctx, cont, c);
      return { ok: true };
    }
    // 挖开埋着的容器（夜野·乱葬岗/泽地埋瓮）：铲子两格无声；徒手三格带响，人也会累
    case 'dig': {
      const r = room();
      const st = s.locState[n.locId];
      const cont = r.containers?.find((x) => x.id === (intent.target || '')) || r.containers?.find((x) => x.type === 'buried' && !st.searched[x.id + ':open']);
      if (!cont || cont.type !== 'buried' || st.searched[cont.id + ':open']) return nightError(ctx, '这里没有埋着可挖的东西');
      if (carried(ctx, 'shovel')) {
        spend(ctx, 2);
        ctx.fact('night_dig', { name: cont.name, with: 'shovel' });
      } else {
        spend(ctx, 3); addNoise(ctx, 1);
        ctx.setFatigue(c, c.fatigue + 1, '徒手刨土');
        ctx.fact('night_dig', { name: cont.name, with: 'hands' });
      }
      st.searched[cont.id + ':open'] = true;
      ctx.emit('LOC_SEARCHED', { loc: n.locId, cont: cont.id + ':open' });
      return { ok: true };
    }
    // 巡逻岔路的答法（夜野）：藏进暗处/交出一件东西打发——动手走 attack@patrol
    case 'hide': {
      if (!n.patrol) return nightError(ctx, '没有火把在逼近');
      spend(ctx, 2);
      const mod = (c.traits?.stealthy || 0) + (n.observed[n.room] ? 1 : 0);
      const rk = ctx.check('藏匿', mod);
      if (rk.outcome === 'fail') {
        ctx.fact('patrol_hide_fail', {});
        return patrolCombat(ctx, c);
      }
      clearPatrol(ctx);
      ctx.fact('patrol_evaded', {});
      return { ok: true };
    }
    case 'bribe': {
      if (!n.patrol) return nightError(ctx, '没有火把在逼近');
      const droppable = n.pack.filter((x) => !n.gear.includes(x));
      if (!droppable.length) return nightError(ctx, '身上没有可以交出去的东西');
      // 挑最值钱的一件递出去——巡兵认的是分量不是种类
      const best = droppable.reduce((a, b) => ((ctx.pack.itemMap[b]?.value || 0) >= (ctx.pack.itemMap[a]?.value || 0) ? b : a));
      removeCarried(ctx, best);
      ctx.addItem(best, -1, '打发巡兵');
      clearPatrol(ctx);
      ctx.fact('patrol_bribed', { item: ctx.pack.itemMap[best]?.name || best });
      return { ok: true };
    }
    case 'dialogue': {
      const npc = (loc.npcs || []).find((x) => x.id === intent.target);
      if (!npc) return nightError(ctx, '这里没有这个人');
      spend(ctx, 1);
      if (npc.firstScript && !s.locState[n.locId].scriptsFired[npc.firstScript]) maybeFireNpcScript(ctx, loc, npc);
      else {
        // 说过话了——管家此后不再为这个人停问（岔路只停第一次照面）
        const st = s.locState[n.locId];
        st.npcState[npc.id] = 'greeted';
        ctx.emit('NPC_STATE', { loc: n.locId, npc: npc.id, state: 'greeted' });
        ctx.fact('night_dialogue', { npc: npc.name, stance: npc.stance });
      }
      return { ok: true };
    }
    case 'backstab': {
      const npc = (loc.npcs || []).find((x) => x.id === intent.target);
      if (!npc) return nightError(ctx, '无此目标');
      if (!carried(ctx, 'knife')) return nightError(ctx, '背刺需要刀');
      const st = s.locState[n.locId];
      if (st.npcState[npc.id] === 'alert' || st.npcState[npc.id] === 'down') return nightError(ctx, '无法背刺（已警觉/已倒下）');
      spend(ctx, 1);
      const mod = (c.traits?.stealthy || 0) + (n.observed[n.room] ? 1 : 0);
      const r = ctx.check('背刺', mod);
      if (r.outcome === 'fail') {
        st.npcState[npc.id] = 'alert';
        ctx.emit('NPC_STATE', { loc: n.locId, npc: npc.id, state: 'alert' });
        ctx.fact('night_backstab_fail', { npc: npc.name });
        return combatRound(ctx, npc, c, { surprise: false });
      }
      st.npcState[npc.id] = 'down';
      ctx.emit('NPC_STATE', { loc: n.locId, npc: npc.id, state: 'down' });
      ctx.fact('night_backstab', { npc: npc.name });
      const innocent = npc.stance === 'friendly' || npc.stance === 'neutral';
      ctx.addDeed(c.id, innocent ? 'kill_civ' : 'kill_enemy', npc.id);
      // CY-06 见证规则：夜里的事只有夜里的人知道——留守者不在场，读数为零。
      // 但账记在玩家头上（actor=player）：是他下令的；via 记执行者，复盘时要念他的名字。
      recordCausal(ctx, innocent ? 'kill_civ' : 'kill_enemy', { actor: 'player', via: c.id, target: npc.id, witnesses: [c.id], note: npc.name });
      ctx.mood(c, innocent ? -10 : -1, '夺命', { ethics: innocent ? 'killCiv' : 'killEnemy' });
      return { ok: true };
    }
    case 'attack': {
      // 巡逻不是地点住民：转进遭遇战（打赢照常可搜身——他背的东西掉在地上）
      if (intent.target === 'patrol') {
        if (!n.patrol) return nightError(ctx, '火把已经走了');
        spend(ctx, 1);
        return patrolCombat(ctx, c);
      }
      const npc = (loc.npcs || []).find((x) => x.id === intent.target);
      if (!npc) return nightError(ctx, '无此目标');
      const st = s.locState[n.locId];
      if (st.npcState[npc.id] === 'down') return nightError(ctx, '他已经倒下');
      spend(ctx, 1);
      const surprise = st.npcState[npc.id] !== 'alert';
      return combatRound(ctx, npc, c, { surprise });
    }
    case 'retreat': return forceEnd(ctx, 'retreat');
    // P2 换守：提前收工回家接守——夜访者接过门厅，原守卫去睡后半宿（半宿地板档）
    case 'handover': {
      const guard = aliveChars(s).find((c) => c.guardTonight);
      const me = n ? charById(s, n.charId) : null;
      if (!guard || !me || guard.id === me.id) return nightError(ctx, '家里没有可换的守卫');
      guard.guardTonight = false; guard.awakeTonight = false;
      ctx.emit('CHAR_FLAG', { char: guard.id, key: 'guardTonight', val: false });
      ctx.emit('CHAR_FLAG', { char: guard.id, key: 'awakeTonight', val: false });
      (ctx.nightHalfSlept ||= new Set()).add(guard.id);
      me.guardTonight = true; // awakeTonight 已是 true（整夜在外），接守到天亮
      ctx.emit('CHAR_FLAG', { char: me.id, key: 'guardTonight', val: true });
      ctx.fact('guard_handover', { from: guard.id, to: me.id });
      return forceEnd(ctx, 'handover');
    }
    // —— 管家自动流的岔路应答（零槽消耗：它们是选择，不是动作） ——
    case 'ignore': {
      const npc = (loc.npcs || []).find((x) => x.id === intent.target);
      if (!npc) return nightError(ctx, '这里没有这个人');
      const st = s.locState[n.locId];
      st.npcState[npc.id] = 'ignored'; // 不打扰——管家后续不再为这个人停问
      ctx.emit('NPC_STATE', { loc: n.locId, npc: npc.id, state: 'ignored' });
      ctx.fact('night_ignore', { npc: npc.name });
      return { ok: true };
    }
    case 'push_on': {
      n.lowSlotsAck = true;
      ctx.emit('NIGHT_FORK_ACK', { kind: 'low_slots' });
      return { ok: true };
    }
    default: return nightError(ctx, '未知夜间动作');
  }
}

function carried(ctx, id) {
  const n = ctx.s.night;
  return n && n.pack && n.pack.includes(id);
}

/** 巡逻遭遇战（夜野）：威胁即强度——军营的火把比南市的硬。打赢即清账，顺手捡走他掉的 */
function patrolCombat(ctx, c) {
  const s = ctx.s;
  const loc = ctx.pack.locMap[s.night.locId];
  const th = loc?.threat || 2;
  const patrol = {
    id: 'patrol', name: '巡夜人', stance: 'hostile', armed: th >= 3,
    carry: [
      { item: 'canned', count: [1, 2], w: 2 },
      { item: 'bullet', count: [0, 2], w: th >= 3 ? 2 : 0 },
      { item: 'meal', count: [1, 1], w: 1 }
    ]
  };
  const r = combatRound(ctx, patrol, c, { surprise: true });
  if (r.combat === 'win') { // 巡逻是流动的：倒下即从夜里退场，掉的军粮当场可拾
    lootNight(ctx, { id: 'patrol', name: '巡夜人', loot: patrol.carry }, c);
    ctx.fact('patrol_down', {});
    s.night.patrol = null;
    ctx.emit('NIGHT_PATCH', { patrol: null });
  }
  return r;
}
function clearPatrol(ctx) {
  const s = ctx.s;
  if (!s.night?.patrol) return;
  s.night.patrol = null;
  ctx.emit('NIGHT_PATCH', { patrol: null });
}
function removeCarried(ctx, id) {
  const n = ctx.s.night;
  const i = n.pack.indexOf(id);
  if (i >= 0) { n.pack.splice(i, 1); n.packSlots -= ctx.pack.itemMap[id]?.slots || 1; }
}
/** 库存有但没带在身上的工具，视为放在门口行囊里（同一趟夜访）——简化：可取用 */
function swapCarried(ctx, id) {
  const n = ctx.s.night;
  n.pack.push(id); n.packSlots += ctx.pack.itemMap[id]?.slots || 1;
}

function spend(ctx, n) { ctx.s.night.slots -= n; }
function addNoise(ctx, n) {
  const s = ctx.s;
  s.night.noise += n;
  ctx.emit('NOISE', { to: s.night.noise });
  const env = nightEnvOf(s.night, ctx.pack.locMap[s.night.locId]);
  for (let k = 0; k < n; k++) {
    if (ctx.rng.chance(0.25 * env.noiseMul)) {
      const loc = ctx.pack.locMap[s.night.locId];
      for (const x of loc.npcs || []) if (!s.locState[s.night.locId].npcState[x.id]) {
        s.locState[s.night.locId].npcState[x.id] = 'alert';
        ctx.emit('NPC_STATE', { loc: s.night.locId, npc: x.id, state: 'alert' });
      }
      ctx.fact('night_noise_alert', {});
    }
    // 巡逻（夜野）：火把循声而来——没写巡逻的空地也有威胁，撬棍的每一声都算数
    if (!s.night.patrol && env.patrol > 0 && ctx.rng.chance(env.patrol)) {
      s.night.patrol = { from: s.night.noise };
      ctx.emit('NIGHT_PATCH', { patrol: s.night.patrol });
      ctx.fact('patrol_coming', { loc: ctx.pack.locMap[s.night.locId]?.name });
    }
  }
}

function lootNight(ctx, cont, c) {
  const s = ctx.s;
  const env = nightEnvOf(s.night, ctx.pack.locMap[s.night?.locId]);
  const entries = (cont.loot || []).filter((e) => (e.w || 0) > 0)
    // 夜况偏置（夜野）：涨水冲来的、盗掘者翻剩的——同一张货表，今夜不一样
    .map((e) => { const b = env.lootBias?.[e.item]; return b !== undefined ? { ...e, w: e.w * b } : e; })
    .filter((e) => (e.w || 0) > 0);
  if (entries.length) {
    // 每箱掷 N 次（§12 规格）——次数与命中率住内容包（manifest.night）
    const nc = ctx.pack.manifest.night || {};
    const rolls = nc.lootRolls ?? 2;
    const hitChance = nc.lootHitChance ?? 0.62;
    const gotItems = [];
    for (let roll = 0; roll < rolls; roll++) {
      if (!ctx.rng.chance(hitChance)) continue;
      const e = ctx.rng.weighted(entries);
      const n2 = ctx.rng.range(e.count[0], e.count[1]);
      if (n2 > 0) { addItemCarried(ctx, e.item, n2); gotItems.push({ item: e.item, n: n2 }); }
    }
    if (gotItems.length) ctx.fact('night_search_hit', { char: s.night.charId, items: gotItems, n: gotItems.reduce((a, b) => a + b.n, 0) });
    else ctx.fact('search_miss', {});
  }
  if (cont.docs?.length && ctx.rng.chance(0.5)) {
    const unfound = cont.docs.filter((d) => docAvailable(s, ctx.pack, d));
    if (unfound.length) findDoc(ctx, ctx.rng.pick(unfound), c);
  }
  const loc = ctx.pack.locMap[s.night.locId];
  const pool = (loc.docsPool || []).filter((d) => docAvailable(s, ctx.pack, d));
  if (pool.length && ctx.rng.chance(0.35)) findDoc(ctx, ctx.rng.pick(pool), c);
}

/** 夜间获得：入库存并计入背包（容量约束） */
function addItemCarried(ctx, id, n) {
  const s = ctx.s;
  ctx.addItem(id, n, '夜间搜刮');
  for (let i = 0; i < n; i++) {
    s.night.pack.push(id);
    s.night.packSlots += ctx.pack.itemMap[id]?.slots || 1;
  }
  const droppable = () => s.night.pack.filter((x) => !s.night.gear.includes(x));
  while (s.night.packSlots > s.night.cap && droppable().length) {
    const pool = droppable();
    const drop = pool[ctx.rng.int(pool.length)];
    s.night.pack.splice(s.night.pack.indexOf(drop), 1);
    s.night.packSlots -= ctx.pack.itemMap[drop]?.slots || 1;
    ctx.addItem(drop, -1, '遗落');
    ctx.fact('night_drop', { item: drop });
  }
}
function dropOnePackItem(ctx) {
  const n = ctx.s.night;
  const pool = n?.pack?.filter((x) => !n.gear?.includes(x)) || [];
  if (pool.length) {
    const id = pool[ctx.rng.int(pool.length)];
    n.pack.splice(n.pack.indexOf(id), 1);
    n.packSlots -= ctx.pack.itemMap[id]?.slots || 1;
    ctx.addItem(id, -1, '仓皇遗落');
    ctx.fact('night_drop', { item: id });
  }
}

/** 战斗一轮（C-02 差值裁决带） */
export function combatRound(ctx, npc, c, { surprise = false } = {}) {
  const s = ctx.s, st = s.locState[s.night.locId];
  st.npcState[npc.id] = 'alert';
  ctx.emit('NPC_STATE', { loc: s.night.locId, npc: npc.id, state: 'alert' });
  const wpn = pickWeapon(ctx, c);
  let mine = combatModOf(c) + wpn.bonus;
  if (surprise) mine += 2;
  const his = (npc.armed ? 2 : 0) + 1;
  const r1 = ctx.check('我方攻击', mine);
  const r2 = ctx.check('敌方抵抗', his);
  const diff = r1.sum - r2.sum;
  addNoise(ctx, wpn.loud || 1);
  ctx.emit('COMBAT_ROUND', { npc: npc.id, diff });
  if (diff >= 2) {
    st.npcState[npc.id] = 'down';
    ctx.emit('NPC_STATE', { loc: s.night.locId, npc: npc.id, state: 'down' });
    ctx.fact('combat_win', { npc: npc.name });
    const innocent = npc.stance !== 'hostile';
    ctx.addDeed(c.id, innocent ? 'kill_civ' : 'kill_enemy', npc.id);
    recordCausal(ctx, innocent ? 'kill_civ' : 'kill_enemy', { actor: 'player', via: c.id, target: npc.id, witnesses: [c.id], note: npc.name });
    ctx.mood(c, innocent ? -10 : -1, '夺命', { ethics: innocent ? 'killCiv' : 'killEnemy' });
    return { ok: true, combat: 'win' };
  } else if (diff >= -1) {
    ctx.setWound(c, c.wound + 1, '打斗负伤');
    if (ctx.rng.chance(0.3)) ctx.setWound(c, c.wound + 1, '打斗负伤');
    ctx.fact('combat_hurt', { npc: npc.name });
    return { ok: true, combat: 'hurt' };
  } else {
    const fleeMod = (c.traits?.sprint ? 3 : 0) + (c.traits?.stealthy || 0);
    const rf = ctx.check('撤退', fleeMod);
    if (rf.outcome === 'fail') {
      ctx.setWound(c, Math.max(c.wound, 2), '败退负伤');
      dropOnePackItem(ctx);
      ctx.fact('combat_flee_hurt', {});
    } else ctx.fact('combat_flee', {});
    return forceEnd(ctx, 'flee');
  }
}

function pickWeapon(ctx, c) {
  const n = ctx.s.night;
  const ids = n ? n.pack : [];
  let best = { bonus: 0, loud: 1, id: null };
  for (const id of ids) {
    const it = ctx.pack.itemMap[id];
    const w = it?.weapon || 0;
    if (w > best.bonus) best = { bonus: w, loud: it.loud || 1, id };
  }
  if (best.id && ctx.pack.itemMap[best.id]?.ammo) {
    if (ctx.hasItem('bullet')) ctx.takeItem('bullet', 1, '射击');
    else best = { bonus: 0, loud: 1, id: null };
  }
  return best;
}

function maybeFireNpcScript(ctx, loc, npcForce) {
  const s = ctx.s, n = s.night;
  if (!n || n.home) return;
  if (s.activeEvent) return; // 一次一幕：地点脚本已在场时不叠 NPC 首访
  const st = s.locState[n.locId];
  const npcs = npcForce ? [npcForce] : (loc.npcs || []).filter((npc) => !npc.room || npc.room === n.room);
  for (const npc of npcs) {
    if (npc.firstScript && !st.scriptsFired[npc.firstScript]) {
      const card = ctx.pack.cards.find((c) => c.for === npc.firstScript);
      if (!card) continue; // 一张对不上不能挡住后面的 NPC（continue，不是 return）
      st.scriptsFired[npc.firstScript] = true;
      ctx.emit('SCRIPT_FIRED', { loc: n.locId, script: npc.firstScript });
      s.activeEvent = { cardId: card.id, night: true, actorId: n.charId };
      ctx.emit('EVENT_FIRED', { cardId: card.id, night: true, actorId: n.charId });
      ctx.fact('event', { cardId: card.id, title: card.title });
      return;
    }
  }
}

/** 夜间收尾：外出者已把收获直接入库；清 night、阶段 → dawn（dawn 管线由 resolve 触发） */
export function endNightReturn(ctx, reason) {
  const s = ctx.s, n = s.night;
  if (!n) return;
  if (!n.home) {
    // 装备归还（出发时从库存取走，收工放回——守恒律）
    for (const g of n.gear || []) {
      const inPack = n.pack.includes(g);
      if (inPack) ctx.addItem(g, 1, '归还装备');
      else ctx.addItem(g, 1, '战损归位'); // 被丢弃逻辑保护，理论不可达；防御性归还
    }
    // 今晚真正出门的人（破晓疲劳结算据此区分「夜访未眠」与守卫的睡椅相抵）
    ctx.outTonight = n.charId;
    // A-1 夜访事实带人名：叙事者不再拿渡口的鲁舟顶包（二周目实测 8+ 处主语顶替）
    ctx.fact('night_end', { char: n.charId, loc: ctx.pack.locMap[n.locId]?.name || n.locId, carried: n.pack.length, reason: reason || 'dawn' });
    // 昨夜谁出的门：晨间叙事与世界简报都靠它钉主语（fold 经 FLAG 还原）
    s.lastScavenger = n.charId;
    ctx.emit('FLAG', { key: 'lastScavenger', val: n.charId });
    const st = s.locState[n.locId];
    if (st) {
      st.firstVisit = false;
      st.lastVisitDay = s.day; // 方案卡的轮换依据（fold 经 NIGHT_ENDED 还原）
    }
    // 寒地收工（夜野）：在冷地方熬到后半夜的人，回家比出门多一分倦——冬季翻倍
    const loc = ctx.pack.locMap[n.locId];
    const env = nightEnvOf(n, loc);
    if (env.cold) {
      const who = charById(s, n.charId);
      if (who && who.alive) ctx.setFatigue(who, who.fatigue + (s.winterActive ? 2 : 1), '寒夜收工');
      ctx.fact('cold_night_end', { loc: loc?.name });
    }
    ctx.emit('NIGHT_ENDED', { loc: n.locId, reason: reason || 'dawn', carried: n.pack.length, gear: n.gear || [], lastVisitDay: s.day });
  } else {
    ctx.emit('NIGHT_ENDED', { home: true });
  }
  s.night = null;
  s.phase = 'dawn';
}

function forceEnd(ctx, reason) {
  endNightReturn(ctx, reason);
  return { ok: true, ended: true };
}


/** 夜岗·看护（居家与四问）：医者陪病人一夜——按"治过"结算（药照消耗），自己疲劳 +1 */
function nightNurse(ctx, c) {
  const s = ctx.s;
  c.awakeTonight = true; ctx.emit('CHAR_FLAG', { char: c.id, key: 'awakeTonight', val: true });
  if (!c.traits?.healer) { ctx.fact('need_trait', { trait: '懂医' }); return; }
  const patient = [...aliveChars(s)].filter((x) => x.id !== c.id && (x.sick >= 1 || x.wound >= 1))
    .sort((a, b) => (b.sick * 2 + b.wound) - (a.sick * 2 + a.wound))[0];
  if (!patient) { ctx.fact('no_patient', {}); return; }
  let med = null;
  if (patient.wound >= 1 && ctx.hasItem('bandage')) { ctx.takeItem('bandage', 1, '看护'); ctx.setCharFlag(patient, 'woundTreatedDay', s.day); med = 'bandage'; }
  else if (patient.sick >= 1 && ctx.hasItem('meds')) { ctx.takeItem('meds', 1, '看护'); ctx.setCharFlag(patient, 'sickTreatedDay', s.day); med = 'meds'; }
  else if (patient.sick >= 1 && ctx.hasItem('herbmed')) { ctx.takeItem('herbmed', 1, '看护'); ctx.setCharFlag(patient, 'sickTreatedDay', s.day); ctx.setCharFlag(patient, 'sickTreatedHerb', true); med = 'herbmed'; }
  ctx.setFatigue(c, c.fatigue + 1, '守了一夜病人');
  ctx.setCharFlag(patient, 'bedRest', true); // 被看护的人按卧床计（深眠）
  ctx.fact('nurse_night', { char: c.id, patient: patient.id, med });
}

/** 夜岗·夜作：点灯做一件安静的活（做饭/手艺/缝补/读书），疲劳 +1，灯火招贼（raid 读 nightWork） */
function nightWork(ctx, c) {
  const s = ctx.s, pack = ctx.pack;
  c.awakeTonight = true; ctx.emit('CHAR_FLAG', { char: c.id, key: 'awakeTonight', val: true });
  const prevPhase = s.phase, prevAp = c.ap;
  s.phase = 'day'; c.ap = Math.max(c.ap, 1); // 借夜里的精神干白天的活：动作管线要白天相位与一点行动力
  let done = null;
  const tryAct = (intent) => { if (done) return; const r = applyDayAction(ctx, { type: 'act', actor: c.id, ...intent }); if (r?.ok) done = intent.action; };
  if (s.facilities.stove && (ctx.hasItem('raw') || ctx.hasItem('meat') || ctx.hasItem('veg', 2))) tryAct({ action: 'cook' });
  if (c.traits?.healer && s.facilities.workbench && ctx.hasItem('parts', 2) && ctx.hasItem('water', 1) && c.mendedToday !== s.day) tryAct({ action: 'mend_cloth' });
  if (s.facilities.workbench && ctx.hasItem('herb', 3)) tryAct({ action: 'craft', target: 'make_herbmed' });
  if (s.facilities.workbench && ctx.hasItem('comp', 1) && !ctx.hasItem('lockpick')) tryAct({ action: 'craft', target: 'make_lockpick' });
  if (ctx.hasItem('book') && !c.readToday) tryAct({ action: 'read' });
  s.phase = prevPhase; c.ap = prevAp; // 行动力借完归还（夜作花的是疲劳不是 AP）
  ctx.emit('CHAR_FLAG', { char: c.id, key: 'ap', val: c.ap });
  ctx.setFatigue(c, c.fatigue + 1, '点灯干了半夜活');
  ctx.setFlag('nightWork', [...(s.nightWork || []), c.id]);
  ctx.fact('nightwork', { char: c.id, did: done });
}
