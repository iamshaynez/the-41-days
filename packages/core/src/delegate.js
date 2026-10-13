// 管家层（决断意志模型）：玩家只做决断与表达，日常由内核按策略自动张罗。
// 三个规划器产出与裁判/直读解析器完全相同的意图对象，走同一条 resolve 管线——
// 自动化不发明第二条状态通道。bots.js 是这些策略的对抗性参考，本文件是游戏内正式版。
import { aliveChars, apMaxOf, policyOf, moodLevel } from './state.js';
import { DAY_ACTIONS, AP_COST } from './dayActions.js';

const itemName = (pack, id) => pack.itemMap[id]?.name || id;
const has = (s, id, n = 1) => (s.inventory[id] || 0) >= n;
const delegated = (i) => ({ ...i, delegated: true });

/** 谋士选项的意图类型白名单：玩家的"方案"只有这些；meta/whisper/event_choice/advance 不是方案 */
export const OPTION_INTENT_TYPES = new Set(['act', 'dusk_assign', 'night', 'night_directive', 'trade_op', 'direction', 'policy', 'auto_day', 'auto_night']);

/** 意图可行性（只读检查，不碰状态）：谋士生成的选项必须点得动——
 *  渲染出来的选项不允许点了落空。粗门：人在不在、阶段对不对、货有没有；
 *  细账（价格带、材料够不够）仍由 resolve 在执行时裁决。 */
