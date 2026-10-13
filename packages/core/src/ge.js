// C 层生成事件验证器（内核设计-v0.2 §8.8 GE-03~08 / GE-10）。
// 铁律：皮肤自由，效果只准从白名单点菜；校验不过即拒，拒了不重试原样提交。
import { hashStr } from './rng.js';

/** 提案指纹（GE-08 去重）：主题+对象+效果类型，7 天冷却 */
export function geFingerprint(p) {
  const effTypes = (p.options || [])
    .flatMap((o) => Object.keys(o).filter((k) => ['mood_all', 'mood_char', 'items_gain', 'item_cost', 'reputation', 'risk', 'flag'].includes(k)))
    .sort().join('+');
  return 'g' + hashStr(`${p.arc || ''}|${p.theme}|${p.title}|${effTypes}`);
}

/** 选项效果签名（文学性约束①：互质）——签名相同的两个选项 = 参数变体，不是立场 */
const effectSignature = (o) => {
  const keys = [];
  if (o.mood_all !== undefined) keys.push('moodAll');
  if (o.mood_char) keys.push(`mood:${o.mood_char.name}`);
  if (o.items_gain) keys.push(`gain:${Object.keys(o.items_gain).sort().join('+')}`);
  if (o.item_cost) keys.push(`cost:${Object.entries(o.item_cost).map(([k, n]) => `${k}${n}`).sort().join('+')}`);
  if (o.reputation) keys.push(`rep:${o.reputation.key}${o.reputation.n > 0 ? '+' : '-'}`);
  if (o.risk) keys.push('risk');
  if (o.flag) keys.push(`flag:${Object.keys(o.flag).sort().join('+')}`);
  return keys.sort().join('|') || 'none';
};

/** 提案规范化（GE-03 的宽容面）：LLM 常把物品 id 写成中文名（"水"而非 water）——
 *  中文名→id 就地归一；归一不了的原样保留，交给 validateProposal 以"未知物品"拒绝。
 *  纯函数：返回新对象，不改入参。 */
export function normalizeProposal(pack, p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.options)) return p;
  const byName = new Map((pack.items || []).map((i) => [i.name, i.id]));
  const normItems = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const [k, n] of Object.entries(obj)) out[pack.itemMap[k] ? k : (byName.get(k) || k)] = n;
    return out;
  };
  return {
    ...p,
    options: p.options.map((o) => (o && typeof o === 'object'
      ? { ...o, items_gain: normItems(o.items_gain), item_cost: normItems(o.item_cost) }
      : o))
  };
}

