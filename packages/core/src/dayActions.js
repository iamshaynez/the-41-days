// 白天行动与事件结算（内核设计 §5 A 表、§8 事件卡效果白名单 GE-03 精神）。
// 所有状态变更经 ctx 事件通道（fold 镜像可重放）。
import { aliveChars, charById, moodLevel, difficultyCfg, combatModOf } from './state.js';
import { recordCausal, pairStage } from './causality.js';

export const DAY_ACTIONS = ['eat', 'cook', 'craft', 'build', 'treat', 'talk', 'guard', 'sleep', 'rest', 'listen_radio', 'search_home', 'open_room', 'chop', 'repair', 'read', 'play_piano'];

const AP_COST = { eat: 0, cook: 1, treat: 1, talk: 1, guard: 0, sleep: 2, rest: 0, listen_radio: 1, search_home: 1, open_room: 1, chop: 1, repair: 1, read: 1, play_piano: 1 };

export function applyDayAction(ctx, intent) {
  const s = ctx.s, pack = ctx.pack;
  const c = charById(s, intent.actor);
  if (!c) return { ok: false, reason: 'NO_CHAR' };
  const action = intent.action;
  if (s.phase !== 'day') return { ok: false, reason: 'NOT_DAY' };
  const cost = AP_COST[action] ?? 0;
  if ((action === 'craft' || action === 'build') && (moodLevel(c.moodPts).key === 'depressed' || c.breakdown)) {
    ctx.emit('INTENT_REJECTED', { reason: 'DEPRESSED', actor: c.id, what: 'build' });
    ctx.fact('depressed_refuse', { char: c.id, what: 'build' });
    return { ok: false, reason: 'DEPRESSED' };
  }
  if (cost > 0 && c.ap < cost) { ctx.fact('no_ap', { char: c.id }); return { ok: false, reason: 'NO_AP' }; }
  switch (action) {
    case 'eat': return actEat(ctx, c, intent.target);
    case 'cook': return actCook(ctx, c);
    case 'craft': return actCraft(ctx, c, intent.target);
    case 'build': return actBuild(ctx, c, intent.target);
    case 'treat': return actTreat(ctx, c, intent.target, intent.patient);
    case 'talk': return actTalk(ctx, c, intent.target);
    case 'guard':
      c.guardTonight = true; c.ap = Math.max(0, c.ap - 1);
      ctx.emit('GUARD_SET', { char: c.id }); ctx.fact('guard', { char: c.id });
      return { ok: true };
    case 'sleep': ctx.setFatigue(c, c.fatigue - 1); ctx.spendAp(c, 2); ctx.fact('nap', { char: c.id }); return { ok: true };
    case 'rest': return actRest(ctx, c);
    case 'listen_radio': return actRadio(ctx, c);
    case 'search_home': return actSearchHome(ctx, c, intent.target);
    case 'open_room': return actOpenRoom(ctx, c, intent.target);
    case 'chop': return actChop(ctx, c);
    case 'repair': return actRepair(ctx, c);
    case 'read': return actRead(ctx, c);
    case 'play_piano': return actPiano(ctx, c);
    default: return { ok: false, reason: 'BAD_ACTION' };
  }
}

function actEat(ctx, c, target) {
  const s = ctx.s, pack = ctx.pack;
  const order = ['meal', 'canned', 'raw', 'meat'];
  const item = target && ctx.hasItem(target) ? target : order.find((i) => ctx.hasItem(i));
  if (!item) { ctx.fact('no_food', {}); return { ok: false, reason: 'NO_ITEM' }; }
  if (c.hunger >= 4) { ctx.fact('waste_warning', { char: c.id }); return { ok: false, reason: 'FULL' }; }
  ctx.takeItem(item, 1, '进食');
  ctx.setHunger(c, c.hunger + (pack.itemMap[item].eat || 1));
  ctx.fact('eat', { char: c.id, item });
  recordCausal(ctx, 'feed', { target: c.id });
  if (item === 'cigs' || item === 'coffee') {
    ctx.setCharFlag(c, 'addictionServedDay', s.day);
    ctx.mood(c, 2, '嗜好供给');
  }
  ctx.emit('ATE', { char: c.id, item });
  return { ok: true };
}

