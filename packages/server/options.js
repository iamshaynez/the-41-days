// 谋士选项的验证器（统一交互面）：LLM 出的选项必须「点得动」——
// 形状（意图白名单）→ 可行性（feasibleIntent 只读检查）→ 禁词（正典防火墙），
// 三关全过才许渲染。纯视图数据：不碰 state、不进事件流，点了才走输入管线。
import { validateIntentShape, feasibleIntent, normalizeIntent, nightHomeView, locNeedProfile } from '../core/index.js';

/** 防御性截断：在标点处收尾（不放残句——线上教训：「派一个人对折他，」） */
const cutClean = (text, max) => {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const m = cut.match(/^[^。！？；，、]*[。！？；]/);
  if (m && m[0].length >= Math.min(8, max - 4)) return m[0]; // 附近有完整句，收在句号
  const cm = cut.slice(0, max - 1).match(/.*[，、；]/);
  if (cm) return cm[0] + '……'; // 只有分句点，收在分句并留省略
  return cut + '……';
};

/**
 * @param {object} raw 谋士输出 {options: [{label, hint?, intents}]}
 * @param {object} [opts] {card} —— card='day' 时每个选项是闭环方略：
 *   尾部自动补 auto_day（管家补完日常并进入黄昏），点一个选项即收卷这一天。
 * @returns {Array<{label, hint, intents}>} 过滤后的可渲染选项（至多 3 个）
 */
export function validateOptions(pack, state, raw, { card } = {}) {
  const out = [];
  if (!raw || !Array.isArray(raw.options)) return out;
  const banned = pack.ge?.bannedTerms || [];
  for (const o of raw.options) {
    if (typeof o?.label !== 'string' || !o.label.trim() || o.label.length > 80) continue; // 长想法截断收尾，不丢弃
    if (banned.some((b) => o.label.includes(b))) continue;
    // 收卷意图（auto_day）是白天方略的专属结尾：模型自带的一律收走，
    // 只有今日卡由我们统一补在最后（黄昏/夜访是世界的提问，不越权收卷）
    let intents = (Array.isArray(o.intents) ? o.intents : [])
      .filter((it) => it.type !== 'auto_day' && it.type !== 'scene')
      .map((it) => normalizeIntent(state, pack, it)) // 宽进：中文名翻成 id 再验
      .filter((it) => validateIntentShape(it) && feasibleIntent(state, pack, it)); // 严出：验证照旧
    // 夜卡的选项必须真能应答夜间（方针/夜动作/续跑）——其余是「点得动、点不动夜」的陷阱：
    // 夜停在岔路上等的是答案，scene/direction 都清不掉 atFork，夜永不收尾（实测死循环）
    if (card === 'night' && !intents.some((it) => ['night_directive', 'night', 'auto_night'].includes(it.type))) continue;
    // 黄昏同理（实测死循环：「守誓/改约」类纯 direction 选项三关全过、点得动，
    // 但浇完水 phase 还在 dusk——夜不开始，黄昏卡原样回来，史官照选项回声演出登台戏文）
    if (card === 'dusk' && !intents.some((it) => it.type === 'dusk_assign')) continue;
    // 危机过滤（实测：人都要死了，选项里没人着急找吃的）：断粮 ≤2 顿时——
    // 黄昏只留「去富粮地」的派工（留守/零粮地/纯念头全砍）；白天不出纯念头类
    const mouthsC = state.chars.filter((c) => c.alive).length || 1;
    const mealsC = Math.floor(['meal', 'canned', 'raw', 'meat', 'veg'].reduce((a, i) => a + (state.inventory[i] || 0), 0) / mouthsC);
    if (mealsC <= 2) {
      if (card === 'dusk') {
        const assign = intents.find((it) => it.type === 'dusk_assign');
        const prof = assign?.location ? locNeedProfile(pack, assign.location) : null;
        if (!assign || !prof || (prof.food || 0) < 0.3) continue;
      }
      if (card === 'day' && intents.every((it) => ['direction', 'policy', 'scene', 'auto_day'].includes(it.type))) continue;
    }
    if (!intents.length) {
      // 戏文轨只属于方略卡（day）：内核没有、但说得出口的事——不过滤，交给舞台导演当场接戏。
      // 提问卡（黄昏/夜访）不收非答案——点了卡原样回来，等于给玩家挖坑
      if (card !== 'day') continue;
      const text = cutClean(`${o.label.trim()}${o.hint ? '——' + String(o.hint).trim() : ''}`, 100);
      out.push({
        label: cutClean(o.label, 40),
        hint: (typeof o.hint === 'string' ? cutClean(o.hint, 40) + ' · ' : '') + '戏文：世界会接这一拍',
        intents: [{ type: 'scene', text }],
        stage: true
      });
      if (out.length >= 4) break;
      continue;
    }
    if (card === 'day') intents.push({ type: 'auto_day' });
    intents = intents.slice(0, 5);
    const hint = typeof o.hint === 'string' ? cutClean(o.hint, 50) : '';
    out.push({
      label: cutClean(o.label, 40),
      hint: card === 'day' ? (hint ? `${hint} · 安排完即入黄昏` : '安排完即入黄昏') : hint,
      intents
    });
    if (out.length >= 3) break;
  }
  return out;
}

