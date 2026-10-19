// 居家与四问（居家与四问-v0.1）：重心引擎 + 角色自主 + 坡/双人/暗面/闲笔。
// 设计北极星：换一拨人进这座城，家里自己长出来的事就该不一样——
// 自主行为长在 trait（本行）、taboo（习性）、knot（坡）、shadow（暗面漏出）与关系弧上。
// 引擎只认内容（content/base/autonomy.json），不认人名；状态变更全部走 FLAG/CHAR_FLAG（fold 可回放）。
import { aliveChars, charById, moodLevel, policyOf, homeOf } from './state.js';
import { applyDayAction } from './dayActions.js';
import { dawnProblems } from './delegate.js';

export const FOCUS_KEYS = ['mouth', 'care', 'gear', 'guard', 'read', 'steady'];

/** 条件求值（纯函数，测试直查）：when 里的键全过才算可行 */
export function condOk(s, pack, w = {}, self = null, rng = null) {
  const alive = new Set(aliveChars(s).map((c) => c.id));
  const has = (i, n = 1) => (s.inventory[i] || 0) >= n;
  const mouths = Math.max(1, aliveChars(s).length);
  const foodTotal = ['meal', 'canned', 'raw', 'meat', 'veg'].reduce((a, i) => a + (s.inventory[i] || 0), 0);
  if (w.item) for (const [i, n] of Object.entries(w.item)) if (!has(i, n)) return false;
  if (w.noItem) for (const i of [].concat(w.noItem)) if (has(i)) return false;
  if (w.facility && !s.facilities[w.facility]) return false;
  if (w.noFacility && s.facilities[w.noFacility]) return false;
  if (w.facilityLt) for (const [i, n] of Object.entries(w.facilityLt)) if ((s.facilities[i] || 0) >= n) return false;
  if (w.selfFatigueGte && (!self || self.fatigue < w.selfFatigueGte)) return false;
  if (w.selfMoodLte && (!self || (self.moodPts ?? 2) > w.selfMoodLte)) return false;
  if (w.selfMoodGte !== undefined && (!self || (self.moodPts ?? 2) < w.selfMoodGte)) return false;
  if (w.selfHungerLte && (!self || self.hunger > w.selfHungerLte)) return false;
  if (w.selfApGte && (!self || self.ap < w.selfApGte)) return false;
  if (w.selfTrait && !self?.traits?.[w.selfTrait]) return false;
  if (w.selfNoTrait && self?.traits?.[w.selfNoTrait]) return false;
  if (w.anyoneSick && !aliveChars(s).some((c) => c.sick >= 1)) return false;
  if (w.anyoneWounded && !aliveChars(s).some((c) => c.wound >= 1)) return false;
  if (w.anyoneLowMood && !aliveChars(s).some((c) => (c.id === self?.id ? false : (c.moodPts ?? 2) <= -4 || !!c.breakdown))) return false;
  if (w.anyoneBreakdown && !aliveChars(s).some((c) => !!c.breakdown)) return false;
  if (w.foodPerMouthLt && !(foodTotal / mouths < w.foodPerMouthLt)) return false;
  if (w.fuelLt) {
    const fuel = (s.inventory.firewood || 0) + (s.inventory.wood || 0) + (s.inventory.book || 0);
    if (fuel >= w.fuelLt) return false;
  }
  if (w.waterLt && (s.inventory.water || 0) >= w.waterLt) return false;
  if (w.weather && ![].concat(w.weather).includes(s.weather)) return false;
  if (w.winter === true && !s.winterActive) return false;
  if (w.winter === false && s.winterActive) return false;
  if (w.charAlive && !alive.has(w.charAlive)) return false;
  if (w.charsAlive) for (const id of w.charsAlive) if (!alive.has(id)) return false;
  if (w.charDead && alive.has(w.charDead)) return false;
  if (w.dayGte && s.day < w.dayGte) return false;
  if (w.dayLte && s.day > w.dayLte) return false;
  if (w.dayEvery && s.day % w.dayEvery !== 0) return false;
  if (w.flag && !s.eventFlags[w.flag]) return false;
  if (w.notFlag && s.eventFlags[w.notFlag]) return false;
  if (w.doorLt && s.doorLevel >= w.doorLt) return false;
  if (w.doorGte && s.doorLevel < w.doorGte) return false;
  if (w.facilityGte) for (const [i, n] of Object.entries(w.facilityGte)) if ((s.facilities[i] || 0) < n) return false;
  if (w.knowledgeGte && s.knowledge < w.knowledgeGte) return false;
  if (w.knowledgeLt && s.knowledge >= w.knowledgeLt) return false;
  if (w.deathRecent !== undefined) {
    const days = Object.values(s.deathDays || {});
    const last = days.length ? Math.max(...days) : -99;
    if (s.day - last > w.deathRecent) return false;
  }
  if (w.docsGte && s.docsSeen.length < w.docsGte) return false;
  if (w.homeLeftover) {
    const home = homeOf(pack, s);
    if (!home.rooms.some((r) => s.house.opened[r.id] && (r.containers || []).some((ct) => !s.house.searched[ct.id]))) return false;
  }
  if (w.notorietyGte && s.notoriety < w.notorietyGte) return false;
  if (w.rand && rng && !rng.chance(w.rand)) return false;
  return true;
}

