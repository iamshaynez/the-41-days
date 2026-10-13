// 序章三幕（叙事双轴-v0.1 §2）：节拍引擎的数据面。
// 幕一「天下」→ 幕二「围城」（引文＋既有序章卡）→ 幕三「入局」（前传×出场者＋合流＋卡）。
// 前传不泄封印律：这里只装配文本，不做任何状态变更；状态推进在 resolve.js 的节拍引擎里。
const bySeq = (a, b) => (a.seq || 0) - (b.seq || 0);

function confluenceText(pack, s) {
  const p = pack.prelude;
  if (!p?.confluence) return '';
  const roster = new Set(s.chars.map((c) => c.id));
  const v = (p.confluence.variants || []).find((x) => (x.requiresChar || []).every((id) => roster.has(id)));
  return (v && v.text) || p.confluence.default || '';
}

/**
 * 序章全部节拍（顺序即演出顺序）。
 * t=text：文本幕（advance 翻页）；t=card：既有序章卡（event_choice 推进）。
 * short=二周目单句版：天下收为一行，围城引文略过，前传用 line。
 * 无 prelude.json 的旧内容包：退化为纯卡序（v0 老行为）。
 */
export function preludeBeats(pack, s) {
  const p = pack.prelude;
  const cards = pack.cards.filter((c) => c.kind === 'prologue').sort(bySeq);
  if (!p) return cards.map((c) => ({ t: 'card', id: c.id }));
  const short = (s.preludeMode || 'full') === 'short';
  const beats = [];
  if (short) {
    // 开场二选一（拍板 v4）：第一拍二选一——完整三幕 or 精简版；玩家局由 server 默认 short 进入
    if (p.openingChoice) beats.push({ t: 'text', id: p.openingChoice.id || 'openingChoice', source: 'openingChoice', title: p.openingChoice.title || '开场', text: p.openingChoice.text });
    if (p.heavenLine) beats.push({ t: 'text', id: 'heavenLine', source: 'heavenLine', title: '天下', text: p.heavenLine });
  } else {
    for (const h of p.heaven || []) beats.push({ t: 'text', id: h.id, source: 'heaven', title: h.title || '天下', text: h.text });
    for (const sg of p.siege || []) beats.push({ t: 'text', id: sg.id, source: 'siege', title: sg.title || '围城', text: sg.text });
  }
  for (const id of p.cardsAct2 || []) if (pack.cardMap[id]?.kind === 'prologue') beats.push({ t: 'card', id });
  for (const c of s.chars) {
    const q = p.prequels?.[c.id];
    if (q) beats.push({ t: 'prequel', id: c.id });
  }
  // 入局引：前传毕、合流前——点破"你是三个战乱里的平民，目标是活下去"
  for (const e of p.entry || []) beats.push({ t: 'text', id: e.id, source: 'entry', title: e.title || '你是谁', text: e.text });
  if (p.confluence) beats.push({ t: 'text', id: 'confluence', source: 'confluence', title: '入局', text: confluenceText(pack, s) });
  for (const id of p.cardsAct3 || []) if (pack.cardMap[id]?.kind === 'prologue') beats.push({ t: 'card', id });
  return beats;
}

/**
 * 当前节拍的视图（server enrich 直用）：
 * { idx, total, kind: 'text'|'prequel'|'card'|'done', title, text, canSkip }
 * canSkip：精简版（short 模式）才有跳过键——选了完整三幕的人，三幕就是入场礼，不设快门。
 */
export function preludeBeatView(pack, s) {
  const beats = preludeBeats(pack, s);
  const i = s.prelude?.i ?? 0;
  const base = { idx: i, total: beats.length, canSkip: (s.preludeMode || 'full') === 'short' };
  if (i >= beats.length) return { ...base, kind: 'done', title: '', text: '' };
  const b = beats[i];
  if (b.t === 'card') return { ...base, kind: 'card', title: '', text: '' };
  // {{names}}：入局引点名"你是谁"——名字来自本局阵容
  const names = s.chars.map((c) => c.name).join('、');
  const withNames = (t) => String(t || '').replaceAll('{{names}}', names);
  if (b.t === 'prequel') {
    const q = pack.prelude?.prequels?.[b.id];
    const short = (s.preludeMode || 'full') === 'short';
    return { ...base, kind: 'prequel', id: b.id, title: q?.title || '', text: withNames(short ? (q?.line || '') : (q?.paras || []).join('\n')) };
  }
  return { ...base, kind: 'text', id: b.id, title: b.title || '', text: withNames(b.text) };
}