/** id 对照表：世界简报里人物/地点带 id，但物品只有中文名——
 *  没有这张表，模型写出的意图全过不了可行性门（教训：全被静默过滤）。 */
export function idTable(state, pack, { night = false } = {}) {
  const chars = (night
    ? state.chars.filter((c) => c.alive && c.id === state.night?.charId) // 夜里只有外出者在这条路上
    : state.chars.filter((c) => c.alive)
  ).map((c) => `${c.name}=${c.id}`).join('、');
  const localNpcs = night
    ? ((pack.locMap[state.night?.locId]?.npcs || []).map((n) => `${n.name}=${n.id}`).join('、') || '无')
    : null;
  const locs = (state.knownLocs || []).filter((l) => pack.locMap[l]).map((l) => `${pack.locMap[l].name}=${l}`).join('、');
  const items = Object.entries(state.inventory || {}).filter(([, n]) => n > 0).slice(0, 14)
    .map(([id]) => `${pack.itemMap[id]?.name || id}=${id}`).join('、');
  const stock = state.franko
    ? `商人货架（只有这些可买）：${state.franko.stock.filter((x) => x.n > 0).map((x) => `${x.item}×${x.n}`).join('、')}`
    : '';
  return `【id 对照——意图里只准写等号右边的 id】\n角色：${chars}${localNpcs ? `\n此地遇到的人：${localNpcs}` : ''}\n地点：${locs}\n物品：${items}${stock ? `\n${stock}` : ''}`;
}

/** 现在真正能做的事（动态可行域）：**分工商簿**——按人列，各算各的。
 *  旧版只按「第一个有行动力的人」算一张单人清单：做饭/治疗这类事在谁名下
 *  模型看不见，出的方略挤在一个人身上，也没有「让累的人歇着」这种安排。
 *  每人一行：名字（id，行动力，状态）；可行的事逐项现算；休息是常备项。 */
export function actionMenu(state, pack) {
  const s = state;
  const alive = s.chars.filter((c) => c.alive);
  const lines = [];
  for (const c of alive) {
    const tags = [];
    if (c.bedRest) tags.push('卧床中');
    if (c.fatigue >= 2) tags.push('力竭');
    else if (c.fatigue >= 1) tags.push('疲惫');
    if (c.wound >= 1) tags.push(c.wound >= 2 ? '重伤' : '带伤');
    if (c.sick >= 1) tags.push(c.sick >= 2 ? '重病' : '患病');
    const head = `${c.name}（${c.id}，行动力${c.ap}${tags.length ? '，' + tags.join('、') : ''}）`;
    if (c.ap <= 0 || c.bedRest) {
      lines.push(`${head}：今天做不了事——只能休整，或由别人来 talk 陪他说说话`);
      continue;
    }
    const F = (action, extra = {}) => feasibleIntent(s, pack, { type: 'act', actor: c.id, action, ...extra });
    const mates = alive.filter((x) => x.id !== c.id);
    const m = [];
    if (F('eat')) m.push('eat 吃饭');
    if (F('cook')) m.push('cook 做饭');
    const crafts = pack.recipes.filter((r) => F('craft', { target: r.id })).slice(0, 4).map((r) => r.id);
    if (crafts.length) m.push(`craft 制造（可做：${crafts.join('、')}）`);
    const builds = (pack.facilities ? Object.keys(pack.facilityMap) : []).filter((id) => F('build', { target: id })).slice(0, 4);
    if (builds.length) m.push(`build 建造（材料齐：${builds.join('、')}）`);
    if (F('treat', { target: 'bandage' })) m.push('treat 治疗（target=bandage，有伤员）');
    if (F('treat', { target: 'meds' }) || F('treat', { target: 'herbmed' })) m.push('treat 治疗（target=meds 或 herbmed，有病患）');
    if (F('comfort_soup')) m.push('comfort_soup 宽心汤（有人心绪很差）');
    if (mates.length) m.push(`talk 交谈（对象：${mates.map((x) => x.id).join('、')}）`);
    m.push('guard 守门 / sleep 补眠 / rest 卧床');
    if (F('listen_radio')) m.push('listen_radio 听更鼓');
    const leftovers = (pack.locMap.home.rooms || []).flatMap((r) => s.house.opened[r.id] ? (r.containers || []).filter((ct) => !s.house.searched[ct.id] && (ct.type !== 'locked' || s.house.searched[ct.id + ':open'])) : []);
    if (leftovers.length) m.push(`search_home 搜家（还有 ${leftovers.length} 处没翻，如 ${leftovers[0].id}）`);
    const rooms = (pack.locMap.home.rooms || []).filter((r) => !s.house.opened[r.id] && F('open_room', { target: r.id }));
    if (rooms.length) m.push(`open_room 开房（${rooms.map((r) => r.id).join('、')}）`);
    if (F('chop')) m.push('chop 劈家具');
    if (F('repair')) m.push('repair 修门');
    if (F('read')) m.push('read 读书');
    if (F('play_piano')) m.push('play_piano 抚琴');
    lines.push(`${head}：${m.join('；')}`);
  }
  return lines.join('\n');
}