function actCook(ctx, c) {
  const s = ctx.s;
  if (!s.facilities.stove) { ctx.fact('need_facility', { facility: '炉灶' }); return { ok: false, reason: 'NEED_FACILITY' }; }
  // 可烹饪物优先级：生食 > 肉 > 2 蔱（原作口径：蔬菜是可烹饪食物）
  let cookCost;
  if (ctx.hasItem('raw')) cookCost = [['raw', 1]];
  else if (ctx.hasItem('meat')) cookCost = [['meat', 1]];
  else if (ctx.hasItem('veg', 2)) cookCost = [['veg', 2]];
  else { ctx.fact('no_food', {}); return { ok: false, reason: 'NO_ITEM' }; }
  // 批量烹饪：一根柴烧两锅（stoveFireLeft 记余火，节能灶四锅）
  const batch = s.facilities.stove_eco ? 4 : 2;
  const freeFire = (s.facilities.stoveFireLeft || 0) > 0;
  const needFuel = !c.traits?.cook && !freeFire;
  if (needFuel && !ctx.hasItem('firewood', 1) && !ctx.hasItem('book') && !ctx.hasItem('wood', 1)) { ctx.fact('no_fuel', {}); return { ok: false, reason: 'NO_ITEM' }; }
  if (freeFire) {
    s.facilities.stoveFireLeft -= 1;
    ctx.emit('FACILITY_STATE', { facility: 'stoveFireLeft', to: s.facilities.stoveFireLeft });
  } else if (needFuel) {
    if (ctx.hasItem('firewood', 1)) ctx.takeItem('firewood', 1, '烹饪');
    else if (ctx.hasItem('book', 1)) {
      ctx.takeItem('book', 1, '烧书做饭');
      recordCausal(ctx, 'burn_book', { note: '烧书做饭' }); // P-03：安东的坚持在此被点燃
    }
    else ctx.takeItem('wood', 1, '拆板烧火');
    s.facilities.stoveFireLeft = batch - 1;
    ctx.emit('FACILITY_STATE', { facility: 'stoveFireLeft', to: s.facilities.stoveFireLeft });
  }
  for (const [it, n] of cookCost) ctx.takeItem(it, n, '烹饪');
  ctx.addItem('meal', 1, '烹饪');
  ctx.spendAp(c, 1);
  ctx.emit('COOKED', { by: c.id });
  ctx.fact('cook', { char: c.id });
  return { ok: true };
}

function actCraft(ctx, c, recipeId) {
  const s = ctx.s, pack = ctx.pack;
  const r = pack.recipes.find((x) => x.id === recipeId);
  if (!r) return { ok: false, reason: 'BAD_TARGET' };
  if (['cook_meal', 'fine_meal'].includes(r.id)) return { ok: false, reason: 'USE_COOK' };
  const wbLv = s.facilities.workbench + s.facilities.workbench2 + s.facilities.workbench3;
  if (r.facility === 'workbench' && (!wbLv || wbLv < (r.wbLevel || 1))) { ctx.fact('need_facility', { facility: '工作台' + (r.wbLevel || 1) }); return { ok: false, reason: 'NEED_FACILITY' }; }
  if (r.facility !== 'workbench' && !s.facilities[r.facility]) { ctx.fact('need_facility', { facility: r.facility }); return { ok: false, reason: 'NEED_FACILITY' }; }
  if (r.chefOnly && !c.traits?.cook) return { ok: false, reason: 'NEED_TRAIT' };
  const disc = c.traits?.craftDisc || 0;
  const need = (n) => Math.max(1, Math.ceil(n * (1 - disc)));
  for (const n of r.need) if (!ctx.hasItem(n.item, need(n.n))) { ctx.fact('no_material', { item: n.item }); return { ok: false, reason: 'NO_ITEM' }; }
  if (r.fuel && !c.traits?.cook && !ctx.hasItem('firewood', r.fuel)) { ctx.fact('no_fuel', {}); return { ok: false, reason: 'NO_ITEM' }; }
  for (const n of r.need) ctx.takeItem(n.item, need(n.n), '制造');
  if (r.fuel && !c.traits?.cook) ctx.takeItem('firewood', r.fuel, '制造');
  ctx.spendAp(c, r.ap || 1);
  if (r.direct === 'door_level') { s.doorLevel++; ctx.emit('DOOR_LEVEL', { to: s.doorLevel }); }
  else ctx.addItem(r.out.item, r.out.n || 1, '制造');
  if (r.days) { s.facilities.distillReady = s.day + r.days; ctx.emit('FACILITY_STATE', { facility: 'distillReady', to: s.facilities.distillReady }); }
  ctx.emit('CRAFTED', { by: c.id, recipe: r.id });
  ctx.fact('craft', { char: c.id, recipe: r.id, out: r.out.item });
  return { ok: true };
}