/** 校验提案。返回 {ok, reasons[]}。opts.arc：当前指派的命运弧（null = 普通微光卡） */
export function validateProposal(pack, state, p, { anchors, arc = null } = {}) {
  const g = pack.ge;
  const reasons = [];
  if (!p || typeof p !== 'object') return { ok: false, reasons: ['不是对象'] };
  // 形：标题/正文/2~4 个选项
  if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 20) reasons.push('标题缺失或过长');
  if (typeof p.text !== 'string' || p.text.trim().length < 20) reasons.push('正文太短');
  if (p.text && p.text.length > 400) reasons.push('正文过长');
  if (!Array.isArray(p.options) || p.options.length < 2 || p.options.length > 4) reasons.push('应对面须 2~4 个');
  // 主题轮盘
  if (p.theme && !g.themeWheel.includes(p.theme)) reasons.push(`主题出盘：${p.theme}`);
  // 弧 adherence（P2b）：指派了弧，提案必须长在这条弧上
  if (arc && p.arc !== arc.id) reasons.push(`弧不符：提案 ${p.arc || '（未声明）'} ≠ 指派 ${arc.id}`);
  // 锚定（GE-04）：≥2 个真实存在的锚
  const an = Array.isArray(p.anchors) ? p.anchors : [];
  if (anchors && an.filter((a) => anchors.includes(a)).length < 2) reasons.push('锚不足 2 个或不在当局的锚池里');
  // 防火墙（GE-10）：暗线词表 + 正史锚点，文本域逐字扫描
  const hay = [p.title, p.text, ...(p.options || []).map((o) => `${o.label} ${o.outcomeText || ''}`)].join(' ');
  for (const b of g.bannedTerms) if (hay.includes(b)) reasons.push(`正典/正史防火墙：${b}`);
  // 锚引用（文学性约束②：特指胜过泛化）——正文/选项至少出现一个锚池里的人名或地名
  if (anchors) {
    const refAnchors = anchors
      .filter((a) => /^(角色|地点):/.test(a))
      .map((a) => a.slice(3))
      .filter((v) => v.length >= 2);
    if (refAnchors.length && !refAnchors.some((v) => hay.includes(v))) reasons.push('锚引用不足：通篇没有具体的人或地');
  }
  // 效果白名单（GE-03，逐项核幅度）
  const caps = g.effectCaps;
  for (const [oi, o] of (p.options || []).entries()) {
    const where = `选项${oi + 1}`;
    if (typeof o.label !== 'string' || !o.label.trim()) reasons.push(`${where}：无标签`);
    if (o.mood_all !== undefined && (typeof o.mood_all !== 'number' || o.mood_all < caps.moodAll[0] || o.mood_all > caps.moodAll[1])) reasons.push(`${where}：全队心情越带`);
    if (o.mood_char !== undefined) {
      const c = pack.characters.find((x) => x.name === o.mood_char.name && state.chars.some((y) => y.id === x.id));
      if (!c) reasons.push(`${where}：心情对象不在队`);
      else if (typeof o.mood_char.n !== 'number' || o.mood_char.n < caps.moodChar[0] || o.mood_char.n > caps.moodChar[1]) reasons.push(`${where}：单人心情越带`);
    }
    if (o.items_gain !== undefined) {
      let v = 0;
      for (const [id, n] of Object.entries(o.items_gain)) {
        if (!pack.itemMap[id]) reasons.push(`${where}：未知物品 ${id}`);
        v += (pack.itemMap[id]?.value || 0) * n;
      }
      if (v > caps.itemValue) reasons.push(`${where}：得物价值超 4`);
    }
    if (o.item_cost !== undefined) {
      for (const [id, n] of Object.entries(o.item_cost)) {
        if (!pack.itemMap[id]) reasons.push(`${where}：未知物品 ${id}`);
        else if ((state.inventory[id] || 0) < n) reasons.push(`${where}：扣物超过家底`);
      }
    }
    if (o.reputation !== undefined) {
      if (!['neighbor', 'church', 'hospital', 'market'].includes(o.reputation.key)) reasons.push(`${where}：未知声望键`);
      if (typeof o.reputation.n !== 'number' || Math.abs(o.reputation.n) > 1) reasons.push(`${where}：声望越带`);
    }
    if (o.risk !== undefined && o.risk !== true) reasons.push(`${where}：risk 只能为 true（一次检定，伤上限 1）`);
    // 旗标白名单（P2b）：旗标只有命运弧能落，且只能从全局注册表里点菜；普通微光卡一律不许
    if (o.flag !== undefined) {
      const allowed = arc ? (arc.flags || []).filter((k) => (g.flagKeys || []).includes(k)) : [];
      for (const k of Object.keys(o.flag)) {
        if (!allowed.includes(k)) reasons.push(`${where}：旗标 ${k} 未注册（${arc ? `弧 ${arc.id} 未授权此键` : '微光卡不许落旗标'}）`);
      }
    }
  }
  // 选项互质（文学性约束①）：效果签名重复 = 参数变体冒充立场；至多一个零效果（无视类）选项
  {
    const sigs = (p.options || []).map(effectSignature);
    const seen = new Set();
    for (const sg of sigs) {
      if (sg === 'none') continue; // 零效果单独计数
      if (seen.has(sg)) { reasons.push('选项同质：效果签名重复'); break; }
      seen.add(sg);
    }
    if (sigs.filter((x) => x === 'none').length > 1) reasons.push('选项同质：至多一个零效果选项');
  }
  // 去重（GE-08）：指纹冷却
  const fp = geFingerprint(p);
  const seenDay = state.geFingers?.[fp];
  if (seenDay && state.day - seenDay < g.cooldownDays) reasons.push('指纹冷却期内');
  // 预算（GE-02）：全局占比 ≤25%。每日 ≤1 的配额只在注入侧裁决（server/ge.js）——
  // 生成是为明日备卡：今天的配额用掉不该拒明天的卡（预取在配额日用掉的时刻会被误杀）
  const shown = state.geShown || 0;
  const totalFired = Object.keys(state.firedOnce || {}).length + shown;
  if (shown + 1 > Math.max(1, Math.floor(Math.max(totalFired, 1) * g.budget.maxShareOfEvents))) reasons.push('全局占比超 25%');
  return { ok: reasons.length === 0, reasons, fingerprint: fp };
}

