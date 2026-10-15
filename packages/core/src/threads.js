// 回响节拍器（小说层·感知设计）：长线不住在散文里。
// 每条线一句母题，按节拍轻触（晨报一行 / 鲁舟捎话一句），线索物化成物品，
// 状态行常驻晨报——种（卡/物品）→轻触→翻转（卡）→回收（终局）。
// 激活与去重全部从 state 派生（firedOnce/flags/day/dissolve），fold 可回放。
import { aliveChars } from './state.js';
import { DEED_PHRASES } from './ge.js';

const dissolveTh = (pack) => pack?.manifest?.war?.dissolveThreshold ?? 22;
const threadActive = (s, th, pack) => {
  const a = th.active || {};
  if (a.card) return !!s.firedOnce[a.card];
  if (a.flag) return !!s.eventFlags?.[a.flag];
  if (a.dissolve === 'threshold') return (s.dissolve || 0) >= dissolveTh(pack);
  return s.day >= (a.day ?? 1);
};

/** 破晓钩子：轻触（晨报轨/事实）、物化 token、翻转卡、暗面三拍链、幕问幕结。
 *  翻转卡遵守一晨一卡（正史停问 > 随机晨抽 > 概述 > 危机/心事 > 线的翻转）。 */
export function tickThreads(ctx) {
  const s = ctx.s;
  const th = ctx.pack?.threads;
  if (!th || s.sidestory || s.over) return;
  const mark = (k) => {
    s.firedOnce[k] = true;
    ctx.emit('FLAG', { key: 'firedOnce', val: structuredClone(s.firedOnce) });
    return true;
  };
  const fireCard = (id, actorId) => {
    const card = ctx.pack.cardMap[id];
    if (!card) return false;
    mark(id);
    s.activeEvent = { cardId: id, ...(actorId ? { actorId } : {}) };
    ctx.emit('EVENT_FIRED', { cardId: id, ...(actorId ? { actorId } : {}) });
    ctx.fact('event', { cardId: id, title: card.title, ...(actorId ? { who: actorId } : {}) });
    return true;
  };
  for (const t of th.threads || []) {
    if (!threadActive(s, t, ctx.pack)) continue;
    // 物化 token：线索进城（物品是最好的伏笔载体——翻包即复习）
    if (t.token && s.day >= t.token.day && !s.firedOnce['thtok_' + t.id] && !s.firedOnce[t.token.item]) {
      mark('thtok_' + t.id);
      ctx.addItem(t.token.item, 1, '线头');
      ctx.fact('token_found', { item: t.token.item, name: ctx.pack.itemMap?.[t.token.item]?.name || t.token.item, flavor: ctx.pack.itemMap?.[t.token.item]?.flavor || '' });
    }
    // 轻触（morning 轨）：一天至多一条线的一句话
    (t.touches || []).forEach((tc, i) => {
      const k = `tht_${t.id}_${i}`;
      if (tc.via !== 'morning' || s.firedOnce[k]) return;
      if (s.day >= tc.from && s.day <= tc.to) {
        mark(k);
        ctx.fact('thread_touch', { id: t.id, motif: t.motif, line: tc.line });
      }
    });
    // 翻转卡：窗口内择晨而落（晨位被占则顺延到窗口内下一晨）
    if (t.turn && !s.firedOnce[t.turn.card] && s.day >= t.turn.from && s.day <= t.turn.to && !s.activeEvent) {
      fireCard(t.turn.card);
    }
  }
  // 暗面三拍链（同屋的暗面）：心结首拍已显形的人，中段被指认——好人做过最坏的事
  const sc = th.shadowChain;
  if (sc && s.day >= sc.from && s.day <= sc.to && !s.firedOnce[sc.card] && !s.activeEvent) {
    const target = aliveChars(s).find((c) => {
      const kc = ctx.pack.charMap[c.id]?.persona?.knotCard;
      return kc && s.firedOnce[kc] && ctx.pack.charMap[c.id]?.persona?.shadow;
    });
    if (target) fireCard(sc.card, target.id);
  }
  tickActs(ctx);
}

/** 幕问与幕结（宏观抓手）：幕首一问立题，幕末三行收拢——这一幕你做了什么 / 城里 / 悬而未决。
 *  幕区间住内容包（mainline.acts[].days）——比从步推导权威 */
function tickActs(ctx) {
  const s = ctx.s;
  const ml = ctx.pack?.mainline;
  const acts = (ml?.acts || []).filter((a) => a.days && a.question);
  if (!acts.length || s.sidestory) return;
  for (const { id: act, days, question } of acts) {
    const first = days[0];
    const last = days[1];
    if (s.day >= first && s.day <= first + 1 && !s.firedOnce['actq_' + act]) {
      s.firedOnce['actq_' + act] = true;
      ctx.emit('FLAG', { key: 'firedOnce', val: structuredClone(s.firedOnce) });
      ctx.fact('act_question', { act, q: question });
    }
    if (s.day === last && !s.firedOnce['actw_' + act]) {
      s.firedOnce['actw_' + act] = true;
      ctx.emit('FLAG', { key: 'firedOnce', val: structuredClone(s.firedOnce) });
      const name = (id) => s.chars.find((c) => c.id === id)?.name || ctx.pack.charMap?.[id]?.name || '';
      const entries = (s.causality?.entries || []).filter((e) => e.day >= first && e.day <= last && e.weight >= 1 && !e.tags?.includes('prologue'));
      const top = entries.sort((a, b) => b.weight - a.weight)[0];
      const you = top ? `${top.via ? name(top.via) : (top.actor === 'player' ? '你' : '')}${DEED_PHRASES[top.verb] || ''}${top.target && ctx.pack.charMap?.[top.target] ? '·' + name(top.target) : ''}` : '日子照常过';
      const city = ml.steps.filter((st) => (st.dayWindow?.[0] ?? st.day) >= first && (st.dayWindow?.[0] ?? st.day) <= last).map((st) => st.title).join('、') || '无大事';
      const open = (ctx.pack.threads?.threads || []).filter((t) => !t.hidden && threadActive(s, t, ctx.pack)).map((t) => t.motif).join('、') || '无';
      ctx.fact('act_wrap', { act, you, city, open });
    }
  }
}

/** 线的状态行（常驻晨报，sev0 不拦概述）：游戏替玩家记住 */
export function threadsStateLines(state, pack) {
  const s = state;
  const out = [];
  for (const t of pack?.threads?.threads || []) {
    if (t.hidden || !t.stateLine) continue;
    if (threadActive(s, t, pack) && !s.firedOnce[t.turn?.card || t.id]) out.push({ sev: 0, key: 'thread_' + t.id, text: t.stateLine });
  }
  return out;
}

/** 鲁舟捎话轨：到访日若撞上某线的 franko 轻触窗口，捎一句母题（并记账防重） */
export function threadsFrankoPick(ctx) {
  const s = ctx.s;
  for (const t of ctx.pack?.threads?.threads || []) {
    if (!threadActive(s, t, ctx.pack)) continue;
    for (const [i, tc] of (t.touches || []).entries()) {
      const k = `tht_${t.id}_${i}`;
      if (tc.via !== 'franko' || s.firedOnce[k]) continue;
      if (s.day >= tc.from && s.day <= tc.to) {
        s.firedOnce[k] = true;
        ctx.emit('FLAG', { key: 'firedOnce', val: structuredClone(s.firedOnce) });
        return tc.line;
      }
    }
  }
  return null;
}