function actBuild(ctx, c, target) {
  const s = ctx.s, pack = ctx.pack;
  if (target === 'door') {
    const lv = pack.doorReinforce.levels[s.doorLevel];
    if (!lv || s.doorLevel >= pack.doorReinforce.maxLevel) return { ok: false, reason: 'MAX' };
    if (lv.facility && !s.facilities[lv.facility]) { ctx.fact('need_facility', { facility: '金属台' }); return { ok: false, reason: 'NEED_FACILITY' }; }
    const disc = c.traits?.craftDisc || 0;
    const need = (n) => Math.max(1, Math.ceil(n * (1 - disc)));
    for (const [k, v] of Object.entries(lv.cost)) if (!ctx.hasItem(k, need(v))) { ctx.fact('no_material', { item: k }); return { ok: false, reason: 'NO_ITEM' }; }
    for (const [k, v] of Object.entries(lv.cost)) ctx.takeItem(k, need(v), '加固');
    ctx.spendAp(c, lv.ap);
    s.doorLevel++;
    ctx.emit('DOOR_LEVEL', { to: s.doorLevel });
    ctx.fact('build_door', { level: s.doorLevel, char: c.id });
    return { ok: true };
  }
  const fac = pack.facilityMap[target];
  if (!fac) return { ok: false, reason: 'BAD_TARGET' };
  if (fac.charOnly && c.id !== fac.charOnly) return { ok: false, reason: 'NEED_TRAIT' };
  if ((s.facilities[target] || 0) >= (fac.max || 1)) return { ok: false, reason: 'MAX' };
  const disc = c.traits?.craftDisc || 0;
  const need = (n) => Math.max(1, Math.ceil(n * (1 - disc)));
  for (const [k, v] of Object.entries(fac.cost)) if (!ctx.hasItem(k, need(v))) { ctx.fact('no_material', { item: k }); return { ok: false, reason: 'NO_ITEM' }; }
  if (fac.waterStart && !ctx.hasItem('water', fac.waterStart)) { ctx.fact('no_material', { item: 'water' }); return { ok: false, reason: 'NO_ITEM' }; }
  for (const [k, v] of Object.entries(fac.cost)) ctx.takeItem(k, need(v), '建造');
  if (fac.waterStart) ctx.takeItem('water', fac.waterStart, '浇灌');
  ctx.spendAp(c, fac.ap || 2);
  s.facilities[target] = (s.facilities[target] || 0) + 1;
  ctx.emit('FACILITY_BUILT', { facility: target, to: s.facilities[target] });
  // 园子种下即计时（H-10）；捕鼠笼有食自动上饵（H-09）
  if (target === 'garden' || target === 'garden_veg') {
    s.facilities.gardenStarted = s.day;
    ctx.emit('FACILITY_STATE', { facility: 'gardenStarted', to: s.day });
  }
  if (target === 'trap' && ctx.hasItem('raw')) {
    ctx.takeItem('raw', 1, '上饵');
    s.facilities.trapBaited = true; s.facilities.trapDay = s.day;
    ctx.emit('FACILITY_STATE', { facility: 'trapBaited', to: true });
    ctx.emit('FACILITY_STATE', { facility: 'trapDay', to: s.day });
  }
  ctx.fact('build', { char: c.id, facility: target });
  return { ok: true };
}