/** 自主对象选择：'lowestMood' 等 → 具体的人（纯函数） */
export function pickTarget(s, spec, self) {
  const others = aliveChars(s).filter((c) => c.id !== self?.id);
  if (spec === 'lowestMood') return [...others].sort((a, b) => (a.moodPts ?? 2) - (b.moodPts ?? 2))[0] || null;
  if (spec === 'sickest') return [...aliveChars(s)].sort((a, b) => (b.sick * 2 + b.wound) - (a.sick * 2 + a.wound))[0] || null;
  if (spec === 'wounded') return [...aliveChars(s)].find((c) => c.wound >= 1 && c.woundTreatedDay !== s.day) || null;
  if (spec === 'student') return aliveChars(s).find((c) => c.student) || null;
  if (spec === 'teacher') return aliveChars(s).find((c) => c.traits && Object.keys(c.traits).length > 0 && !c.student) || null;
  if (spec === 'anyOther') return others[0] || null;
  if (typeof spec === 'string' && spec.startsWith('char:')) return charById(s, spec.slice(5));
  return null;
}

const NAME = (s, pack, id) => s.chars.find((c) => c.id === id)?.name || pack.charMap?.[id]?.name || id;
function fillLine(line, s, pack, self, target) {
  return String(line)
    .replaceAll('{{name}}', self ? NAME(s, pack, self.id) : '')
    .replaceAll('{{other}}', target ? NAME(s, pack, target.id) : '')
    .replaceAll('{{day}}', s.day);
}