export function feasibleIntent(state, pack, intent) {
  const s = state;
  if (!intent || typeof intent !== 'object' || !OPTION_INTENT_TYPES.has(intent.type)) return false;
  switch (intent.type) {
    case 'act': {
      // 谋士选项的硬保证：过了这道门的动作，内核必须做得动。
      // 逐动词镜像 applyDayAction 的落空条件（线上教训：talk 目标不存在→NO_TARGET、
      // 家里翻空→search_home NOTHING、门没坏→repair、无斧→chop）
      if (s.phase !== 'day') return false;
      if (!DAY_ACTIONS.includes(intent.action)) return false;
      const c = intent.actor ? s.chars.find((x) => x.id === intent.actor) : null;
      if (!c || !c.alive || c.ap < Math.max(1, AP_COST[intent.action] ?? 1)) return false;
      switch (intent.action) {
        case 'eat': return ['meal', 'canned', 'raw', 'meat'].some((i) => (s.inventory[i] || 0) > 0);
        case 'cook':
          return !!s.facilities.stove
            && ((s.inventory.raw || 0) > 0 || (s.inventory.meat || 0) > 0 || (s.inventory.veg || 0) >= 2)
            && (c.traits?.cook || (s.facilities.stoveFireLeft || 0) > 0
              || (s.inventory.firewood || 0) > 0 || (s.inventory.book || 0) > 0 || (s.inventory.wood || 0) > 0);
        case 'craft': {
          const r = pack.recipes.find((x) => x.id === intent.target);
          if (!r || (r.facility && !s.facilities[r.facility])) return false;
          return (r.need || []).every((n) => has(s, n.item, n.n));
        }
        case 'build': {
          const f = pack.facilityMap ? pack.facilityMap[intent.target] : null;
          if (!f) return false;
          if ((s.facilities[intent.target] || 0) >= (f.max || 1)) return false; // 已满级（内核会拒 MAX）
          if (intent.target === 'door' && s.doorLevel >= (pack.doorReinforce?.maxLevel ?? 3)) return false;
          return Object.entries(f.cost || {}).every(([k, n]) => has(s, k, n));
        }
        case 'treat': {
          if (!['bandage', 'meds', 'herbmed'].includes(intent.target) || !has(s, intent.target)) return false;
          const patient = intent.target === 'bandage'
            ? aliveChars(s).find((x) => x.wound >= 1 && x.woundTreatedDay !== s.day)
            : aliveChars(s).find((x) => x.sick >= 1 && x.sickTreatedDay !== s.day && !x.sickTreatedHerb);
          return !!patient;
        }
        case 'talk': {
          const t = intent.target ? s.chars.find((x) => x.id === intent.target) : null;
          return !!t && t.alive && t.id !== c.id;
        }
        case 'rest': return !c.bedRest;
        case 'read': return (s.inventory.book || 0) > 0 && !c.readToday;
        case 'listen_radio': return !!s.facilities.radio;
        case 'search_home': {
          if (intent.target === 'yard' && (s.echoes?.capsules || []).some((x) => !s.capsuleFound?.[x.key])) return true;
          return (pack.locMap.home.rooms || []).some((r) => s.house.opened[r.id] && (r.containers || []).some((ct) =>
            !s.house.searched[ct.id] && (ct.type !== 'locked' || s.house.searched[ct.id + ':open'])));
        }
        case 'open_room': {
          const r = (pack.locMap.home.rooms || []).find((x) => x.id === intent.target);
          if (!r || s.house.opened[r.id]) return false;
          if (r.door === 'locked') return has(s, 'crowbar') || has(s, 'lockpick');
          if (r.door === 'rubble') return has(s, 'shovel') && c.ap >= 2;
          return true;
        }
        case 'chop': return has(s, 'axe') && (s.homeFurniture || 0) > 0;
        case 'repair': return s.doorLevel > 0 && has(s, 'wood', 2);
        case 'play_piano': return !!c.traits?.piano && (s.facilities.piano || 0) >= 3;
        default: return true; // guard / sleep
      }
    }
    case 'dusk_assign': {
      if (s.phase !== 'dusk') return false;
      if (intent.scavenger) {
        const c = s.chars.find((x) => x.id === intent.scavenger);
        if (!c || !c.alive || c.wound >= 3 || c.sick >= 3) return false;
      }
      if (intent.location && !s.knownLocs.includes(intent.location)) return false;
      return true;
    }
    case 'night': {
      if (s.phase !== 'night' || !s.night || s.night.home) return false;
      const loc = pack.locMap[s.night.locId];
      if (!loc) return false;
      if (['move', 'open', 'clear', 'bars'].includes(intent.action)) return loc.rooms.some((r) => r.id === intent.target);
      if (intent.action === 'search') return intent.target == null || loc.rooms.some((r) => (r.containers || []).some((c) => c.id === intent.target));
      if (['dialogue', 'attack', 'backstab', 'ignore'].includes(intent.action)) return (loc.npcs || []).some((n) => n.id === intent.target);
      return ['observe', 'retreat', 'push_on'].includes(intent.action);
    }
    case 'trade_op': {
      if (s.phase !== 'day' || !s.franko) return false;
      for (const [id, n] of Object.entries(intent.give || {})) if ((s.inventory[id] || 0) < n) return false;
      for (const [id, n] of Object.entries(intent.get || {})) {
        const sku = s.franko.stock.find((x) => x.item === id);
        if (!sku || sku.n < n) return false;
      }
      return !!intent.give && !!intent.get;
    }
    case 'direction': return typeof intent.text === 'string' && !!intent.text.trim() && intent.text.length <= 60;
    case 'policy': return typeof intent.key === 'string' && ['feeding', 'rationing', 'nightApproach'].includes(intent.key);
    case 'auto_day': return s.phase === 'day';
    case 'auto_night': return s.phase === 'night' && !!s.night && !s.night.home;
    case 'night_directive': return s.phase === 'night' && !!s.night && !s.night.home;
    default: return false;
  }
}

/** 角色一句话画像（决策卡里给玩家看的判断依据，不现编，全是状态事实） */
export function charDigest(pack, id) {
  const def = pack.charMap[id];
  if (!def) return '';
  const bits = [];
  if (def.backpack >= 14) bits.push('背包大');
  if ((def.combat || 0) > 0) bits.push('能打');
  if (def.traits?.breach) bits.push('破门不用撬棍');
  if (def.traits?.sprint) bits.push('跑得快');
  if (def.traits?.stealthy) bits.push('手脚轻');
  if (def.traits?.healer) bits.push('懂医');
  if (def.traits?.cook) bits.push('厨子');
  return bits.join('，');
}

/* ════════════════════════ 白天：planDay ════════════════════════
   优先级与 sim 的均衡策略同源：吃 → 治 → 养 → 建 → 做饭 → 搜家。
   策略旋钮（state.policy）：rationing 省粮 / feeding 开关 / nightApproach 影响黄昏方案。 */
