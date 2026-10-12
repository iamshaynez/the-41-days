// 夜间探索引擎（内核设计 §6：时间槽/门与容器/声响/检定/战斗/NPC）。
// 门状态记在 night.unlocked/cleared/sawed（不污染内容对象）；locState 经事件记账。
import { charById, combatModOf, moodLevel } from './state.js';
import { findDoc, docAvailable } from './dayActions.js';
import { recordCausal } from './causality.js';

export function startNight(ctx, { scavenger, location, gear = [], others = {} }) {
  const s = ctx.s, pack = ctx.pack;
  if (s.phase !== 'dusk') return { ok: false, reason: 'NOT_DUSK' };
  if (location && !s.knownLocs.includes(location)) return { ok: false, reason: 'UNKNOWN_LOC' };
  for (const [id, plan] of Object.entries(others || {})) {
    const c = charById(s, id);
    if (!c) continue;
    if (plan === 'guard') { c.guardTonight = true; c.awakeTonight = true; ctx.emit('CHAR_FLAG', { char: id, key: 'guardTonight', val: true }); ctx.emit('CHAR_FLAG', { char: id, key: 'awakeTonight', val: true }); recordCausal(ctx, 'guard_night', { actor: id, target: 'home' }); }
    else { c.awakeTonight = false; ctx.emit('CHAR_FLAG', { char: id, key: 'awakeTonight', val: false }); }
  }
  if (!scavenger || !location) {
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
  // E-10 重访演化：搜过 ≥3 天的容器 20% 被外界重新填上（低质重抽）
  for (const r of loc.rooms) {
    for (const cont of r.containers || []) {
      const when = st.searched[cont.id];
      if (when && s.day - when >= 2 && ctx.rng.chance(0.6)) {
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
  s.night = {
    home: false, locId: location, charId: c.id,
    room: loc.rooms[0].id, slots: pack.manifest.nightSlots, noise: 0,
    pack: carried, packSlots: slotsUsed, cap: c.backpack, observed: {},
    unlocked: {}, cleared: {}, sawed: {}, firstVisit: st.firstVisit,
    gear: [...carried], lowSlotsAck: false
  };
  c.awakeTonight = true;
  ctx.emit('CHAR_FLAG', { char: c.id, key: 'awakeTonight', val: true });
  recordCausal(ctx, 'volunteer', { actor: c.id, target: location });
  s.phase = 'night';
  ctx.emit('NIGHT_STARTED', { loc: location, char: c.id, night: s.night });
  ctx.fact('night_arrive', { char: c.id, loc: loc.name, slots: s.night.slots });
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
      const cont = r.containers?.find((x) => x.id === intent.target) || r.containers?.find((x) => !st.searched[x.id]);
      if (!cont) return nightError(ctx, '没有可搜的容器了');
      if (cont.type === 'locked' && !st.searched[cont.id + ':open']) return nightError(ctx, '容器上着锁，先 open');
      if (st.searched[cont.id]) return nightError(ctx, '搜过了');
      spend(ctx, 1);
      st.searched[cont.id] = s.day;
      ctx.emit('LOC_SEARCHED', { loc: n.locId, cont: cont.id, day: s.day });
      lootNight(ctx, cont, c);
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
      const npc = (loc.npcs || []).find((x) => x.id === intent.target);
      if (!npc) return nightError(ctx, '无此目标');
      const st = s.locState[n.locId];
      if (st.npcState[npc.id] === 'down') return nightError(ctx, '他已经倒下');
      spend(ctx, 1);
      const surprise = st.npcState[npc.id] !== 'alert';
      return combatRound(ctx, npc, c, { surprise });
    }
    case 'retreat': return forceEnd(ctx, 'retreat');
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
  for (let k = 0; k < n; k++) {
    if (ctx.rng.chance(0.25)) {
      const loc = ctx.pack.locMap[s.night.locId];
      for (const x of loc.npcs || []) if (!s.locState[s.night.locId].npcState[x.id]) {
        s.locState[s.night.locId].npcState[x.id] = 'alert';
        ctx.emit('NPC_STATE', { loc: s.night.locId, npc: x.id, state: 'alert' });
      }
      ctx.fact('night_noise_alert', {});
    }
  }
}

function lootNight(ctx, cont, c) {
  const s = ctx.s;
  const entries = (cont.loot || []).filter((e) => (e.w || 0) > 0);
  if (entries.length) {
    // 双次结算（§12 规格：平安夜 2.5-3.5 生食当量——一箱多物）
    const gotItems = [];
    for (let roll = 0; roll < 2; roll++) {
      if (!ctx.rng.chance(0.62)) continue;
      const e = ctx.rng.weighted(entries);
      const n2 = ctx.rng.range(e.count[0], e.count[1]);
      if (n2 > 0) { addItemCarried(ctx, e.item, n2); gotItems.push({ item: e.item, n: n2 }); }
    }
    if (gotItems.length) ctx.fact('night_search_hit', { items: gotItems, n: gotItems.reduce((a, b) => a + b.n, 0) });
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
    ctx.setWound(c, c.wound + 1);
    if (ctx.rng.chance(0.3)) ctx.setWound(c, c.wound + 1);
    ctx.fact('combat_hurt', { npc: npc.name });
    return { ok: true, combat: 'hurt' };
  } else {
    const fleeMod = (c.traits?.sprint ? 3 : 0) + (c.traits?.stealthy || 0);
    const rf = ctx.check('撤退', fleeMod);
    if (rf.outcome === 'fail') {
      ctx.setWound(c, Math.max(c.wound, 2));
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
      if (!card) return;
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
    ctx.emit('NIGHT_ENDED', { loc: n.locId, reason: reason || 'dawn', carried: n.pack.length, gear: n.gear || [] });
    ctx.fact('night_end', { carried: n.pack.length, reason: reason || 'dawn' });
    const st = s.locState[n.locId];
    if (st) st.firstVisit = false;
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