function actTreat(ctx, c, med, patientId) {
  const p = patientId ? charById(ctx.s, patientId) : null;
  if (!p) return { ok: false, reason: 'NO_PATIENT' };
  recordCausal(ctx, 'heal', { actor: c.id, target: p.id }); // 医治构筑角色间信任弧（CY-11）
  const day = ctx.s.day;
  const boost = c.traits?.healer;
  if (med === 'bandage' && ctx.hasItem('bandage')) {
    if (p.wound < 1) return { ok: false, reason: 'NO_NEED' };
    ctx.takeItem('bandage', 1, '治疗');
    ctx.setCharFlag(p, 'woundTreatedDay', day);
    ctx.setWound(p, p.wound >= 2 ? p.wound - 1 : p.wound);
    if (boost && p.wound >= 1) ctx.setWound(p, p.wound - 1);
    ctx.spendAp(c, 1);
    ctx.fact('treat', { char: c.id, patient: p.id, med: 'bandage' });
    return { ok: true };
  }
  if (med === 'meds' && ctx.hasItem('meds')) {
    if (p.sick < 1) return { ok: false, reason: 'NO_NEED' };
    ctx.takeItem('meds', 1, '治疗');
    ctx.setCharFlag(p, 'sickTreatedDay', day);
    ctx.setSick(p, p.sick >= 2 ? p.sick - 1 : p.sick);
    if (boost && p.sick >= 1) ctx.setSick(p, p.sick - 1);
    ctx.spendAp(c, 1);
    ctx.fact('treat', { char: c.id, patient: p.id, med: 'meds' });
    return { ok: true };
  }
  if (med === 'herbmed' && ctx.hasItem('herbmed')) {
    if (p.sick < 1) return { ok: false, reason: 'NO_NEED' };
    ctx.takeItem('herbmed', 1, '治疗');
    if (p.sick === 1) ctx.setSick(p, 0); else ctx.setCharFlag(p, 'sickTreatedHerb', true);
    ctx.spendAp(c, 1);
    ctx.fact('treat', { char: c.id, patient: p.id, med: 'herbmed' });
    return { ok: true };
  }
  ctx.fact('no_med', {});
  return { ok: false, reason: 'NO_ITEM' };
}

function actTalk(ctx, c, targetId) {
  const p = targetId ? charById(ctx.s, targetId) : null;
  if (!p || p.id === c.id) return { ok: false, reason: 'NO_TARGET' };
  ctx.spendAp(c, 1);
  const lvl = moodLevel(p.moodPts).key;
  const deep = lvl === 'low' || lvl === 'depressed' || !!p.breakdown;
  ctx.moodRaw(p, deep ? 2 : 1, '交谈');
  // CY-32 安抚系数：崩溃链的安抚强度 = 基础 ×（1 + 0.5 × 信任弧档）——过命的人一句话顶陌生人四句
  const stage = pairStage(ctx.s, c.id, p.id);
  if (p.breakdown) ctx.setCharFlag(p, 'soothed', p.soothed + Math.round((deep ? 2 : 1) * (1 + 0.5 * stage)));
  recordCausal(ctx, 'comfort', { actor: c.id, target: p.id });
  ctx.fact('talk', { char: c.id, target: p.id });
  return { ok: true };
}

function actRest(ctx, c) {
  // I-09 卧床：当日 AP 压到 1，疲劳 -1，伤病恢复矩阵按卧床计
  if (c.bedRest) return { ok: false, reason: 'DONE_TODAY' };
  ctx.setCharFlag(c, 'bedRest', true);
  c.ap = Math.min(c.ap, 1);
  ctx.emit('AP_SPENT', { char: c.id, n: 0, left: c.ap });
  ctx.setFatigue(c, c.fatigue - 1);
  ctx.fact('rest', { char: c.id });
  return { ok: true };
}

function actRadio(ctx, c) {
  const s = ctx.s;
  if (!s.facilities.radio) { ctx.fact('need_facility', { facility: '收音机' }); return { ok: false, reason: 'NEED_FACILITY' }; }
  ctx.spendAp(c, 1);
  recordCausal(ctx, 'listen_radio', { actor: c.id });
  const bc = ctx.pack.broadcasts;
  const roll = ctx.rng.int(10);
  if (roll < 4) {
    const news = ctx.rng.pick(bc.warNewsPool);
    const katya = charById(s, 'katya');
    ctx.fact('radio_news', { text: news.text, note: katya && news.katya_note ? news.katya_note : null });
    if (katya && news.katya_note) ctx.mood(katya, 1, '记者直觉');
  } else if (roll < 6) {
    const winter = s.winterActive;
    const tomorrow = ctx.rng.weighted([{ w: 4, v: 'clear' }, { w: 2, v: 'rain' }, { w: winter ? 4 : 1, v: winter ? 'snow' : 'fog' }, { w: winter ? 2 : 0, v: 'cold' }]).v;
    ctx.setFlag('weatherForecast', tomorrow);
    ctx.fact('radio_weather', { tomorrow });
  } else if (roll < 8) {
    if (s.day - s.musicLastDay >= (bc.music.cooldownDays || 3)) {
      ctx.setFlag('musicLastDay', s.day);
      ctx.moodAll(1, '音乐');
      ctx.fact('radio_music', {});
    } else ctx.fact('radio_static', {});
  } else {
    const zofia = charById(s, 'zofia');
    if (zofia && !s.firedOnce['bc_missing']) {
      ctx.setFlag('firedOnce', { ...s.firedOnce, bc_missing: true });
      ctx.mood(zofia, -2, '寻人启事');
      ctx.addKnowledge(1, '寻人启事');
      ctx.fact('radio_missing', { text: bc.missing.text });
    } else ctx.fact('radio_static', {});
  }
  return { ok: true };
}

