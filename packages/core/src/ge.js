// C 层生成事件验证器（内核设计-v0.2 §8.8 GE-03~08 / GE-10）。
// 铁律：皮肤自由，效果只准从白名单点菜；校验不过即拒，拒了不重试原样提交。
import { hashStr } from './rng.js';

/** 提案指纹（GE-08 去重）：主题+对象+效果类型，7 天冷却 */
export function geFingerprint(p) {
  const effTypes = (p.options || [])
    .flatMap((o) => Object.keys(o).filter((k) => ['mood_all', 'mood_char', 'items_gain', 'item_cost', 'reputation', 'risk'].includes(k)))
    .sort().join('+');
  return 'g' + hashStr(`${p.theme}|${p.title}|${effTypes}`);
}

/** 校验提案。返回 {ok, reasons[]} */
export function validateProposal(pack, state, p, { anchors } = {}) {
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
  // 锚定（GE-04）：≥2 个真实存在的锚
  const an = Array.isArray(p.anchors) ? p.anchors : [];
  if (anchors && an.filter((a) => anchors.includes(a)).length < 2) reasons.push('锚不足 2 个或不在当局的锚池里');
  // 防火墙（GE-10）：暗线词表 + 正史锚点，文本域逐字扫描
  const hay = [p.title, p.text, ...(p.options || []).map((o) => `${o.label} ${o.outcomeText || ''}`)].join(' ');
  for (const b of g.bannedTerms) if (hay.includes(b)) reasons.push(`正典/正史防火墙：${b}`);
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
  }
  // 去重（GE-08）：指纹冷却
  const fp = geFingerprint(p);
  const seenDay = state.geFingers?.[fp];
  if (seenDay && state.day - seenDay < g.cooldownDays) reasons.push('指纹冷却期内');
  // 预算（GE-02）：每日 ≤1、全局占比 ≤25%
  const shown = state.geShown || 0;
  if (shown >= 1 && state.day - (state.geLastDay || 0) < 1) reasons.push('今日配额已用');
  const totalFired = Object.keys(state.firedOnce || {}).length + shown;
  if (shown + 1 > Math.max(1, Math.floor(Math.max(totalFired, 1) * g.budget.maxShareOfEvents))) reasons.push('全局占比超 25%');
  return { ok: reasons.length === 0, reasons, fingerprint: fp };
}

/** 提案 → 事件卡（入 run 级卡册，不进内容包） */
export function proposalToCard(pack, state, p) {
  const card = {
    id: `ge_${state.day}_${geFingerprint(p)}`,
    kind: 'internal', generated: true, weight: 0,
    when: { chance: 0 },
    title: p.title.trim(),
    text: p.text.trim(),
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

/** 当局锚池（GE-04 的合法锚源）：天气/日期/队伍状态/近期事迹/已知地点/设施 */
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
  for (const [f, v] of Object.entries(state.facilities)) if (v > 0) pool.add(`设施:${f}`);
  return [...pool];
}