/** 夜访可行域：当前房间的容器 id、可去的房间 id、在场 NPC id——
 *  夜间意图的 target 只认这些 id（中文名一律被滤，线上教训同白天） */
export function nightMenu(state, pack) {
  const n = state.night;
  if (!n || n.home) return '（不在夜访中）';
  const loc = pack.locMap[n.locId];
  if (!loc) return '（不在夜访中）';
  const st = state.locState[n.locId] || { searched: {}, npcState: {} };
  const idx = loc.rooms.findIndex((r) => r.id === n.room);
  const room = loc.rooms[idx];
  const home = nightHomeView(state);
  const lines = [`当前房间：${room.name}（${room.id}）`];
  if (home.guard || home.asleep.length) lines.push(`家里（不可干预，供措辞）：${home.guard ? `${home.guard}守门` : '没人守夜'}${home.asleep.length ? `，${home.asleep.join('、')}在睡` : ''}`);
  const conts = (room.containers || []).filter((c) => !st.searched[c.id]);
  if (conts.length) lines.push(`本屋可搜容器（search@id）：${conts.map((c) => `${c.id}${c.type === 'locked' ? '（上锁，先 open@' + c.id + '）' : ''}`).join('、')}`);
  const moves = [loc.rooms[idx - 1], loc.rooms[idx + 1]].filter(Boolean);
  if (moves.length) lines.push(`可去房间（move@id${moves.some((r) => r.door && r.door !== 'open') ? '，有的有门：locked 需 open@、rubble 需 clear@、bars 需 bars@' : ''}）：${moves.map((r) => `${r.name}(${r.id}${r.door && r.door !== 'open' ? ' 门:' + r.door : ''})`).join('、')}`);
  const npcs = (loc.npcs || []).filter((x) => !st.npcState[x.id]);
  if (npcs.length) lines.push(`在场的人（dialogue/attack@id）：${npcs.map((x) => `${x.name}(${x.id})`).join('、')}`);
  lines.push('无目标的动作：observe（看一圈）/ retreat（收工回家）');
  return lines.join('\n');
}