export function planDay(state, pack) {
  const s = state, pol = policyOf(s);
  const intents = [];
  const busy = new Set();
  const free = (pred = () => true) => aliveChars(s).find((c) => c.ap > 0 && !busy.has(c.id) && pred(c));
  const use = (id) => busy.add(id);

  // —— 交易（水下）：商人在门口，管家自取一笔建议成交——价目卡已退场，
  //    想干预的玩家用自由文本开价（trade_op），或种下念头让世界长出回应 ——
  if (s.franko && s.phase === 'day') {
    const deal = tradeDeals(s, pack)[0];
    if (deal) intents.push(delegated({ type: 'trade_op', give: deal.give, get: deal.get }));
  }
  // —— 吃（feeding=auto 时）：熟食优先；省粮策略只喂真正饿的 ——
  if (pol.feeding === 'auto') {
    const threshold = pol.rationing ? 1 : 2;
    for (const c of aliveChars(s)) {
      if (c.hunger > threshold) continue;
      const item = has(s, 'meal') ? 'meal' : (has(s, 'canned') ? 'canned' : (has(s, 'raw') ? 'raw' : (has(s, 'meat') ? 'meat' : null)));
      if (item) intents.push(delegated({ type: 'act', actor: c.id, action: 'eat', target: item }));
    }
  }
  // —— 治：有药有人就治 ——
  {
    const healer = free((c) => c.traits?.healer);
    if (healer) {
      const wounded = aliveChars(s).find((c) => c.wound >= 1 && c.woundTreatedDay !== s.day);
      const sick = aliveChars(s).find((c) => c.sick >= 1 && c.sickTreatedDay !== s.day && !c.sickTreatedHerb);
      if (wounded && has(s, 'bandage')) { intents.push(delegated({ type: 'act', actor: healer.id, action: 'treat', target: 'bandage', patient: wounded.id })); }
      else if (sick && has(s, 'meds')) { intents.push(delegated({ type: 'act', actor: healer.id, action: 'treat', target: 'meds', patient: sick.id })); }
      else if (sick && has(s, 'herbmed')) { intents.push(delegated({ type: 'act', actor: healer.id, action: 'treat', target: 'herbmed', patient: sick.id })); }
    }
  }
  // —— 卧床：重伤/重病养伤 ——
  for (const c of aliveChars(s)) {
    if ((c.wound >= 2 || c.sick >= 2) && !c.bedRest) intents.push(delegated({ type: 'act', actor: c.id, action: 'rest' }));
  }
  // —— 建造序：炉灶 → 门 → 冬前取暖 → 捕鼠笼 → 床 → 升级（参照 sim 均衡策略）——
  //    材料账预检：目标选出来先核 cost（一周目实测：没木板还天天提议捕鼠笼，
  //    35 天"安排了→做不到"的墙纸式噪音）；材料不足就跳过，建材缺口交给交易建议补
  {
    const builder = aliveChars(s).find((c) => c.ap >= 2 && c.apMax >= 2 && !busy.has(c.id));
    const canAfford = (target) => {
      const f = pack.facilityMap?.[target];
      return !!f && Object.entries(f.cost || {}).every(([k, n]) => has(s, k, n));
    };
    if (builder) {
      const winterSoon = s.winterActive || s.day >= s.winterStart - 4;
      let target = null;
      if (!s.facilities.stove && canAfford('stove')) target = 'stove';
      else if (s.doorLevel < 1 && canAfford('door')) target = 'door';
      else if (winterSoon && !s.facilities.heater && canAfford('heater')) target = 'heater';
      else if (!s.facilities.trap && canAfford('trap')) target = 'trap';
      else if ((s.facilities.bed || 0) < 2 && canAfford('bed')) target = 'bed';
      else if (!s.facilities.stove_eco && has(s, 'wood', 4) && has(s, 'parts', 8)) target = 'stove_eco';
      else if (!s.facilities.heater_iron && has(s, 'comp', 5)) target = 'heater_iron';
      else if (!s.facilities.garden && has(s, 'comp', 6)) target = 'garden';
      if (target) { intents.push(delegated({ type: 'act', actor: builder.id, action: 'build', target })); use(builder.id); }
    }
  }
  // —— 做饭：有灶有料就备熟食（存 4 份封顶） ——
  {
    // 本地估算余量（规划器不得触碰 state——真实消耗由内核在执行时结算）
    let estMeal = s.inventory.meal || 0, estRaw = s.inventory.raw || 0, estMeat = s.inventory.meat || 0, estVeg = s.inventory.veg || 0;
    // 燃料估算：厨子省柴，余火白赚；其余情况每锅一份可燃物
    let estFuel = (s.inventory.firewood || 0) + (s.inventory.book || 0) + (s.inventory.wood || 0) + (s.facilities.stoveFireLeft || 0);
    let guard = 0;
    while ((estRaw > 0 || estMeat > 0 || estVeg >= 2) && s.facilities.stove && estMeal < 4 && guard++ < 4) {
      const cook = free((c) => c.traits?.cook) || free();
      if (!cook) break;
      if (!cook.traits?.cook && estFuel <= 0) break; // 没柴了，锅是冷的
      intents.push(delegated({ type: 'act', actor: cook.id, action: 'cook' }));
      use(cook.id);
      estMeal += 1;
      if (!cook.traits?.cook) estFuel -= 1;
      if (estRaw > 0) estRaw -= 1; else if (estMeat > 0) estMeat -= 1; else estVeg -= 2;
    }
  }
  // —— 搜家：还有没翻过的角落就翻 ——
  {
    const idler = free();
    const homeLeft = pack.locMap.home.rooms.some((r) => s.house.opened[r.id] && (r.containers || []).some((ct) => !s.house.searched[ct.id]));
    if (idler && homeLeft) intents.push(delegated({ type: 'act', actor: idler.id, action: 'search_home' }));
  }
  return intents;
}

