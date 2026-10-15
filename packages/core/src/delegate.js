// 管家层（决断意志模型）：玩家只做决断与表达，日常由内核按策略自动张罗。
// 三个规划器产出与裁判/直读解析器完全相同的意图对象，走同一条 resolve 管线——
// 自动化不发明第二条状态通道。bots.js 是这些策略的对抗性参考，本文件是游戏内正式版。
import { aliveChars, apMaxOf, policyOf, moodLevel } from './state.js';
import { DAY_ACTIONS, AP_COST } from './dayActions.js';
import { LOC_ALIAS } from './parser.js';
import { threadsStateLines } from './threads.js';

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
        case 'comfort_soup': {
          if (!c.traits?.healer) return false;
          if (!has(s, 'herb') || !has(s, 'water')) return false;
          return aliveChars(s).some((x) => x.breakdown || (x.moodPts ?? 0) <= -4);
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
    case 'policy': return typeof intent.key === 'string' && ['feeding', 'rationing', 'nightApproach', 'overviewDays'].includes(intent.key);
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

  // —— 交易（水下全自动）：商人是物资匮乏的救命机会——到访必成交一笔
  //    最救命的（tradeDeals 已按断粮>药>柴>材排序），玩家零决策 ——
  if (s.franko && s.phase === 'day') {
    const deal = tradeDeals(s, pack)[0];
    if (deal) intents.push(delegated({ type: 'trade_op', give: deal.give, get: deal.get }));
  }
  // —— 吃与做饭共用一份本地估算（B-4：规划器不得安排空灶——
  //    生粮进了谁的嘴，锅就得知道；执行时的真实消耗仍由内核结算）——
  const est = { meal: s.inventory.meal || 0, canned: s.inventory.canned || 0, raw: s.inventory.raw || 0, meat: s.inventory.meat || 0, veg: s.inventory.veg || 0 };
  const pickFood = () => (est.meal > 0 ? 'meal' : est.canned > 0 ? 'canned' : est.raw > 0 ? 'raw' : est.meat > 0 ? 'meat' : null);
  // —— 吃（feeding=auto 时）：熟食优先；省粮策略只喂真正饿的 ——
  if (pol.feeding === 'auto') {
    const threshold = pol.rationing ? 1 : 2;
    for (const c of aliveChars(s)) {
      if (c.hunger > threshold) continue;
      const item = pickFood();
      if (item) { est[item] -= 1; intents.push(delegated({ type: 'act', actor: c.id, action: 'eat', target: item })); }
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
  // —— 宽心汤：心也要人医（崩溃/抑郁优先于一切杂务）——
  {
    const healer2 = free((c) => c.traits?.healer);
    const lowMind = aliveChars(s).find((c) => c.breakdown || (c.moodPts ?? 0) <= -4);
    if (healer2 && lowMind && has(s, 'herb') && has(s, 'water')) {
      intents.push(delegated({ type: 'act', actor: healer2.id, action: 'comfort_soup', patient: lowMind.id }));
      use(healer2.id);
    }
  }
  // —— 卧床：重伤/重病养伤；力竭的人也该有一日卧床（F 系：夜里安睡 + 白日卧床才追得回来）——
  for (const c of aliveChars(s)) {
    if ((c.wound >= 2 || c.sick >= 2 || c.fatigue >= 2) && !c.bedRest) intents.push(delegated({ type: 'act', actor: c.id, action: 'rest' }));
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
  // —— 做饭：有灶有料就备熟食（存 4 份封顶）——余量沿用吃段扣过的本地估算 ——
  {
    // 燃料估算：厨子省柴，余火白赚；其余情况每锅一份可燃物
    let estFuel = (s.inventory.firewood || 0) + (s.inventory.book || 0) + (s.inventory.wood || 0) + (s.facilities.stoveFireLeft || 0);
    let guard = 0;
    while ((est.raw > 0 || est.meat > 0 || est.veg >= 2) && s.facilities.stove && est.meal < 4 && guard++ < 4) {
      const cook = free((c) => c.traits?.cook) || free();
      if (!cook) break;
      if (!cook.traits?.cook && estFuel <= 0) break; // 没柴了，锅是冷的
      intents.push(delegated({ type: 'act', actor: cook.id, action: 'cook' }));
      use(cook.id);
      est.meal += 1;
      if (!cook.traits?.cook) estFuel -= 1;
      if (est.raw > 0) est.raw -= 1; else if (est.meat > 0) est.meat -= 1; else est.veg -= 2;
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
   问题前置原则：晨报不止报状态，要把"今天火烧眉毛的事"摆到玩家面前。
   批次二加笔：条目带 key（连报衰减账的键）；慢性问题连报多日隔天显示且换措辞——
   同一句提示挂三十天就成了壁纸（二周目实测"存粮只够一两顿"连挂 30 天）。 */
const KNOW_MILESTONES = [
  { k: 4, text: '你开始读得懂这座城了——里社的钟、渡口的规矩，都有了名字。' },
  { k: 8, text: '这座城的大半摊开在你眼里——有些门，正因为你读过而开。' }
];
export function dawnProblems(state, pack) {
  const s = state;
  const out = [];
  const streak = (key) => (s.problemStreak?.[key] || 0);
  /** 慢性条目：连报 ≥3 天起隔天显示，且文案换成"老毛病"——火警（sev3）永不衰减 */
  const chronic = (key, sev, text) => {
    const n = streak(key);
    if (n >= 3) {
      if (s.day % 2 === 1) return; // 隔天再说
      out.push({ sev, key, text: `${text}（老毛病了，第 ${n} 天。）` });
      return;
    }
    out.push({ sev, key, text });
  };
  const alive = aliveChars(s).length;
  const foodTotal = ['meal', 'canned', 'raw', 'meat', 'veg'].reduce((a, i) => a + (s.inventory[i] || 0), 0);
  if (foodTotal === 0) out.push({ sev: 3, key: 'food_out', text: '家里一点吃的都没有了。' });
  else if (foodTotal <= 2 && !s.facilities.stove) out.push({ sev: 2, key: 'food_low', text: `存粮只剩 ${foodTotal} 份对 ${alive} 张嘴，而且没有炉灶。` });
  else if (foodTotal <= 2) chronic('food_low', 1, `存粮只剩 ${foodTotal} 份，对 ${alive} 张嘴——只够一两顿。`);
  for (const c of aliveChars(s)) {
    if (c.hunger === 0) out.push({ sev: 3, key: `hunger_${c.id}`, text: `${c.name}已经饿到极限了。` });
    else if (c.hunger === 1) chronic(`hunger_${c.id}`, 2, `${c.name}饿得发慌。`);
    if (c.wound === 3 || c.sick === 3) out.push({ sev: 3, key: `crit_${c.id}`, text: `${c.name}病危，拖不过几天。` });
    else if ((c.wound === 2 || c.sick === 2) && !has(s, 'bandage') && !has(s, 'meds') && !has(s, 'herbmed')) chronic(`nomed_${c.id}`, 2, `${c.name}伤病在身，家里却没有药。`);
    if (c.breakdown) out.push({ sev: 3, key: `mind_${c.id}`, text: `${c.name}崩溃了——需要有人陪着，别让一个人待着。` });
    // 心情的滑坡要趁还能拉的时候看见（一周目实测：连环崩溃当天才见警讯，已无力回天）
    else if (moodLevel(c.moodPts).key === 'depressed') chronic(`mind_${c.id}`, 2, `${c.name}情绪很低落——得有人多陪着说说话。`);
  }
  const fuel = (s.inventory.firewood || 0) + (s.inventory.fuel || 0);
  if (s.winterActive && fuel < 2 && (s.facilities.heater || s.facilities.heater_iron)) chronic('fuel_low', 2, '取暖的柴快烧完了。');
  // 冬柴倒计时（E·危机弧）：有名字的坎要有数——「还能烧几夜」比「快烧完了」更让人睡不着
  if (s.winterActive && (s.facilities.heater || s.facilities.heater_iron)) {
    const perNight = s.facilities.heater_iron ? 1 : 2;
    const nights = Math.floor(fuel / perNight);
    if (nights <= 5) out.push({ sev: 1, key: 'fuel_days', text: `冬柴只够再烧 ${nights} 夜。` });
  }
  // 疫病行（E·危机弧）：两个人同时病倒，就不再是「谁的病」，是「这个家的火」
  if (aliveChars(s).filter((c) => c.sick >= 1).length >= 2) {
    out.push({ sev: 1, key: 'plague', text: '疫病进了门——这个家在发烧。' });
  }
  // 军心表（B·戏剧弧）：家书投进去的暗河，给玩家一个可见的对面水位。
  // 不给数字给档位词——D41 的刀落刀偏，要有 41 天的铺垫可循
  if (s.day >= 3 && !s.sidestory) {
    const th = pack.manifest.war?.dissolveThreshold ?? 22;
    const d = s.dissolve || 0;
    const tier = d >= th ? '大军像化雪，一夜瘦一圈'
      : d >= th * 0.5 ? '夜里有人成队地走散'
        : d >= th * 0.25 ? '握矛的手松了些' : '握矛的手很稳';
    out.push({ sev: 0, key: 'dissolve', text: `北边的军心：${tier}。` });
  }
  if (s.franko) out.push({ sev: 0, key: 'franko', text: '鲁舟的船靠在渡口边。' });
  // 或然亲和的暗提示（二周目起）：读过城的人记得哪里有纸——不指路，只提醒城有夹层
  if (s.echoBoon && s.day >= 24 && (s.docsSeen || []).length < 3) {
    out.push({ sev: 0, text: '你记得这座城的墙里有夹层——有些纸，上一局没来得及翻出来。' });
  }
  // 知晓度里程碑（体验9）：读城的过程要被城看见——一次性、低声（同档不重提）
  for (const m of KNOW_MILESTONES) {
    if (s.knowledge >= m.k && !(s.knowledgeShown || []).includes(m.k)) {
      out.push({ sev: 0, text: m.text });
    }
  }
  if (s.war?.telegraphed) chronic('war_soon', 0, '炮声稀了——懂行的人说，可能快了。');
  // 线的状态行（回响节拍器）：长线常驻一行——游戏替玩家记住，扫一眼就通电
  out.push(...threadsStateLines(s, pack));
  return out.sort((a, b) => b.sev - a.sev);
}

/** 戏剧弧破晓钩子（C/E·中盘戏剧）：危机头卡（有名字的坎，条件触发一次）与
 *  心事保底（名册每人的心结首拍，D12 起随机池没接住就由内核兜底）。
 *  一晨至多一张：正史停问 > 随机晨抽 > 危机 > 心事。EVENT_FIRED 入账可回放。 */
export function tickDrama(ctx) {
  const s = ctx.s;
  if (s.sidestory || s.over || s.activeEvent) return;
  const fireCard = (id) => {
    const card = ctx.pack.cardMap[id];
    if (!card) return false;
    s.firedOnce[id] = true;
    ctx.emit('FLAG', { key: 'firedOnce', val: structuredClone(s.firedOnce) });
    s.activeEvent = { cardId: id };
    ctx.emit('EVENT_FIRED', { cardId: id });
    ctx.fact('event', { cardId: id, title: card.title });
    return true;
  };
  // —— E 危机弧：冬柴告急 / 断粮算术 / 疫病进门（一局各一次）——
  const fuel = (s.inventory.firewood || 0) + (s.inventory.fuel || 0);
  const food = ['meal', 'canned', 'raw', 'meat', 'veg'].reduce((a, i) => a + (s.inventory[i] || 0), 0);
  const sickN = aliveChars(s).filter((c) => c.sick >= 1).length;
  if (s.winterActive && fuel <= 4 && !s.firedOnce['c_fuel'] && (s.facilities.heater || s.facilities.heater_iron)) {
    if (fireCard('c_fuel')) return;
  }
  if (s.day >= 5 && food <= 2 && aliveChars(s).length >= 2 && !s.firedOnce['c_famine']) {
    if (fireCard('c_famine')) return;
  }
  if (sickN >= 2 && !s.firedOnce['c_plague']) {
    if (fireCard('c_plague')) return;
  }
  // —— C 心事线：名册每人一张心结首拍，保底显形 ——
  if (s.day >= 12) {
    const pending = aliveChars(s)
      .map((c) => ctx.pack.charMap[c.id]?.persona?.knotCard)
      .filter((id) => id && ctx.pack.cardMap[id] && !s.firedOnce[id]);
    if (pending.length) fireCard(pending[0]);
  }
}

/** 浮卡的关系面（群像批次）：同册旧识双向点名 + 信任弧档词 */
export function relationsOf(state, pack, id) {
  const s = state;
  const out = [];
  for (const rel of pack.relations || []) {
    if (rel.a !== id && rel.b !== id) continue;
    const other = rel.a === id ? rel.b : rel.a;
    if (!s.chars.some((c) => c.id === other && c.alive)) continue;
    const arc = s.causality?.pairArcs?.[`${id}|${other}`] || s.causality?.pairArcs?.[`${other}|${id}`];
    const pos = arc?.pos || 0, neg = arc?.neg || 0;
    const arcWord = pos >= 3 ? '过命的交情' : pos >= 1 ? '信得过' : neg >= 1 ? '心里有根刺' : '旧识';
    out.push({ id: other, name: pack.charMap?.[other]?.name || other, label: rel.label, arcWord });
  }
  return out;
}

/** 人物页的「他最近惦记什么」（D·戏剧弧）：心结一句 + 最近一笔私账——
 *  内核已有的人格卡与因果账，给玩家一个随时可查的显形面 */
export function charCare(state, pack, id) {
  const knot = pack.charMap?.[id]?.persona?.knot || null;
  const ledger = state.causality?.charArcs?.[id]?.privateLedger || [];
  const last = ledger.length ? ledger[ledger.length - 1] : null;
  return { knot, last: last?.note ? String(last.note) : null };
}

/** 破晓时更新晨报衰减账与知晓度里程碑账（toDawn 管线调用；FLAG 镜像可回放） */export function tickDawnLedgers(ctx) {
  const s = ctx.s;
  const today = new Set(dawnProblems(s, ctx.pack).map((p) => p.key).filter(Boolean));
  const next = {};
  for (const k of new Set([...Object.keys(s.problemStreak || {}), ...today])) {
    if (today.has(k)) next[k] = (s.problemStreak?.[k] || 0) + 1;
  }
  const shown = [...new Set([...(s.knowledgeShown || []), ...KNOW_MILESTONES.filter((m) => s.knowledge >= m.k).map((m) => m.k)])];
  if (JSON.stringify(next) !== JSON.stringify(s.problemStreak || {}) || shown.length !== (s.knowledgeShown || []).length) {
    s.problemStreak = next; s.knowledgeShown = shown;
    ctx.emit('FLAG', { key: 'problemStreak', val: structuredClone(next) });
    ctx.emit('FLAG', { key: 'knowledgeShown', val: [...shown] });
  }
}

/** 夜访卡的「家里」一行（P0 夜之家政）：外出者之外的守卫与安睡者点名——
 *  夜是三口人的夜，卡面不该只有一个人 */
export function nightHomeView(state) {
  const s = state;
  const alive = s.chars.filter((c) => c.alive);
  const outId = s.night && !s.night.home ? s.night.charId : null;
  const guard = alive.find((c) => c.guardTonight && c.id !== outId) || null;
  const asleep = alive.filter((c) => c.id !== outId && (!guard || c.id !== guard.id)).map((c) => c.name);
  return { guard: guard ? guard.name : null, asleep };
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
  // A-3 协防之夜：白天答应替邻居守门，卡面说好的「今夜不可外出」要兑现——
  // 方案卡只给守家（不然玩家点出门又吃一次拒绝，承诺变成陷阱）
  const guardOfSafe = (excludeId) => {
    const rest = alive.filter((c) => c.id !== excludeId && c.wound < 3 && c.sick < 3);
    rest.sort((a, b) => ((b.combat || 0) - (a.combat || 0)) || (b.apMax - a.apMax));
    return rest[0] || null;
  };
  if (s.assistTonight) {
    const guard = guardOfSafe(null);
    const others = {};
    for (const c of alive) others[c.id] = (guard && c.id === guard.id) ? 'guard' : 'sleep';
    return {
      plans: [{
        key: 'stay', label: `替邻居守夜${guard ? `，${guard.name}看门` : ''}`,
        hint: '答应过替邻居守门——今晚家里出不了人，活路少一夜',
        intent: { type: 'dusk_assign', scavenger: null, location: null, gear: [], others }
      }]
    };
  }
  const known = (s.knownLocs || []).filter((l) => l !== 'home' && pack.locMap[l]);

  // 外出候选：危重出不了门（startNight 会拒），排序 = 心态可出门 > 背包 > 战斗。
  // 抑郁者 50% 拒绝出门（startNight 掷骰）——方案卡不预检心情就等于让玩家点哑炮
  const lowMind = (c) => ['depressed', 'breakdown'].includes(moodLevel(c.moodPts).key);
  const fit = alive.filter((c) => c.wound < 3 && c.sick < 3)
    .sort((a, b) => (Number(lowMind(a)) - Number(lowMind(b))) || (b.backpack - a.backpack) || ((b.combat || 0) - (a.combat || 0)));
  const scav = fit[0] || null;
  const guardOf = (excludeId) => {
    // 疲劳感知排班：力竭的人不该再值夜（F-05 落地后守夜代价更清楚——连值会熬垮人）
    const rest = alive.filter((c) => c.id !== excludeId);
    rest.sort((a, b) => (a.fatigue - b.fatigue) || ((b.combat || 0) - (a.combat || 0)) || (b.apMax - a.apMax));
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
  // —— 念头提级（v3 命运导演）：活念头点名的地方/家什，方案卡照着走 ——
  // 世界记着玩家种下的方向（direction），管家也要记着：晨报挂着「种下的念头」，
  // 黄昏就该有一条照着它走的路——否则念头只剩每三天一声回声（实测 8 天零消费）
  const aliveDirs = Object.values(s.directions || {}).filter((d) => d.alive);
  // 玩家说地方用短名（南市/医棚/宅区），与直读解析器同一张别名表——念头的措辞就是玩家的话。
  // 一句话可能点名两处（「去大族宅区……天黑前回府库里社」）：取最早提及的那个当目的地
  const locMentioned = (text) => {
    let best = null, bestAt = Infinity;
    for (const [alias, id] of Object.entries(LOC_ALIAS)) {
      if (id === 'home' || !known.includes(id)) continue;
      const at = Math.min(...[text.indexOf(alias), text.indexOf(pack.locMap[id].name)].filter((i) => i >= 0));
      if (at >= 0 && at < bestAt) { best = id; bestAt = at; }
    }
    return best;
  };
  const dirHit = aliveDirs.find((d) => locMentioned(d.text)) || null;
  const dirLoc = dirHit ? locMentioned(dirHit.text) : null;
  const NIGHT_TOOLS = ['lockpick', 'crowbar', 'shovel', 'saw', 'axe', 'knife'];
  const dirGear = aliveDirs
    .flatMap((d) => NIGHT_TOOLS.filter((id) => d.text.includes(pack.itemMap[id]?.name || '\u0000')))
    .filter((id) => has(s, id));
  const mkPlan = (key, scavId, locId) => {
    const gear = gearOf(locId);
    if (dirLoc === locId) for (const g of dirGear) if (!gear.includes(g)) gear.push(g); // 照念头带家什
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
    const dirNote = dirLoc === locId && dirHit ? `惦记着念头「${dirHit.text.slice(0, 14)}」；` : '';
    return { key, label: lines.join('，'), hint: `${dirNote}${LOC_BLURB[locId] || ''}${mindWarn}`, intent: { type: 'dusk_assign', scavenger: scavId, location: locId, gear, others } };
  };

  const plans = [];
  if (scav && known.length) {
    const ranked = LOC_RANK.filter((l) => known.includes(l));
    if (dirLoc) { // 念头点名的地方排第一（不在常规排序里也照排——念头优先于habit）
      const i = ranked.indexOf(dirLoc);
      if (i >= 0) ranked.splice(i, 1);
      ranked.unshift(dirLoc);
    }
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
  // 想买什么：按"救命程度"动态排序——商人是物资匮乏时的救命机会（全自动，玩家零决策）：
  // 断粮 > 无药（有伤病例）> 冬季断柴 > 常规补粮 > 建材缺口
  const foodTotal = ['meal', 'canned', 'raw', 'meat'].reduce((a, i) => a + (s.inventory[i] || 0), 0);
  const famine = foodTotal <= 2;
  const sickNeed = aliveChars(s).some((c) => c.wound >= 1 || c.sick >= 1);
  const prio = (item) => {
    if ((item === 'canned' || item === 'raw') && famine) return 0;
    if ((item === 'bandage' || item === 'meds') && sickNeed) return 1;
    if (item === 'firewood' && s.winterActive && (s.inventory.firewood || 0) < 2) return 1;
    if (item === 'bandage' || item === 'meds') return 2;
    if (item === 'canned' || item === 'raw') return 2;
    if (item === 'firewood') return 3;
    return 4; // 木板/杂件：建材缺口（无斧之家商路是唯一来路）
  };
  const want = [
    { item: 'bandage', when: () => !has(s, 'bandage') },
    { item: 'meds', when: () => !has(s, 'meds') },
    { item: 'canned', when: () => foodTotal < 4 },
    { item: 'raw', when: () => foodTotal < 4 },
    { item: 'firewood', when: () => (s.inventory.firewood || 0) < 3 },
    { item: 'wood', when: () => (s.inventory.wood || 0) < 4 && !has(s, 'axe') },
    { item: 'parts', when: () => (s.inventory.parts || 0) < 4 }
  ].sort((a, b) => prio(a.item) - prio(b.item));
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
    // 宏观节奏（一次选择走完今天）：白天建议全部收卷——单效诉求（省粮/听更）也并入当天方略。
    // 商人零交互（产品意见）：到访成交全自动沉在水下（planDay），建议行不出商人入口
    const close = { type: 'auto_day' };
    if (!s.activeEvent) out.push({ label: '让他们自己张罗这一天', intents: [close] });
    const foodTotal = ['meal', 'canned', 'raw', 'meat'].reduce((a, i) => a + (s.inventory[i] || 0), 0);
    // 开饭一键（体验6，二周目实测：挨饿的日子逐人喂饭把清晨打碎——43 次"让X吃点东西"）
    if (foodTotal > 0) {
      const est = { meal: s.inventory.meal || 0, canned: s.inventory.canned || 0, raw: s.inventory.raw || 0, meat: s.inventory.meat || 0 };
      const eats = [];
      for (const c of aliveChars(s)) {
        if (c.hunger > 2) continue; // 饥饿及以下才喂
        const item = est.meal > 0 ? 'meal' : est.canned > 0 ? 'canned' : est.raw > 0 ? 'raw' : est.meat > 0 ? 'meat' : null;
        if (!item) break;
        est[item] -= 1;
        eats.push({ type: 'act', actor: c.id, action: 'eat', target: item });
      }
      if (eats.length) out.push({ label: '让挨饿的都吃上，今天交给他们', intents: [...eats, close] });
    }
    if (foodTotal <= 3 && foodTotal > 0) out.push({ label: '省着吃，今天交给他们', intents: [{ type: 'policy', key: 'rationing', value: true }, close] });
    if (policyOf(s).rationing && foodTotal > 3) out.push({ label: '恢复正常吃饭，今天交给他们', intents: [{ type: 'policy', key: 'rationing', value: false }, close] });
    if (s.facilities.radio) {
      const hearer = aliveChars(s).find((c) => c.ap > 0 && !c.bedRest);
      if (hearer) out.push({ label: '听听更鼓，其余交给他们', intents: [{ type: 'act', actor: hearer.id, action: 'listen_radio' }, close] });
    }
    {
      const healer = aliveChars(s).find((c) => c.traits?.healer);
      const broken = aliveChars(s).find((c) => c.breakdown);
      if (healer && broken && (s.inventory.herb || 0) > 0 && (s.inventory.water || 0) > 0) {
        out.push({ label: `让${healer.name}给${broken.name}熬碗宽心汤`, intents: [{ type: 'act', actor: healer.id, action: 'comfort_soup', patient: broken.id }] });
      }
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