/** 微效果结算（内核效果白名单的居家子集；一切状态变更走具名事件，fold 可回放） */
export function applyKitEffects(ctx, self, e = {}, target = null) {
  const s = ctx.s, pack = ctx.pack;
  if (e.cost) for (const c of e.cost) if (!ctx.hasItem(c.item, c.n)) return false;
  if (e.cost) for (const c of e.cost) ctx.takeItem(c.item, c.n, '自主动作');
  if (e.items) for (const [k, v] of Object.entries(e.items)) ctx.addItem(k, v, '自主动作');
  if (e.mood) {
    const m = e.mood;
    if (m.all !== undefined) ctx.moodAll(m.all, '自主动作');
    if (m.self !== undefined && self) ctx.mood(self, m.self, '自主动作');
    if (m.other !== undefined && target) ctx.mood(target, m.other, '自主动作');
    for (const [id, v] of Object.entries(m)) {
      if (['all', 'self', 'other'].includes(id)) continue;
      const c = charById(s, id); if (c) ctx.mood(c, v, '自主动作');
    }
  }
  if (e.knowledge) ctx.addKnowledge(e.knowledge, '自主动作');
  if (e.reputation) for (const [k, v] of Object.entries(e.reputation)) ctx.reputation(k, v);
  if (e.notoriety) ctx.notoriety(e.notoriety);
  if (e.flags) {
    const flags = { ...s.eventFlags, ...e.flags };
    s.eventFlags = flags;
    ctx.emit('FLAG', { key: 'eventFlags', val: structuredClone(flags) });
  }
  if (e.door) { s.doorLevel = Math.min(pack.doorReinforce?.maxLevel ?? 3, s.doorLevel + e.door); ctx.emit('DOOR_LEVEL', { to: s.doorLevel }); ctx.fact('build_door', { level: s.doorLevel }); }
  if (e.facility) for (const [id, n] of Object.entries(e.facility)) {
    const def = pack.facilityMap?.[id];
    const to = Math.min(def?.max ?? 1, (s.facilities[id] || 0) + n);
    if (to === (s.facilities[id] || 0)) continue;
    s.facilities[id] = to;
    ctx.emit('FACILITY_BUILT', { facility: id, to });
  }
  if (e.grantTrait && target) {
    const t = e.grantTrait;
    const traits = { ...target.traits };
    traits[t.trait] = t.value !== undefined ? t.value : (traits[t.trait] ?? true);
    target.traits = traits;
    ctx.emit('CHAR_FLAG', { char: target.id, key: 'traits', val: structuredClone(traits) });
    ctx.fact('apprentice_done', { char: target.id, trait: t.trait, line: `${NAME(s, pack, target.id)}学会了${t.label || t.trait}。` });
  }
  if (e.fatigue?.self && self) ctx.setFatigue(self, self.fatigue + e.fatigue.self, '自主动作');
  if (e.fatigue?.other && target) ctx.setFatigue(target, target.fatigue + e.fatigue.other, '自主动作');
  if (e.nightPrep) { ctx.setFlag('nightPrep', Math.min(2, (s.nightPrep || 0) + e.nightPrep)); }
  if (e.reserve) ctx.setFlag('reserve', { ...(s.reserve || {}), ...e.reserve });
  if (e.noBookFuel) ctx.setFlag('noBookFuel', true);
  if (e.raidDeter) ctx.setFlag('habitDeter', (s.habitDeter || 0) + e.raidDeter);
  if (e.telegraphEarly) ctx.setFlag('telegraphBonus', (s.telegraphBonus || 0) + e.telegraphEarly);
  if (e.wind) { ctx.setFlag('windLines', [...(s.windLines || []), fillLine(e.wind, s, pack, self, target)]); }
  if (e.heard && !s.knownLocs.includes(e.heard)) {
    // 风闻只开「听说过」，不开「去过」：地点仍在 knownLocs 之外，上图灰名
    const heardFlag = `heard_${e.heard}`;
    if (!s.eventFlags[heardFlag]) {
      const flags = { ...s.eventFlags, [heardFlag]: s.day };
      s.eventFlags = flags;
      ctx.emit('FLAG', { key: 'eventFlags', val: structuredClone(flags) });
    }
  }
  if (e.arcProgress && self) {
    const arcs = { ...(s.arcs || {}) };
    arcs[self.id] = { ...(arcs[self.id] || { stage: 0, progress: 0 }), progress: (arcs[self.id]?.progress || 0) + e.arcProgress };
    ctx.setFlag('arcs', arcs);
  }
  if (e.memoirLine) ctx.setFlag('homeLines', [...(s.homeLines || []), fillLine(e.memoirLine, s, pack, self, target)]);
  return true;
}

/** 条目级代价：全有才扣，扣完才做（半扣是账的漏洞） */
function payCost(ctx, cost) {
  if (!cost || !cost.length) return true;
  if (!cost.every((c) => ctx.hasItem(c.item, c.n))) return false;
  for (const c of cost) ctx.takeItem(c.item, c.n, '自主动作');
  return true;
}