/* ════════════════════════ 晨报：dawnProblems ════════════════════════
   问题前置原则：晨报不止报状态，要把"今天火烧眉毛的事"摆到玩家面前。 */
export function dawnProblems(state, pack) {
  const s = state;
  const out = [];
  const foodTotal = ['meal', 'canned', 'raw', 'meat', 'veg'].reduce((a, i) => a + (s.inventory[i] || 0), 0);
  if (foodTotal === 0) out.push({ sev: 3, text: '家里一点吃的都没有了。' });
  else if (foodTotal <= 2 && !s.facilities.stove) out.push({ sev: 2, text: '存粮见底了，而且没有炉灶。' });
  else if (foodTotal <= 2) out.push({ sev: 1, text: '存粮只够一两顿。' });
  for (const c of aliveChars(s)) {
    if (c.hunger === 0) out.push({ sev: 3, text: `${c.name}已经饿到极限了。` });
    else if (c.hunger === 1) out.push({ sev: 2, text: `${c.name}饿得发慌。` });
    if (c.wound === 3 || c.sick === 3) out.push({ sev: 3, text: `${c.name}病危，拖不过几天。` });
    else if ((c.wound === 2 || c.sick === 2) && !has(s, 'bandage') && !has(s, 'meds') && !has(s, 'herbmed')) out.push({ sev: 2, text: `${c.name}伤病在身，家里却没有药。` });
    if (c.breakdown) out.push({ sev: 3, text: `${c.name}崩溃了——需要有人陪他说话，别让他一个人待着。` });
    // 心情的滑坡要趁还能拉的时候看见（一周目实测：连环崩溃当天才见警讯，已无力回天）
    else if (moodLevel(c.moodPts).key === 'depressed') out.push({ sev: 2, text: `${c.name}情绪很低落——多陪他说说话，别让他一个人撑。` });
  }
  const fuel = (s.inventory.firewood || 0) + (s.inventory.fuel || 0);
  if (s.winterActive && fuel < 2 && (s.facilities.heater || s.facilities.heater_iron)) out.push({ sev: 2, text: '取暖的柴快烧完了。' });
  if (s.franko) out.push({ sev: 0, text: '鲁舟的船靠在渡口边。' });
  if (s.war?.telegraphed) out.push({ sev: 0, text: '炮声稀了——懂行的人说，可能快了。' });
  return out.sort((a, b) => b.sev - a.sev);
}