function actSearchHome(ctx, c, target) {
  const s = ctx.s, home = ctx.pack.locMap.home;
  // 时间胶囊（EC-02）：后院里"无名者的埋藏"——上周目你埋的，这局能挖出来
  if (target === 'yard' && s.echoes?.capsules?.length) {
    const cap = s.echoes.capsules.find((x) => !s.capsuleFound?.[x.key]);
    if (cap) {
      s.capsuleFound = { ...(s.capsuleFound || {}), [cap.key]: true };
      if (!cap.foundRun) ctx.addItem(cap.item, 1, '时间胶囊');
      ctx.fact('capsule_found', { item: cap.item, message: cap.message, fresh: !cap.foundRun });
      ctx.spendAp(c, 1);
      return { ok: true };
    }
  }
  let did = false;
  for (const r of home.rooms) {
    if (!s.house.opened[r.id]) continue;
    for (const cont of r.containers || []) {
      if (target && cont.id !== target && r.id !== target) continue;
      if (s.house.searched[cont.id]) continue;
      if (cont.type === 'locked' && !s.house.searched[cont.id + ':open']) continue;
      s.house.searched[cont.id] = true;
      ctx.emit('HOUSE_SEARCHED', { cont: cont.id });
      did = true;
      lootContainer(ctx, cont, c, 'home');
    }
  }
  if (!did) { ctx.fact('nothing_to_search', {}); return { ok: false, reason: 'NOTHING' }; }
  ctx.spendAp(c, 1);
  return { ok: true };
}

function actOpenRoom(ctx, c, roomId) {
  const s = ctx.s, home = ctx.pack.locMap.home;
  const r = home.rooms.find((x) => x.id === roomId);
  if (!r || s.house.opened[r.id]) return { ok: false, reason: 'BAD_TARGET' };
  if (r.door === 'locked') {
    const ap = 1;
    if (c.ap < ap) { ctx.fact('no_ap', { char: c.id }); return { ok: false, reason: 'NO_AP' }; }
    if (ctx.hasItem('crowbar')) {
      ctx.spendAp(c, ap);
    } else if (ctx.hasItem('lockpick')) {
      if (ctx.rng.chance(0.5)) { ctx.takeItem('lockpick', 1, '折断'); ctx.fact('lockpick_broke', {}); }
      ctx.spendAp(c, ap);
    } else { ctx.fact('no_tool', { tool: '撬棍' }); return { ok: false, reason: 'NO_ITEM' }; }
    s.house.opened[r.id] = true;
    ctx.emit('HOUSE_OPENED', { room: r.id });
    ctx.fact('open_room', { room: r.name, char: c.id });
    return { ok: true };
  }
  if (r.door === 'rubble') {
    if (!ctx.hasItem('shovel')) { ctx.fact('no_tool', { tool: '铲子' }); return { ok: false, reason: 'NO_ITEM' }; }
    if (c.ap < 2) { ctx.fact('no_ap', { char: c.id }); return { ok: false, reason: 'NO_AP' }; }
    ctx.spendAp(c, 2);
    s.house.opened[r.id] = true;
    ctx.emit('HOUSE_OPENED', { room: r.id });
    ctx.fact('open_room', { room: r.name, char: c.id });
    return { ok: true };
  }
  s.house.opened[r.id] = true;
  ctx.emit('HOUSE_OPENED', { room: r.id });
  return { ok: true };
}

/** 文档门禁（任务链的门：条件不满足时这张纸不在世界里） */
export function docAvailable(s, pack, docId) {
  const d = pack.docMap[docId];
  if (!d) return false;
  if (s.docsSeen.includes(docId)) return false;
  if (d.gateFlag && !s.eventFlags[d.gateFlag]) return false;
  return true;
}

