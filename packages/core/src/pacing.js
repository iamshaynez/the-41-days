// 节拍层（长线体验-v0.2 §4.4 概述日 + §4.1 快局）：
// 41 天的均匀节拍是白开水——平淡日由内核裁决收卷，只留一笔给叙事者；
// 玩家随时可用规矩关掉（policy.overviewDays）。纯函数 + 内容数值，零随机。
import { policyOf, aliveChars, apMaxOf } from './state.js';
import { dawnProblems } from './delegate.js';

/** 概述日会被吞掉的例行流水 fact（做饭吃饭修修补补）——大事（文档/封印/死亡）永不吞 */
export const ROUTINE_DAY_FACTS = new Set([
  'auto_day_start', 'eat', 'cook', 'craft', 'build', 'build_door', 'treat', 'talk',
  'read', 'guard', 'rest', 'nap', 'chop', 'repair', 'comfort_soup', 'play_piano',
  'search_hit', 'search_miss', 'radio_news', 'radio_weather', 'radio_music', 'radio_missing', 'radio_static',
  'no_ap', 'no_food', 'no_fuel', 'no_material', 'no_tool', 'no_item', 'no_med', 'no_furniture',
  'need_facility', 'nothing_to_search', 'waste_warning', 'trade_done', 'trade_reject', 'trade_no_stock',
  'franko_left', 'container_refilled', 'weak_scavenge', 'policy_set', 'dissolve_shift'
]);

/** 当日的幕（内容即数据：mainline.acts 的 days 区间） */
export function actOfDay(mainline, day) {
  const acts = (mainline?.acts || []).filter((a) => day >= a.days[0] && day <= a.days[1]);
  return acts.length ? acts[acts.length - 1] : null;
}

/** 概述阈值（内容即数据：mainline.pacing.actQuietStreak[actId]）——
 *  连平 N 日才开始概述；99 = 这一幕永字不收（末路五日每天都是整页） */
export function overviewThreshold(pack, actId) {
  return (pack?.mainline?.pacing?.actQuietStreak || {})[actId] ?? 1;
}

/** 今天破晓是否安静（无急件/无大事步/无堂屋/无火警）。纯读，不改状态。 */
export function dayIsQuiet(ctx) {
  const s = ctx.s;
  if (s.sidestory || s.over) return false; // 别传局天数短，页页都值钱
  if (policyOf(s).overviewDays === false) return false; // 玩家立过规矩：平淡也要逐件细看
  if (s.activeEvent) return false;                       // 门口有事，先应门
  if ((s.mainline || []).some((e) => e.day === s.day && e.stepId)) return false; // 史与家同页
  const alarms = dawnProblems(s, ctx.pack).filter((p) => (p.sev || 0) >= 2);     // 火警：断粮/饿慌/病危/崩溃
  return alarms.length === 0;
}

/** 概述裁决（toDawn 末步调用）：更新连平静默账（FLAG 镜像可回放），返回是否收卷。
 *  确定性：只读状态与内容数值，零骰。 */
export function overviewDecision(ctx) {
  const s = ctx.s;
  const quiet = dayIsQuiet(ctx);
  const streak = quiet ? (s.quietStreak || 0) + 1 : 0;
  if ((s.quietStreak || 0) !== streak) ctx.setFlag('quietStreak', streak);
  const act = actOfDay(ctx.pack?.mainline, s.day);
  return { quiet, streak, fire: quiet && streak >= overviewThreshold(ctx.pack, act?.id) };
}

/** 概述日的管家digest：从被吞的例行流水里攒一句家常（谁吃了饭、家里添了什么） */
export function digestOfDayFacts(swallowed, pack, state) {
  const name = (id) => state.chars.find((c) => c.id === id)?.name || pack.charMap?.[id]?.name || id;
  const ate = [];
  let built = null, searched = false;
  for (const f of swallowed) {
    if (f.k === 'eat') ate.push(name(f.char));
    else if (f.k === 'build' && !built) built = pack.facilityMap?.[f.target]?.name || f.target;
    else if (f.k === 'build_door') built = `第${f.level}层门板`;
    else if (f.k === 'craft' && !built) built = pack.itemMap?.[f.out || f.target]?.name || null;
    else if (f.k === 'search_hit' || f.k === 'search_miss') searched = true;
  }
  return { ate: [...new Set(ate)], built, searched };
}

/* ════════════════════════ 快局：D21 中盘切片（长线体验 §4.1） ════════════════════════
   预设家底住在内容包 quickstart.json——「认真玩了二十天」的样子：
   炉灶与工作台立了、门加了板、见识过半座城、人是中盘的疲惫而不是开局的白板。
   只补家底不烧卡：D21 之前窗口的时间轴卡按窗口规则自然沉默，不须 firedOnce 预烧。 */
export function applyQuickStart(state, pack) {
  const qs = pack?.quickstart;
  if (!qs) return state;
  const s = state;
  s.day = qs.day;
  s.phase = 'day';
  s.quickRun = true;
  s.prelude = null; s.preludeMode = null;
  if (qs.inventory) s.inventory = { ...s.inventory, ...qs.inventory };
  if (qs.facilities) s.facilities = { ...s.facilities, ...qs.facilities };
  if (qs.doorLevel !== undefined) s.doorLevel = qs.doorLevel;
  if (qs.homeFurniture !== undefined) s.homeFurniture = qs.homeFurniture;
  if (qs.knownLocs) s.knownLocs = [...new Set([...s.knownLocs, ...qs.knownLocs])];
  if (qs.searchedHome) {
    for (const room of pack.locMap.home.rooms || []) {
      if (s.house.opened[room.id]) for (const ct of room.containers || []) s.house.searched[ct.id] = true;
    }
  }
  // 人：中盘的底子（饿过、也吃饱过），AP 按状态刷新
  for (const c of aliveChars(s)) {
    const preset = qs.chars?.[c.id] || qs.chars?.['*'] || {};
    if (preset.hunger !== undefined) c.hunger = preset.hunger;
    if (preset.moodPts !== undefined) c.moodPts = preset.moodPts;
    if (preset.wound !== undefined) c.wound = preset.wound;
    if (preset.sick !== undefined) c.sick = preset.sick;
    c.ap = apMaxOf(c);
  }
  // 冬窗若已开，就照冬天的规矩开（冬窗随机在 D7-20，切片可能落在冬里）
  if (s.winterStart <= s.day) s.winterActive = true;
  return s;
}
