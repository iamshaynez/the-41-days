// 谋士选项的验证器（统一交互面）：LLM 出的选项必须「点得动」——
// 形状（意图白名单）→ 可行性（feasibleIntent 只读检查）→ 禁词（正典防火墙），
// 三关全过才许渲染。纯视图数据：不碰 state、不进事件流，点了才走输入管线。
import { validateIntentShape, feasibleIntent } from '../core/index.js';

/**
 * @param {object} raw 谋士输出 {options: [{label, hint?, intents}]}
 * @returns {Array<{label, hint, intents}>} 过滤后的可渲染选项（至多 3 个）
 */
export function validateOptions(pack, state, raw) {
  const out = [];
  if (!raw || !Array.isArray(raw.options)) return out;
  const banned = pack.ge?.bannedTerms || [];
  for (const o of raw.options) {
    if (typeof o?.label !== 'string' || !o.label.trim() || o.label.length > 24) continue;
    if (banned.some((b) => o.label.includes(b))) continue;
    const intents = (Array.isArray(o.intents) ? o.intents : [])
      .filter((it) => validateIntentShape(it) && feasibleIntent(state, pack, it))
      .slice(0, 3);
    if (!intents.length) continue;
    out.push({
      label: o.label.trim().slice(0, 24),
      hint: typeof o.hint === 'string' ? o.hint.trim().slice(0, 30) : '',
      intents
    });
    if (out.length >= 3) break;
  }
  return out;
}

/** id 对照表：世界简报里人物/地点带 id，但物品只有中文名——
 *  没有这张表，模型写出的意图全过不了可行性门（教训：全被静默过滤）。 */
export function idTable(state, pack) {
  const chars = state.chars.filter((c) => c.alive).map((c) => `${c.name}=${c.id}`).join('、');
  const locs = (state.knownLocs || []).filter((l) => pack.locMap[l]).map((l) => `${pack.locMap[l].name}=${l}`).join('、');
  const items = Object.entries(state.inventory || {}).filter(([, n]) => n > 0).slice(0, 14)
    .map(([id]) => `${pack.itemMap[id]?.name || id}=${id}`).join('、');
  const stock = state.franko
    ? `商人货架（只有这些可买）：${state.franko.stock.filter((x) => x.n > 0).map((x) => `${x.item}×${x.n}`).join('、')}`
    : '';
  return `【id 对照——意图里只准写等号右边的 id】\n角色：${chars}\n地点：${locs}\n物品：${items}${stock ? `\n${stock}` : ''}`;
}

/** 卡面语境摘要（提示词 {{card}} 段）：给谋士看的当前卡状态（附 id 对照） */
export function cardBrief(state, pack, card) {
  const ids = idTable(state, pack);
  if (card === 'dusk') {
    const known = (state.knownLocs || []).filter((l) => l !== 'home' && pack.locMap[l]).map((l) => pack.locMap[l].name).join('、');
    return `黄昏，今晚怎么安排。走得动的人：${state.chars.filter((c) => c.alive).map((c) => `${c.name}(${c.id})`).join('、')}。已知地点：${known}。可以给外出者带装备。\n\n${ids}`;
  }
  if (card === 'night') {
    const loc = pack.locMap[state.night?.locId];
    return `深夜，夜访${loc?.name || ''}，当前房间「${loc?.rooms?.find((r) => r.id === state.night?.room)?.name || ''}」，剩余火柴 ${state.night?.slots} 根${state.night?.noise ? `，声响 ${state.night.noise}` : ''}。夜间动作：move/observe/search/open/clear/bars/dialogue/attack/retreat。\n\n${ids}`;
  }
  // day：今日卡
  return `白天，今日怎么过。日常由管家自动张罗（auto_day）；也可以安排具体的人做具体的事（act），或立规矩/种念头（policy/direction）。\n\n${ids}`;
}