/* ════════════════════════ 黄昏：planDusk ════════════════════════
   每晚必答的决策点。给出 2~3 个完整方案（人×地点×装备×守夜），玩家点一个，或自己说。 */
const LOC_RANK = ['market', 'villas', 'church', 'hospital', 'post', 'frontline'];
const LOC_BLURB = {
  market: '吃的', villas: '值钱货和锁', church: '安全，神父在',
  hospital: '药', post: '死信和旧纸', frontline: '最险，也最肥'
};

export function planDusk(state, pack) {
  const s = state;
  const alive = aliveChars(s);
  if (!alive.length) return { plans: [] };
  const known = (s.knownLocs || []).filter((l) => l !== 'home' && pack.locMap[l]);

  // 外出候选：危重出不了门（startNight 会拒），排序 = 心态可出门 > 背包 > 战斗。
  // 抑郁者 50% 拒绝出门（startNight 掷骰）——方案卡不预检心情就等于让玩家点哑炮
  const lowMind = (c) => ['depressed', 'breakdown'].includes(moodLevel(c.moodPts).key);
  const fit = alive.filter((c) => c.wound < 3 && c.sick < 3)
    .sort((a, b) => (Number(lowMind(a)) - Number(lowMind(b))) || (b.backpack - a.backpack) || ((b.combat || 0) - (a.combat || 0)));
  const scav = fit[0] || null;
  const guardOf = (excludeId) => {
    const rest = alive.filter((c) => c.id !== excludeId);
    rest.sort((a, b) => ((b.combat || 0) - (a.combat || 0)) || (b.apMax - a.apMax));
    return rest[0] || null;
  };
  const gearOf = (locId) => {
    const gear = [];
    if (has(s, 'crowbar')) gear.push('crowbar');
    const risky = (pack.locMap[locId]?.threat || 0) >= 2;
    if (risky && has(s, 'knife')) gear.push('knife');
    else if (risky && has(s, 'axe')) gear.push('axe');
    return gear;
  };
  const mkPlan = (key, scavId, locId) => {
    const gear = gearOf(locId);
    const guard = guardOf(scavId);
    const others = {};
    for (const c of alive) others[c.id] = (guard && c.id === guard.id) ? 'guard' : 'sleep';
    const scavName = s.chars.find((c) => c.id === scavId)?.name;
    const lines = [`${scavName}去${pack.locMap[locId].name}`];
    if (gear.length) lines.push(`带${gear.map((g) => itemName(pack, g)).join('、')}`);
    lines.push(guard ? `${guard.name}守夜` : '其余人都睡');
    // 情绪风险前置：抑郁者今晚可能不肯动身（50%）——玩家点卡之前就该看见
    const scavChar = s.chars.find((c) => c.id === scavId);
    const mindWarn = scavChar && lowMind(scavChar) ? `；${scavName}情绪很低，今晚可能不肯出门` : '';
    return { key, label: lines.join('，'), hint: `${LOC_BLURB[locId] || ''}${mindWarn}`, intent: { type: 'dusk_assign', scavenger: scavId, location: locId, gear, others } };
  };

  const plans = [];
  if (scav && known.length) {
    const ranked = LOC_RANK.filter((l) => known.includes(l));
    plans.push(mkPlan('a', scav.id, ranked[0]));
    const second = ranked[1] || ranked[0];
    const altScav = fit[1] || scav;
    if (second) plans.push(mkPlan('b', altScav.id, second));
  }
  // 都不出门：安排守夜（防御始终是玩家的真实选项）
  {
    const guard = guardOf(null);
    const others = {};
    for (const c of alive) others[c.id] = (guard && c.id === guard.id) ? 'guard' : 'sleep';
    plans.push({
      key: 'stay', label: `今晚都不出门${guard ? `，${guard.name}守夜` : ''}`,
      hint: '安全，但吃的不会自己长出来',
      intent: { type: 'dusk_assign', scavenger: null, location: null, gear: [], others }
    });
  }
  return { plans };
}

/* ════════════════════════ 深夜：planNightStep ════════════════════════
   夜间自动流的单步规划。返回：
   - { intent }   一步常规动作（移动/搜/撬……）
   - { stop }     岔路：停下来问玩家（NPC/低火柴/警觉）
   - null         无事可做 → 调用方撤退 */
