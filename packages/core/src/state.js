// 对局状态构造与派生量（内核设计 §2 六轴、§4/§5 防御与家产）。
import { Rng, clamp } from './rng.js';

export const MOOD_LEVELS = [
  { max: -14, key: 'breakdown', name: '崩溃' },
  { max: -9, key: 'depressed', name: '抑郁' },
  { max: -4, key: 'low', name: '低落' },
  { max: 3, key: 'calm', name: '平静' },
  { max: Infinity, key: 'firm', name: '坚定' }
];
export function moodLevel(pts) {
  return MOOD_LEVELS.find((l) => pts <= l.max);
}
export const HUNGER_NAMES = ['濒死', '严重饥饿', '饥饿', '正常', '饱足'];
export const HARM_NAMES = ['无', '轻伤', '重伤', '危重'];
export const SICK_NAMES = ['无', '微恙', '重病', '危重'];
export const FATIGUE_NAMES = ['正常', '疲惫', '力竭'];

/** 日常委托策略（内核设计 §5.3 Z 系，v2 落地）：玩家说"省着吃"即改这里。
 *  旧存档没有 policy 字段——读取一律走 policyOf 兜底。 */
export const DEFAULT_POLICY = {
  feeding: 'auto',        // auto=管家按饥饿自动喂食 / manual=玩家自己喂
  rationing: false,       // true=省粮（只喂饥饿线以下，熟食往后排）
  nightApproach: 'normal' // cautious=夜里不碰有声的锁 / bold=见锁就撬
};
export function policyOf(state) {
  return { ...DEFAULT_POLICY, ...(state.policy || {}) };
}

export function newChar(base) {
  return {
    ...base,
    ethics: { ...base.ethics },
    hunger: 3, wound: 0, sick: 0, moodPts: 2, fatigue: 0, cold: false,
    ap: 0, apMax: 3, alive: true,
    bedRest: false, guardTonight: false, awakeTonight: false,
    woundTreatedDay: -1, sickTreatedDay: -1, sickTreatedHerb: false,
    woundRestDays: 0, sickRestDays: 0, woundUntreatedDays: 0, sickUntreatedDays: 0,
    moodCounts: {}, breakdown: null, soothed: 0, addictionServedDay: -1,
    readToday: false
  };
}