/** 提案 → 事件卡（入 run 级卡册，不进内容包）。opts.arc：命运弧（卡片带上 at=arc.at 供导演黄昏驻场） */export function proposalToCard(pack, state, p, { arc = null } = {}) {
  const card = {
    id: `ge_${state.day}_${geFingerprint(p)}`,
    kind: 'internal', generated: true, weight: 0,
    when: { chance: 0 },
    title: p.title.trim(),
    text: p.text.trim(),
    ...(arc?.at ? { at: arc.at } : {}),
    options: p.options.map((o, i) => {
      const effects = {};
      if (o.mood_all !== undefined) effects.mood = { ...(effects.mood || {}), all: o.mood_all };
      if (o.mood_char) {
        const c = pack.characters.find((x) => x.name === o.mood_char.name);
        if (c) effects.mood = { ...(effects.mood || {}), [c.id]: o.mood_char.n };
      }
      if (o.items_gain) effects.items = o.items_gain;
      if (o.reputation) effects.reputation = { [o.reputation.key]: o.reputation.n };
      if (o.outcomeText) effects.text = o.outcomeText;
      if (o.flag) effects.flags = o.flag; // 命运弧旗标（验证器已核白名单；走既有 eventFlags 通道）
      const opt = { key: `g${i}`, label: o.label.trim(), effects };
      if (o.item_cost) opt.cost = Object.entries(o.item_cost).map(([item, n]) => ({ item, n }));
      if (o.risk) {
        opt.riskCheck = {
          difficulty: 8,
          onFail: { wound: 1, text: '没成。挂了彩。' },
          onPass: { text: '成了。' }
        };
      }
      return opt;
    })
  };
  return card;
}

/** 事迹锚短语表（因果动词 → 玩家语言）：只收有分量的动词，短语避开全部禁词。
 *  结局「三件事」（events.js）与锚池共用同一张短语表——账只有一份。 */
export const DEED_PHRASES = {
  feed: '喂过饭', deny_food: '克扣过饭食', burn_book: '烧过书',
  heal: '治过伤', comfort: '安抚过人', help: '帮过人', donate: '分过东西',
  refuse_help: '拒过援手', steal_civ: '偷过人家', kill_civ: '杀过平民', kill_enemy: '杀过敌卒',
  spare: '放过人一命', volunteer: '出过力', guard_night: '守过夜', play_music: '奏过乐',
  trade_evidence: '卖过凭证', witness_death: '送走过人', launch_lighthouse: '点过北津台的火',
  join_table: '上过那张桌', refuse_table: '拒过那张桌'
};
const REP_NAME = { neighbor: '邻里', church: '里社', hospital: '医棚', market: '南市' };

/** 当局锚池（GE-04 的合法锚源）：天气/日期/队伍状态/近期事迹/已知地点/设施
 *  v3 扩充：这一局的历史也是锚——事迹（因果账）/声望档/时局/真相/念头/玩家话语。
 *  锚池越厚，生成卡越随进展而不同；锚是编剧唯一合法的素材来源。 */
export function anchorPool(pack, state) {
  const pool = new Set();
  pool.add(`天气:${state.weather}`);
  pool.add(`第${state.day}天`);
  if (state.winterActive) pool.add('冬季');
  for (const c of state.chars.filter((x) => x.alive)) {
    pool.add(`角色:${c.name}`);
    if (c.hunger <= 1) pool.add(`饥饿:${c.name}`);
    if (c.wound >= 1) pool.add(`带伤:${c.name}`);
    if (c.sick >= 1) pool.add(`带病:${c.name}`);
  }
  for (const id of state.knownLocs) if (pack.locMap[id]) pool.add(`地点:${pack.locMap[id].name}`);
  // 设施锚用中文名：裸 id（设施:stove）会被编剧照抄进卡面（验证局实测泄漏）
  for (const [f, v] of Object.entries(state.facilities)) {
    if (v > 0) pool.add(`设施:${pack.facilityMap?.[f]?.name || f}`);
  }
  // —— 近期事迹（七天内，至多三条；旧事进回忆录，不进选题）——
  const deeds = (state.causality?.entries || [])
    .filter((e) => e.day >= state.day - 7 && DEED_PHRASES[e.verb])
    .slice(-3);
  for (const e of deeds) pool.add(`事迹:${DEED_PHRASES[e.verb]}`);
  // —— 声望到档（邻里/里社/医棚/南市 记得你做过什么）——
  for (const [k, v] of Object.entries(state.reputation || {})) {
    if (Math.abs(v) >= 2) pool.add(`声望:${REP_NAME[k] || k}${v > 0 ? '念你们的好' : '记着你们的账'}`);
  }
  // —— 时局与真相（措辞避开正史禁词：锚会被编剧引用进正文）——
  if (state.war?.telegraphed) pool.add('时局:炮声稀了');
  if ((state.seals || []).length) pool.add(`真相:已显形${state.seals.length}层`);
  // —— 活着的念头（玩家种下的方向，编剧可以让它发芽）——
  for (const d of Object.values(state.directions || {}).filter((x) => x.alive).slice(0, 3)) {
    const nm = d.subject ? (pack.charMap[d.subject]?.name || d.subject) : '这个家';
    pool.add(`念头:${nm}·${d.text.slice(0, 20)}`);
  }
  // —— 玩家未被接住的话（素材不是指令：编剧可长出回应卡，但仍受全部铁律约束）——
  for (const w of (state.whispers || []).slice(-2)) pool.add(`话语:${w.text.slice(0, 20)}`);
  return [...pool];
}