export function planNightStep(state, pack, opts = {}) {
  const s = state, n = s.night;
  if (!n || n.home || s.phase !== 'night') return null;
  if (s.activeEvent) return { stop: { kind: 'event' } };
  const loc = pack.locMap[n.locId];
  const st = s.locState[n.locId] || { searched: {}, npcState: {} };
  const pol = policyOf(s);
  const roomIdx = loc.rooms.findIndex((r) => r.id === n.room);
  const room = loc.rooms[roomIdx];
  const approach = opts.approach || pol.nightApproach || 'normal';
  const gear = n.gear || [];

  // —— 岔路 1：NPC（道德与安全的决断永远归玩家） ——
  const npcHere = (loc.npcs || []).find((x) => (!x.room || x.room === n.room) && !st.npcState[x.id]);
  if (npcHere) {
    const options = [{ label: `上前说话`, intents: [{ type: 'night', action: 'dialogue', target: npcHere.id }] }];
    if (npcHere.stance !== 'hostile') options.push({ label: '不打扰他，接着翻', intents: [{ type: 'night', action: 'ignore', target: npcHere.id }, { type: 'auto_night' }] });
    if (npcHere.stance === 'hostile' || npcHere.stance === 'wary') {
      options.push({ label: '动手', intents: [{ type: 'night', action: 'attack', target: npcHere.id }] });
      if (gear.includes('knife')) options.push({ label: '摸黑背刺（刀）', intents: [{ type: 'night', action: 'backstab', target: npcHere.id }] });
    }
    options.push({ label: '今晚到此为止，撤', intents: [{ type: 'night', action: 'retreat' }] });
    return { stop: { kind: 'npc', text: `${npcHere.name}在这里（${npcHere.stance === 'hostile' ? '敌意' : npcHere.stance === 'wary' ? '警惕' : '看着不像坏人'}）。`, options } };
  }
  // —— 岔路 2：有人被惊动了（战斗中/枪声后） ——
  const alerted = (loc.npcs || []).find((x) => st.npcState[x.id] === 'alert');
  if (alerted) {
    return { stop: { kind: 'alert', text: `${alerted.name}警觉了。`, options: [
      { label: '打到底', intents: [{ type: 'night', action: 'attack', target: alerted.id }] },
      { label: '撤', intents: [{ type: 'night', action: 'retreat' }] }
    ] } };
  }
  // —— 岔路 3：火柴快烧完（每晚只问一次） ——
  if (n.slots <= 3 && !n.lowSlotsAck) {
    return { stop: { kind: 'low_slots', text: `火柴只剩 ${n.slots} 根了。`, options: [
      { label: '再摸黑搜最后一点', intents: [{ type: 'night', action: 'push_on' }, { type: 'auto_night' }] },
      { label: '趁还有光，回去', intents: [{ type: 'night', action: 'retreat' }] }
    ] } };
  }

  // —— 常规：先搜当前房间 ——
  const conts = room.containers || [];
  const openCont = conts.find((ct) => !st.searched[ct.id] && (ct.type !== 'locked' || st.searched[ct.id + ':open']));
  if (openCont) return { intent: { type: 'night', action: 'search', target: openCont.id } };
  // 上锁容器：谨慎不碰（撬有声响），常规有撬棍就撬，大胆都撬
  const lockedCont = conts.find((ct) => !st.searched[ct.id] && ct.type === 'locked' && !st.searched[ct.id + ':open']);
  if (lockedCont && approach !== 'cautious' && (gear.includes('crowbar') || gear.includes('lockpick'))) {
    return { intent: { type: 'night', action: 'open', target: lockedCont.id } };
  }
  // —— 换房间：向未搜尽的方向走 ——
  const roomLeft = (r) => (r.containers || []).some((ct) => !st.searched[ct.id]);
  const tryDoor = (dest) => {
    if (!dest) return null;
    const d = dest.door;
    if (!d || d === 'open') return { type: 'night', action: 'move', target: dest.id };
    if (d === 'locked' && !n.unlocked[dest.id]) {
      if (gear.includes('lockpick') || gear.includes('crowbar') || has(s, 'crowbar')) {
        if (approach === 'cautious' && !gear.includes('lockpick')) return null; // 撬棍有声响，谨慎策略绕开
        return { type: 'night', action: 'open', target: dest.id };
      }
      return null;
    }
    if (d === 'rubble' && !n.cleared[dest.id]) return gear.includes('shovel') ? { type: 'night', action: 'clear', target: dest.id } : null;
    if (d === 'bars' && !n.sawed[dest.id]) return gear.includes('saw') ? { type: 'night', action: 'bars', target: dest.id } : null;
    return { type: 'night', action: 'move', target: dest.id };
  };
  for (const step of [1, -1, 2, -2]) {
    const dest = loc.rooms[roomIdx + step];
    if (!dest || !roomLeft(dest)) continue;
    // 相邻才能直接走；隔着一间需要先移动到中间房（下一循环自然会继续）
    if (Math.abs(step) === 1) {
      const act = tryDoor(dest);
      if (act) return { intent: act };
    } else {
      const mid = loc.rooms[roomIdx + step / 2];
      const midAct = tryDoor(mid);
      if (midAct) return { intent: midAct };
    }
  }
  return null; // 搜尽了
}