/** 执行一个 kit/ladder 条目：do=走现成动作管线；否则纯效果。返回是否成功 */
function runKitItem(ctx, self, item, pack) {
  const s = ctx.s;
  const target = item.target ? pickTarget(s, item.target, self) : null;
  if (item.target && item.target !== 'anyOther' && !target) return false;
  if (item.cost && !item.cost.every((c) => ctx.hasItem(c.item, c.n))) return false;
  if (item.do) {
    if (!payCost(ctx, item.cost)) return false;
    const [action, arg] = item.do.split(':');
    const intent = { type: 'act', actor: self.id, action };
    if (arg) intent.target = arg;
    if (item.patient) intent.patient = item.patient;
    if (target && action === 'talk') intent.target = target.id;
    if (target && action === 'teach') intent.target = target.id;
    if (target && action === 'treat') intent.patient = target.id;
    const r = applyDayAction(ctx, intent);
    if (r && r.ok === false) return false;
    if (item.effects) applyKitEffects(ctx, self, item.effects, target);
    return true;
  }
  if (!item.effects) return false;
  if ((item.ap ?? 1) > 0 && self.ap < (item.ap ?? 1)) return false;
  if (!payCost(ctx, item.cost)) return false;
  if ((item.ap ?? 1) > 0) ctx.spendAp(self, item.ap ?? 1);
  if (!applyKitEffects(ctx, self, item.effects, target)) return false;
  return true;
}

function markRoutine(ctx, self, item, pack, kind) {
  const s = ctx.s;
  const target = item.target ? pickTarget(s, item.target, self) : null;
  const line = fillLine(item.line || '', s, pack, self, target);
  const seen = { ...(s.routineSeen || {}) };
  const first = !seen[item.id];
  if (first) seen[item.id] = s.day;
  ctx.setFlag('routineSeen', seen);
  const today = { ...(s.routineToday || {}) };
  today[self.id] = [...(today[self.id] || []), item.id];
  ctx.setFlag('routineToday', today);
  const last = { ...(s.routineLast || {}) };
  last[self.id] = item.id;
  ctx.setFlag('routineLast', last);
  ctx.fact(first ? 'home_first' : 'routine_done', { char: self.id, id: item.id, line, kind });
}

// —— 重心（破晓·判断题）：内核从晨报警情里算，玩家只在不服时说一句 ——

export function focusOf(s, pack) {
  const pol = policyOf(s);
  if (FOCUS_KEYS.includes(pol.homePriority) && pol.homePriority !== 'steady') return { key: pol.homePriority, alt: null, auto: false };
  const score = { mouth: 0, care: 0, gear: 0, guard: 0, read: 0 };
  for (const p of dawnProblems(s, pack)) {
    const sev = p.sev || 1;
    const pk = p.key || ''; // 晨报里有不带 key 的急条（疫病行等）——只认带账的
    if (['food_out', 'food_low'].includes(pk)) score.mouth += sev;
    else if (pk.startsWith('hunger_')) score.mouth += sev;
    else if (['crit_', 'nomed_'].some((k) => pk.startsWith(k))) score.care += sev;
    else if (pk.startsWith('mind_')) score.care += sev;
    else if (pk.startsWith('sick_')) score.care += sev;
    else if (['fuel_low', 'fuel_days'].includes(pk)) score.gear += sev;
  }
  if (s.lastRaidDay && s.day - s.lastRaidDay <= 1) score.guard += 3;
  if (s.notoriety >= 2) score.guard += 2;
  if (s.war?.telegraphed) score.guard += 2;
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0];
  const [second, secondScore] = ranked[1] || [null, 0];
  if (topScore === 0) return { key: 'steady', alt: null, auto: true };
  return { key: top, alt: secondScore >= 2 && topScore - secondScore <= 1 ? second : null, auto: true };
}

export function tickFocus(ctx) {
  const s = ctx.s, pack = ctx.pack;
  const f = focusOf(s, pack);
  const prev = s.focus || {};
  const changed = prev.key !== f.key;
  s.focus = { ...f, day: s.day };
  ctx.emit('FLAG', { key: 'focus', val: s.focus });
  if (!changed && !f.alt) return;
  const lines = pack.autonomy?.focus?.lines || {};
  const label = { mouth: '稳嘴', care: '养人', gear: '备器', guard: '守家', read: '读城', steady: '照旧' };
  const line = f.alt
    ? `今天先${label[f.key]}——${label[f.alt]}也悬着。`
    : (f.key === 'steady' ? '' : `今天先${label[f.key]}。`);
  if (line) ctx.fact('focus_set', { key: f.key, alt: f.alt, line });
}