/** 卡面语境摘要（提示词 {{card}} 段）：给谋士看的当前卡状态（附 id 对照与可行域） */
const HIST_THEME_NAMES = { beacon: '北津台', letters: '家书', maicheng: '麦城', army: '军心' };
/** 已了结的史锚话头（回应卡本局已发过）——亮给谋士：别看历史重提，提了也是白提 */
function closedThemesLine(state) {
  const closed = Object.entries(HIST_THEME_NAMES).filter(([k]) => state.firedOnce?.['hs_' + k]).map(([, n]) => n);
  return closed.length ? `已了结的话头（这一局已经有人接过去了，不再有后续——无论上文提过多少次，别再出相关选项）：${closed.join('、')}。` : '';
}
export function cardBrief(state, pack, card) {
  const ids = idTable(state, pack);
  const closed = closedThemesLine(state);
  const menu = `\n\n【分工商簿——现在真正能做的事，按人一行行列；act 的 action/actor/target 从各人名下选，清单外的愿望用 direction】\n${actionMenu(state, pack)}`;
  if (card === 'dusk') {
    // 饥荒警报：断粮时谋士必须先为嘴——没有这行，选项一副不着急的样子（实测）
    const mouthsN = state.chars.filter((c) => c.alive).length || 1;
    const mealsN = Math.floor(['meal', 'canned', 'raw', 'meat', 'veg'].reduce((a, i) => a + (state.inventory[i] || 0), 0) / mouthsN);
    const famineLine = mealsN <= 2 ? `⚠ 断粮警报：全家只剩约 ${mealsN} 顿口粮——今晚出门的人必须优先去富粮的地方（地点名后已标产出）；留守是奢侈。` : '';
    // 地点标注搜空状态（实测：被反复派去已搜空的地点，扑空一夜还以为有收获）——
    // 搜空的地点等城里回补，谋士不该当正经去处反复推荐
    const pickedDry = (l) => {
      const loc = pack.locMap[l]; const st = state.locState?.[l];
      if (!loc || !st) return false;
      const conts = (loc.rooms || []).flatMap((r) => r.containers || []);
      return conts.length > 0 && conts.every((c) => st.searched[c.id] !== undefined);
    };
    const known = (state.knownLocs || []).filter((l) => l !== 'home' && pack.locMap[l])
      .map((l) => pack.locMap[l].name + (pickedDry(l) ? '（已搜空——重访才有回补：隔两天再走一趟，城里可能又有了）' : '')).join('、');
    return `黄昏，今晚怎么安排。走得动的人：${state.chars.filter((c) => c.alive).map((c) => `${c.name}(${c.id})`).join('、')}。已知地点：${known}。可以给外出者带装备。${famineLine}夜里出门只能一个人（围城规矩：人多目标大）——「大家都出去」做不到，选一个最合适的，其余在家守或睡。\n出的是**今晚派工**：每个选项的 intents 只需一个 {"type":"dusk_assign","scavenger":<谁去|在家为null>,"location":<去哪|留守为null>,"gear":[带什么],"others":{<其余人id>:"sleep"或"guard"}}。留守派工（scavenger=null）也是正经答案。有人立过誓且誓的地点在已知地点里，派他去该地就是践誓；黄昏不收 direction/policy——念头白天说，黄昏只派工。${closed}${menu}\n\n${ids}`;
  }
  if (card === 'night') {
    const loc = pack.locMap[state.night?.locId];
    const who = state.chars.find((c) => c.id === state.night?.charId && c.alive);
    const solo = who ? `今晚在外的只有 ${who.name}（${who.id}）一人——其余队友都在家里，不许出现在选项里。` : '';
    return `深夜，${who ? `${who.name}独行` : '有人独行'}，夜访${loc?.name || ''}，剩余火柴 ${state.night?.slots} 根${state.night?.noise ? `，声响 ${state.night.noise}（有人听见了）` : ''}。${solo}\n出的是**整夜方针**：一句话定方向（只拿吃的、见人绕行 / 探明虚实就回 / 放手干，值钱都拿走）。内核会按方针自己走完整夜——遇人绕不绕、锁撬不撬、手动不动，都由方针与骰子决定，不会逐件请示玩家。每个选项的 intents 只需一个：{"type":"night_directive","stance":"cautious|normal|bold","text":"方针原话"}。谨慎=不出声见人就撤；照常=看情况；放手=敢动手敢背刺。\n\n【这一夜的现场（供措辞用，不必落到具体目标）】\n${nightMenu(state, pack)}\n\n${idTable(state, pack, { night: true })}`;
  }
  // day：今日卡
  const openVows = Object.values(state.directions || {}).filter((d) => d.kind === 'vow' && d.alive).map((d) => `「${d.text.slice(0, 14)}」`).join('、');
  return `白天，今日怎么过。你出的是**今日方略**：2~4 个意图、覆盖至少两个人（act/direction/policy 可混编；direction 可立誓（点名地点的话会成为未践之誓，由黄昏方案兑现）或播史种（提到北津台/家书/麦城/军心的话日后长成停问卡））。白天没有「去某地」的机制——行程类选项（天黑前去某地／登某地／上某地）一律不出，点了也是空炮；想让人去哪，用 direction 立誓，黄昏派工会照着走。方略就是**分头安排**——下面这张分工商簿按人列了各自行得通的事，谁做饭、谁出力、谁陪谁说话，一人一行对着安排；力竭/带伤的人安排 sleep/rest 休整、让别人顶上，也是正经方略，别硬派活。不必覆盖每个人：剩下的生计管家会自动补完，方略执行完这一天就收卷入黄昏。全队休整的方略可以只有一两个意图。${openVows ? `这个家有未践的誓——黄昏的「践誓」方案会自动兑现；白天选项里不要出现立誓/守约/约定/未践之誓类选项（那是空转，浪费玩家的一拍）。` : ''}${closed}${menu}\n\n${ids}`;
}