/** 开局（GDD §4.2 组合规则：3 人，首局保底一名正典钥匙角色） */
export function createRun(pack, { seed = 1, difficulty = 'documentary', roster, firstRun = true, prologue = false, preludeMode = 'full', echoes = null, sidestory = null } = {}) {
  const rng = new Rng(seed);
  const sideDef = sidestory ? pack.sideMap?.[sidestory] : null;
  let ids = sideDef ? sideDef.roster : roster;
  if (!ids) {
    const pool = [...pack.characters];
    // 洗牌
    for (let i = pool.length - 1; i > 0; i--) { const j = rng.int(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    ids = pool.slice(0, 3).map((c) => c.id);
    if (firstRun && !ids.some((id) => pack.charMap[id].canonKey)) ids[2] = 'katya';
    if (roster === null) { /* 显式 null = 不随机 */ }
  }
  const chars = ids.map((id) => newChar(pack.charMap[id]));
  for (const c of chars) c.ap = apMaxOf(c); // D1 白天 AP（后续每日由 advanceDay 刷新）

  const war = pack.manifest.war;
  const endDay = rng.range(war.endWindow[0], war.endWindow[1]);
  const winter = pack.manifest.winter;
  const winterStart = rng.range(winter.startWindow[0], winter.startWindow[1]);
  const winterEnd = winterStart + rng.range(winter.duration[0], winter.duration[1]);

  const inv = {};
  for (const [k, v] of Object.entries(pack.manifest.startInventory)) inv[k] = v;

  const st = {
    v: 1, seed, difficulty, day: 1, phase: prologue ? 'prologue' : 'day', rngCursor: rng.cursor,
    // 序章三幕（叙事双轴-v0.1 §2）：preludeMode 由 server 按账号历史定（首局 full，二周目 short）
    preludeMode: prologue ? preludeMode : null,
    prelude: prologue ? { i: 0 } : null,
    // 大事轴日志（§4：fold 由 MAINLINE_STEP 镜像；mainlinePens 记闲笔已出之人）
    mainline: [], mainlinePens: [],
    weather: 'clear', winterActive: false, winterStart, winterEnd,
    war: { endDay, telegraphed: false, ended: false, endingType: null },
    chars, inventory: inv,
    facilities: { bed: 0, bed_good: 0, stove: 0, stove_eco: 0, stoveFireLeft: 0, heater: 0, heater_iron: 0, workbench: 0, workbench2: 0, workbench3: 0, metal: 0, rain: 0, rain_filter: 0, trap: 0, trapBaited: false, trapDay: -9, garden: 0, garden_veg: 0, gardenStarted: -9, distill: 0, distillReady: -9, radio: 0, piano: 0 },
    doorLevel: 0, homeFurniture: 6,
    house: { opened: { hall: true, living: true, kitchen: true }, searched: {}, hiddenFound: {} },
    knownLocs: [...pack.manifest.startKnowledgeLocations, ...(ids.includes('alexey') ? ['beacon'] : [])], // 逄灶开局识北津台
    locState: {},
    night: null, lastScavenger: null,
    // v0.3 同步日历：军心溶解账（家访配合/家书报平安为正；如实与沉默为负或零）。
    // D41 铰链读它：溶解超阈值 → 大军散尽 → 刀落（正史）；握有杠杆且未超 → 刀偏（或然）
    dissolve: 0, deathDays: {},
    franko: null, frankoNextDay: pack.manifest.franko.firstVisitDay,
    activeEvent: null, eventCooldowns: {}, firedOnce: {}, cardCount: {},
    // 跨周目回响（长线体验 EC）：鲁舟认出你 / 时间胶囊 / 在办遗愿
    echoes: echoes ? { frankoGreeted: false, ...echoes } : null,
    closureClosed: !!echoes?.closureClosed, // 合上兰台后：世界降密度（§3.6 守望档）
    capsuleFound: {},
    geFingers: {}, geShown: 0, geLastDay: 0, geCards: {},
    eventFlags: echoes?.wish ? { wish_active: true } : {},
    reputation: { neighbor: 0, church: 0, hospital: 0, market: 0 }, notoriety: 0,
    knowledge: (echoes?.boon || 0) * 2, // 读过这座城：档案馆的记忆折成知晓度底子
    echoBoon: echoes?.boon || 0, docsSeen: [],
    deeds: [], threeThings: [],
    causality: { entries: [], pairArcs: {}, charArcs: {}, shadowTouched: {} },
    ensemble: { scenes: [], coveredSteps: [], pairLast: {} },
    seals: [],
    policy: { ...DEFAULT_POLICY },
    // 念头（v3 命运导演）：玩家种下的方向性意图——登记经 FLAG 回放，显形走自主回声/锚池/叙事
    directions: {},
    // 素材环：玩家未被接住的话（离谱输入兜底）——世界听得见，两天后可能长出回应卡
    whispers: [],
    musicLastDay: -99, shovelReturnDay: 0, assistTonight: false, heatedTonight: false,
    rainCollected: 0, weatherForecast: null,
    // 二周目反馈批次二：晨报慢性问题连报账（衰减）/ 知晓度里程碑已提示档（卡出场账复用 cardCount）
    problemStreak: {}, knowledgeShown: [],
    report: [], over: false, ending: null,
    morningSeed: 0
  };
  // 别传局修饰（长线体验-v0.2 §3.4）：固定天数、定制开局、战争计时器改成别传长度
  if (sideDef) {
    st.sidestory = { id: sideDef.id, title: sideDef.title, intro: sideDef.intro };
    st.war.endDay = sideDef.days + 1; // 第 N+1 天破晓收束
    const su = sideDef.setup || {};
    if (su.inventory) Object.assign(st.inventory, su.inventory);
    if (su.knownLocs) st.knownLocs = [...new Set([...st.knownLocs, ...su.knownLocs])];
    if (su.winter) { st.winterActive = true; st.winterStart = 1; st.winterEnd = sideDef.days + 1; }
  }
  return st;
}

// —— 派生量 ——
export function bestWeapons(state, pack) {
  // 在库武器按战斗加成排序（守家者可取用）
  return pack.items.filter((i) => i.weapon && (state.inventory[i.id] || 0) > 0)
    .sort((a, b) => b.weapon - a.weapon);
}
export function homeValue(state, pack) {
  let v = 0;
  for (const [id, n] of Object.entries(state.inventory)) v += (pack.itemMap[id]?.value || 0) * n;
  return v;
}
export function aliveChars(state) { return state.chars.filter((c) => c.alive); }
export function charById(state, id) { return state.chars.find((c) => c.id === id && c.alive) || null; }

/** 白天 AP 上限（A 表 + 状态修正；PH-02 之后的当日刷新） */
export function apMaxOf(c) {
  let ap = 3;
  if (c.wound === 1 || c.sick === 1) ap = 2;
  if (c.wound >= 2 || c.sick >= 2) ap = 1;
  if (moodLevel(c.moodPts).key === 'depressed') ap -= 1;
  if (c.fatigue >= 2) ap = 1;
  if (c.wound >= 3 || c.sick >= 3) ap = c.bedRest ? 1 : 0;
  if (c.bedRest) ap = Math.min(ap, 1);
  return clamp(ap, 0, 3);
}
export function combatModOf(c) {
  let m = c.combat || 0;
  if (c.hunger <= 1) m -= 1;
  if (c.fatigue >= 1) m -= 1;
  if (c.wound >= 2) m -= 2; else if (c.wound === 1) m -= 0;
  if (c.sick >= 2) m -= 1;
  if (moodLevel(c.moodPts).key === 'depressed') m -= 1;
  return m;
}
export function difficultyCfg(pack, state) {
  return pack.manifest.difficulty[state.difficulty] || pack.manifest.difficulty.documentary;
}