// —— 每日晨间：坡推进 / 暗面漏出 / 日账重置 ——

export function dawnReset(ctx) {
  const s = ctx.s;
  ctx.setFlag('habitDeter', 0);
  ctx.setFlag('windLines', []);
  ctx.setFlag('nightWork', []);
  ctx.setFlag('routineToday', {});
}

export function arcTick(ctx) {
  const s = ctx.s, pack = ctx.pack;
  const kits = pack.autonomy?.kits || {};
  for (const [id, kit] of Object.entries(kits)) {
    const c = charById(s, id);
    if (!c || !kit.arc) continue;
    const arcs = s.arcs || {};
    const stage = arcs[id]?.stage || 0;
    const st = kit.arc.stages?.[stage];
    if (!st) continue;
    const selfFatigueGuard = st.when?.selfFatigueLt ? c.fatigue >= st.when.selfFatigueLt : false;
    if (selfFatigueGuard) continue;
    const w = { ...(st.when || {}) };
    delete w.selfFatigueLt;
    if (st.progressGte && (arcs[id]?.progress || 0) < st.progressGte) continue;
    if (!condOk(s, pack, w, c, ctx.rng)) continue;
    if (!payCost(ctx, st.cost)) continue;
    if (st.effects) applyKitEffects(ctx, c, st.effects, pickTarget(s, st.target, c));
    const next = { ...(s.arcs || {}) };
    next[id] = { stage: stage + 1, progress: next[id]?.progress || 0 };
    ctx.setFlag('arcs', next);
    ctx.fact('arc_stage', { char: id, stage: stage + 1, line: fillLine(st.line || '', s, pack, c, null) });
  }
}

export function stressLeak(ctx) {
  const s = ctx.s, pack = ctx.pack;
  const kits = pack.autonomy?.kits || {};
  for (const [id, kit] of Object.entries(kits)) {
    const c = charById(s, id);
    if (!c || !kit.stress) continue;
    const last = (s.stressLast || {})[id] ?? -99;
    if (s.day - last < (kit.stress.cooldown ?? 3)) continue;
    if (!condOk(s, pack, kit.stress.when || {}, c, ctx.rng)) continue;
    if (kit.stress.chance && !ctx.rng.chance(kit.stress.chance)) continue;
    applyKitEffects(ctx, c, kit.stress.effects || {}, pickTarget(s, kit.stress.target, c));
    const sl = { ...(s.stressLast || {}), [id]: s.day };
    ctx.setFlag('stressLast', sl);
    ctx.fact('stress_leak', { char: id, line: fillLine(kit.stress.line || '', s, pack, c, null) });
  }
}

// —— 白天收尾（toDusk 之前）：双人 → 习性 → 每人 ≤2 件自主 → 闲笔 ——

function eligibleItems(ctx, self, pack) {
  const s = ctx.s;
  const kit = pack.autonomy?.kits?.[self.id];
  const out = [];
  const push = (item, tier) => {
    if (!item || !item.id) return;
    const once = item.once || 'day';
    if (once === 'run' && (s.routineSeen || {})[item.id]) return;
    if (once === 'day' && (s.routineToday || {})[self.id]?.includes(item.id)) return;
    if (!condOk(s, pack, item.when || {}, self, ctx.rng)) return;
    // 反重复：昨天做过的今天降权（不是禁做——活儿还是那活儿，人不想连着做）
    const w = (item.weight ?? 5) * ((s.routineLast || {})[self.id] === item.id ? 0.25 : 1);
    out.push({ item, w: w * tier });
  };
  if (kit) {
    for (const it of kit.trade || []) push(it, 1.6);
    for (const it of kit.leisure || []) push(it, 1.0);
  }
  const focus = s.focus?.key || 'steady';
  const order = pack.autonomy?.ladder?.byFocus?.[focus] || pack.autonomy?.ladder?.default || [];
  const defs = pack.autonomy?.ladder?.items || {};
  order.forEach((id, i) => push({ id: `ladder:${id}`, ...(defs[id] || {}) }, 1.2 - i * 0.05));
  return out;
}