/* ════════════════════════ 交易建议：tradeDeals ════════════════════════
   给交易卡的预组合成交（一键）。估值用上限价，保证内核价格带校验必过；
   想讨价还价的玩家仍可自由文本谈。 */
export function tradeDeals(state, pack) {
  const s = state;
  if (!s.franko) return [];
  const cfg = pack.manifest.difficulty[s.difficulty] || pack.manifest.difficulty.documentary;
  // 保守估值（地板价）：实际成交价只会更高，保证内核价格带校验必过。
  // （此前用均值+取整，低值物的实际价被高估一倍——建议成交会被拒，已修复）
  const estSell = (id) => Math.max(1, Math.floor((pack.itemMap[id]?.value || 0) * 0.55 * (cfg.tradeMul || 1)));
  const stock = s.franko.stock.filter((x) => x.n > 0);
  const deals = [];
  // 支付池：值钱余物 → 富余材料（留建造底线：木板 6 / 零件 4 不动）
  const RESERVE = { wood: 6, parts: 4 };
  const payPool = ['jewel', 'wine', 'moonshine', 'cigs', 'coffee', 'parts', 'wood', 'book']
    .map((id) => ({ id, est: estSell(id), n: Math.max(0, (s.inventory[id] || 0) - (RESERVE[id] || 0)) }))
    .filter((p) => p.n > 0);
  const cover = (price, qty) => {
    // 从支付池凑够 price×qty（含 5% 余量），凑不齐返回 null
    let need = Math.ceil(price * qty * 1.05);
    const give = {};
    for (const p of payPool) {
      while (need > 0 && (give[p.id] || 0) < p.n) {
        give[p.id] = (give[p.id] || 0) + 1;
        need -= p.est;
      }
      if (need <= 0) break;
    }
    return need <= 0 ? give : null;
  };
  const want = [
    { item: 'bandage', when: () => !has(s, 'bandage') },
    { item: 'meds', when: () => !has(s, 'meds') },
    { item: 'canned', when: () => (s.inventory.canned || 0) + (s.inventory.raw || 0) + (s.inventory.meal || 0) < 4 },
    { item: 'raw', when: () => (s.inventory.canned || 0) + (s.inventory.raw || 0) + (s.inventory.meal || 0) < 4 },
    { item: 'firewood', when: () => (s.inventory.firewood || 0) < 3 },
    // 建材（一周目实测：没有斧子的家永远凑不齐捕鼠笼的 3 木板——管家不会劈柴时，
    // 商路就是唯一来路；把缺口摆上建议单，而不是天天提一个做不到的建造）
    { item: 'wood', when: () => (s.inventory.wood || 0) < 4 && !has(s, 'axe') },
    { item: 'parts', when: () => (s.inventory.parts || 0) < 4 }
  ];
  for (const w of want) {
    const sku = stock.find((x) => x.item === w.item);
    if (!sku || !w.when()) continue;
    const give = cover(sku.buy, 1);
    if (!give) continue;
    const giveTxt = Object.entries(give).map(([id, n]) => `${n} ${itemName(pack, id)}`).join(' + ');
    deals.push({ label: `${giveTxt} 换 1 ${itemName(pack, sku.item)}`, give, get: { [sku.item]: 1 } });
    if (deals.length >= 3) break;
  }
  return deals;
}