/** 容器搜刮共用：产出物品 + 文档（含暗格 40% 发现） */
export function lootContainer(ctx, cont, c, where) {
  const s = ctx.s;
  if (cont.type === 'hidden' && where === 'home') {
    if (s.house.hiddenFound[cont.id]) { ctx.fact('search_miss', {}); return; }
    if (ctx.rng.chance(0.4)) {
      ctx.emit('HIDDEN_FOUND', { cont: cont.id });
      ctx.fact('hidden_found', { name: cont.name });
      const doc = cont.doc && docAvailable(s, ctx.pack, cont.doc) ? cont.doc : null;
      if (doc) findDoc(ctx, doc, c);
    } else ctx.fact('search_miss', {});
    return;
  }
  const entries = (cont.loot || []).filter((e) => (e.w || 0) > 0);
  if (!entries.length) { ctx.fact('search_miss', {}); return; }
  const got = [];
  const hits = ctx.rng.chance(0.8) ? (ctx.rng.chance(0.35) ? 2 : 1) : 0;
  for (let k = 0; k < hits; k++) {
    const e = ctx.rng.weighted(entries);
    const n = ctx.rng.range(e.count[0], e.count[1]);
    if (n > 0) { ctx.addItem(e.item, n, '搜刮'); got.push({ item: e.item, n }); }
  }
  if (cont.docs?.length && ctx.rng.chance(0.5)) {
    const unfound = cont.docs.filter((d) => docAvailable(s, ctx.pack, d));
    if (unfound.length) findDoc(ctx, ctx.rng.pick(unfound), c);
  }
  ctx.fact(got.length ? 'search_hit' : 'search_miss', { got, where });
}

export function findDoc(ctx, docId, c) {
  const s = ctx.s, doc = ctx.pack.docMap[docId];
  if (!doc || s.docsSeen.includes(docId)) return;
  s.docsSeen.push(docId);
  ctx.emit('DOC_FOUND', { docId });
  ctx.addKnowledge(doc.kp, doc.id);
  ctx.fact('doc_found', { docId, title: doc.title, layer: doc.layer });
  if (c) ctx.mood(c, 1, '拾获故纸');
  // 任务链钩子：找到某份文档 = 某条线的下一步
  if (doc.onFoundFlag) {
    s.eventFlags = { ...s.eventFlags, [doc.onFoundFlag]: true };
    ctx.emit('FLAG', { key: 'eventFlags', val: structuredClone(s.eventFlags) });
  }
}

function actChop(ctx, c) {
  const s = ctx.s;
  if (!ctx.hasItem('axe')) { ctx.fact('no_tool', { tool: '斧头' }); return { ok: false, reason: 'NO_ITEM' }; }
  if (s.homeFurniture <= 0) { ctx.fact('no_furniture', {}); return { ok: false, reason: 'NO_ITEM' }; }
  ctx.setFlag('homeFurniture', s.homeFurniture - 1);
  ctx.addItem('wood', 2, '劈柴'); ctx.addItem('parts', 1, '劈柴');
  ctx.spendAp(c, 1);
  ctx.fact('chop', { char: c.id });
  return { ok: true };
}

function actRepair(ctx, c) {
  const s = ctx.s;
  if (s.doorLevel <= 0) return { ok: false, reason: 'NO_NEED' };
  if (!ctx.hasItem('wood', 2)) { ctx.fact('no_material', { item: 'wood' }); return { ok: false, reason: 'NO_ITEM' }; }
  ctx.takeItem('wood', 2, '修门');
  ctx.spendAp(c, 1);
  ctx.emit('DOOR_REPAIRED', {});
  ctx.fact('repair_door', { char: c.id });
  return { ok: true };
}

function actRead(ctx, c) {
  if (!ctx.hasItem('book')) { ctx.fact('no_item', { item: '书' }); return { ok: false, reason: 'NO_ITEM' }; }
  if (c.readToday) return { ok: false, reason: 'DONE_TODAY' };
  ctx.setCharFlag(c, 'readToday', true);
  ctx.spendAp(c, 1);
  ctx.mood(c, c.traits?.craftAdv ? 2 : 1, '读书');
  ctx.fact('read', { char: c.id });
  return { ok: true };
}

function actPiano(ctx, c) {
  const s = ctx.s;
  if (!c.traits?.piano) return { ok: false, reason: 'NEED_TRAIT' };
  if (s.facilities.piano < 3) { ctx.fact('piano_broken', { level: s.facilities.piano }); return { ok: false, reason: 'NEED_REPAIR' }; }
  ctx.spendAp(c, 1);
  const first = !s.firedOnce['piano_first'];
  ctx.setFlag('firedOnce', { ...s.firedOnce, piano_first: true });
  ctx.moodAll(first ? 3 : 2, '演奏');
  recordCausal(ctx, 'play_music', { actor: c.id });
  ctx.fact('piano_play', { first, char: c.id });
  return { ok: true };
}