function pairTick(ctx) {
  const s = ctx.s, pack = ctx.pack;
  if (s.pairLastDay === s.day) return;
  const pairs = (pack.autonomy?.pairs || []).filter((p) => {
    const a = charById(s, p.a), b = charById(s, p.b);
    if (!a || !b || a.ap < 1 || b.ap < 1) return false;
    if ((s.pairLast || {})[p.id] && s.day - (s.pairLast || {})[p.id] < (p.cooldown ?? 4)) return false;
    if (p.cost && !p.cost.every((c) => ctx.hasItem(c.item, c.n))) return false;
    return condOk(s, pack, p.when || {}, a, ctx.rng);
  });
  if (!pairs.length) return;
  const p = ctx.rng.weighted(pairs.map((x) => ({ w: x.weight ?? 5, x }))).x;
  const a = charById(s, p.a), b = charById(s, p.b);
  if (!payCost(ctx, p.cost)) return;
  ctx.spendAp(a, 1); ctx.spendAp(b, 1);
  applyKitEffects(ctx, a, p.effects || {}, b);
  ctx.setFlag('pairLast', { ...(s.pairLast || {}), [p.id]: s.day });
  ctx.setFlag('pairLastDay', s.day);
  ctx.fact('pair_done', { a: p.a, b: p.b, id: p.id, line: fillLine(p.line || '', s, pack, a, b) });
}

function vignetteTick(ctx) {
  const s = ctx.s, pack = ctx.pack;
  if (s.vignetteDay === s.day) return;
  if (!ctx.rng.chance(pack.autonomy?.vignettes?.chance ?? 0.6)) { ctx.setFlag('vignetteDay', s.day); return; }
  const pool = [];
  for (const v of pack.autonomy?.vignettes?.items || []) {
    if ((s.routineSeen || {})[v.id] && v.once === 'run') continue;
    const cand = v.who
      ? aliveChars(s).filter((c) => (v.who === 'any' ? true : v.who.startsWith('trait:') ? c.traits?.[v.who.slice(6)] : c.id === v.who))
      : aliveChars(s);
    for (const c of cand) {
      if (!condOk(s, pack, v.when || {}, c, ctx.rng)) continue;
      pool.push({ v, c, w: v.weight ?? 3 });
    }
  }
  ctx.setFlag('vignetteDay', s.day);
  if (!pool.length) return;
  const pick = ctx.rng.weighted(pool.map((x) => ({ w: x.w, x }))).x;
  if (!payCost(ctx, pick.v.cost)) return;
  applyKitEffects(ctx, pick.c, pick.v.effects || {}, pick.v.target ? pickTarget(s, pick.v.target, pick.c) : null);
  const seen = { ...(s.routineSeen || {}) };
  const first = !seen[pick.v.id];
  if (first) seen[pick.v.id] = s.day;
  ctx.setFlag('routineSeen', seen);
  ctx.fact(first ? 'home_first' : 'routine_done', { char: pick.c.id, id: pick.v.id, line: fillLine(pick.v.line || '', s, pack, pick.c, null), kind: 'vignette' });
}