/* ════════════════════════ 自由输入示例：freeExamples ════════════════════════
   停问卡末位输入行的语境化示例（命运导演 P0b）：教玩家"能说什么"。
   状态现算、按天轮换；示例优先选直读解析器也认得的说法——不说系统做不到的话。 */
export function freeExamples(state, pack) {
  const s = state;
  const out = { day: [], dusk: [], night: [], trade: [], event: [] };
  if (s.over || s.phase === 'prologue') return out;
  const alive = aliveChars(s);
  if (!alive.length) return out;
  const name = (i) => alive[Math.min(i, alive.length - 1)]?.name || '有人';
  const known = (s.knownLocs || []).filter((l) => l !== 'home' && pack.locMap[l]);
  const locName = (i) => pack.locMap[known[Math.min(i, Math.max(known.length - 1, 0))]]?.name || '南市';
  out.day = ['照常过吧', '以后省着吃', `鼓励${name(0)}把想做的事做完`];
  out.dusk = [`今晚${name(0)}去${locName(0)}，带铁撬`, '今晚谁都不出门', `今晚${name(1)}守夜`];
  out.night = ['今晚只拿吃的，见人就绕', '探明虚实就回，不贪', '放手干，值钱的都拿'];
  out.trade = ['用2木板换1生食', '这价太黑了，便宜点'];
  out.event = ['先问清楚他是谁，再说', '隔着门回话，不开门'];
  return out;
}
/* ════════════════════════ 情境建议：suggests ════════════════════════
   取代静态 chips：由状态驱动的"你可能想说"（文本经由直读/裁判解析，管线唯一）。 */
export function suggests(state, pack) {
  const s = state;
  const out = [];
  if (s.over) return out;
  if (s.phase === 'prologue') return out;
  if (s.phase === 'day') {
    // 宏观节奏（一次选择走完今天）：白天建议全部收卷——单效诉求（省粮/听更）也并入当天方略
    // 商人在门口：把管家的建议成交摆上建议行（水下交易也要有上岸的入口——
    // 一周目实测鲁舟到访 22 次玩家只看见 2 笔，商路存在感近于零）
    if (s.franko) {
      const deal = tradeDeals(s, pack)[0];
      if (deal) out.push({ label: `跟鲁舟换：${deal.label}`, intents: [{ type: 'trade_op', give: deal.give, get: deal.get }] });
    }
    const close = { type: 'auto_day' };
    if (!s.activeEvent) out.push({ label: '让他们自己张罗这一天', intents: [close] });
    const foodTotal = ['meal', 'canned', 'raw', 'meat'].reduce((a, i) => a + (s.inventory[i] || 0), 0);
    if (foodTotal <= 3 && foodTotal > 0) out.push({ label: '省着吃，今天交给他们', intents: [{ type: 'policy', key: 'rationing', value: true }, close] });
    if (policyOf(s).rationing && foodTotal > 3) out.push({ label: '恢复正常吃饭，今天交给他们', intents: [{ type: 'policy', key: 'rationing', value: false }, close] });
    if (s.facilities.radio) {
      const hearer = aliveChars(s).find((c) => c.ap > 0 && !c.bedRest);
      if (hearer) out.push({ label: '听听更鼓，其余交给他们', intents: [{ type: 'act', actor: hearer.id, action: 'listen_radio' }, close] });
    }
    if (s.day <= 2) out.push({ label: '我能做什么？', text: '帮助' }); // 求助不收卷
  } else if (s.phase === 'dusk') {
    out.push({ label: '我自己安排今晚', text: '' }); // 空 text = 聚焦输入框
  } else if (s.phase === 'night' && s.night && !s.night.home) {
    out.push({ label: '继续', intents: [{ type: 'auto_night' }] });
    out.push({ label: '撤退', intents: [{ type: 'night', action: 'retreat' }] });
  }
  return out;
}