export function autonomyClose(ctx) {
  const s = ctx.s, pack = ctx.pack;
  if (!pack.autonomy || s.over || s.phase !== 'day') return;
  pairTick(ctx);
  // 习性：零成本、每日一次的怪癖（taboo 长出来的）
  for (const c of aliveChars(s)) {
    const kit = pack.autonomy?.kits?.[c.id];
    for (const h of kit?.habits || []) {
      if ((s.routineToday || {})[c.id]?.includes(h.id)) continue;
      if (h.once === 'run' && (s.routineSeen || {})[h.id]) continue;
      if (!condOk(s, pack, h.when || {}, c, ctx.rng)) continue;
      if (runKitItem(ctx, c, h, pack) || h.effects) {
        if (!h.do) applyKitEffects(ctx, c, h.effects || {}, h.target ? pickTarget(s, h.target, c) : null);
        // 静默习性：只有头一回出声（此后天天生效不出噪音）
        if (!h.silent || !(s.routineSeen || {})[h.id]) markRoutine(ctx, c, h, pack, 'habit');
      }
    }
  }
  // 每人每天至多一件自主（本行/闲/通用阶梯，按重心排序、反重复、加权抽签）。
  // 试过两件：抚慰与供给把赌徒局的存活从 26% 抬到 75%——生存必须仍然难，自主是性格不是外挂
  for (let pass = 0; pass < 1; pass++) {
    for (const c of aliveChars(s)) {
      if (c.bedRest || c.ap < 1) continue;
      if ((s.routineToday || {})[c.id]?.length >= 1) continue;
      const eligible = eligibleItems(ctx, c, pack);
      if (!eligible.length) continue;
      const pick = ctx.rng.weighted(eligible.map((x) => ({ w: Math.max(0.1, x.w), x }))).x;
      if (runKitItem(ctx, c, pick.item, pack)) markRoutine(ctx, c, pick.item, pack, pick.item.kind || 'trade');
    }
  }
  vignetteTick(ctx);
  // 覆盖账（KPI：有自主动作的天）：习性/自主/双人/闲笔任一发生即计
  {
    const fired = Object.keys(s.routineToday || {}).length > 0 || s.pairLastDay === s.day || s.vignetteDay === s.day;
    if (fired && s.routineMarkDay !== s.day) {
      ctx.setFlag('routineMarkDay', s.day);
      ctx.setFlag('routineDays', (s.routineDays || 0) + 1);
    }
  }
  // 还站着的人也闲着——点名，不让行动力无声作废
  for (const c of aliveChars(s)) {
    if (c.bedRest || c.ap < 1) continue;
    ctx.fact('idle_ap', { char: c.id, n: c.ap });
    ctx.spendAp(c, c.ap);
  }
}

// —— 视图层：家底进度轨与结局坡线 ——

/** 大柯的棺：料齐了又有人走——下葬，全家心情回一截（先于结论收口） */
export function funeralCheck(ctx) {
  const s = ctx.s, pack = ctx.pack;
  if (!s.eventFlags?.coffin_ready) return;
  const days = Object.values(s.deathDays || {});
  const last = days.length ? Math.max(...days) : -99;
  if (s.day - last > 1) return;
  const flags = { ...s.eventFlags, coffin_ready: false };
  s.eventFlags = flags;
  ctx.emit('FLAG', { key: 'eventFlags', val: structuredClone(flags) });
  ctx.moodAll(2, '下葬');
  ctx.fact('funeral', { line: '大柯把攒了半个月的木料用上了。一口像样的棺，一个像样的坟。人都到齐了——这座城还欠着他们别的，先欠着。' });
}

export function homeTracks(state, pack) {
  const s = state;
  const out = [];
  const fac = s.facilities || {};
  const F = { stove: '灶', stove_eco: '节能灶', heater: '火盆', heater_iron: '铁炉', workbench: '工作台', metal: '铁砧', radio: '烽鼓具', trap: '捕鼠笼', garden: '药圃', garden_veg: '葵菜园', distill: '蒸馏器', rain: '集雨器', piano: '琴' };
  for (const [k, label] of Object.entries(F)) if (fac[k]) out.push(`${label}${k === 'piano' ? ` ${fac[k]}/3 弦` : ''}`);
  if (s.doorLevel) out.push(`门 ${s.doorLevel}/3 道`);
  if ((fac.bed || 0) + (fac.bed_good || 0)) out.push(`床 ${(fac.bed || 0) + (fac.bed_good || 0)} 张`); // bed_good 并入计数：老档里可能还留着
  const arcs = s.arcs || {};
  const labels = pack.autonomy?.arcLabels || {};
  for (const [id, a] of Object.entries(arcs)) {
    const l = labels[id];
    if (l) out.push(`${l} ${a.stage}/${a.stages ?? '3'}`);
  }
  return out;
}

export function homeArcLines(state, pack) {
  const s = state;
  const out = [...(s.homeLines || [])];
  const arcs = s.arcs || {};
  for (const [id, a] of Object.entries(arcs)) {
    const done = pack.autonomy?.kits?.[id]?.arc?.stages?.[a.stage - 1]?.doneLine;
    if (a.stage >= 3 && done) out.push(done.replaceAll('{{name}}', NAME(s, pack, id)));
  }
  return out;
}
