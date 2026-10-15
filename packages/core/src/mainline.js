import { hashStr } from './rng.js';
const pickOf = (h, n) => ((h ^ (h >>> 16)) >>> 0) % n;

// 大事轴主线日步（叙事双轴-v0.1 §4）：确定性选步（窗口步按种子择日、末日必落）、
// 闲笔抽样（种子）、投影闲笔（旗标触发，一局一次）、玩家轴日digest。
// 步与闲笔一并通过 MAINLINE_STEP 事件入账（fold 镜像）；步文本的 LLM 渲染在 server（史官），
// 直读时用 step.fallback——大事轴不掷骰，锚不换（RND-08 全程有效）。

/** 正史停问（A·戏剧弧）：带 ask 的大事步落地那晨，史书先问这个家——
 *  挂历变对手戏。先于随机晨抽执行（正史的问题不跟敲门的事抢位），
 *  一局一问，EVENT_FIRED 入账（fold 可回放）。
 *  变奏（周目不重样）：步持 asks 池（≥2 变体），按 hash(seed|slot) 选角——
 *  池项可为字符串或 {card, needItem}（持物限定变体，如吏版过境卡）。
 *  选角是纯函数：同种子必同选，fold 天然可回放。 */
export function mainlineAskTick(ctx) {
  const s = ctx.s;
  const ml = ctx.pack?.mainline;
  if (!ml || s.sidestory || s.over) return;
  if (s.activeEvent) return;
  const step = (ml.steps || []).find((st) => (st.asks || st.ask) && st.day === s.day && !s.firedOnce['ask_' + st.id]);
  const pool = step
    ? (step.asks || [step.ask])
      .map((e) => (typeof e === 'string' ? { card: e } : e))
      .filter((e) => ctx.pack.cardMap[e.card])
      .filter((e) => !e.needItem || (s.inventory[e.needItem] || 0) > 0)
    : [];
  // 史种注入（念头演化）：种下的史锚在窗口内长成一张为它定制的停问卡——
  // 玩家的话改写史书后来问什么。注入项带 seedOf 便于落 firedOnce 双账。
  // 独立发芽（seed 闭环）：种子的回应不搭大事 ask 步的车——窗口内的每个早晨
  // 都可能长卡；只搭车的话窗口里常无 ask 步（实测仅 1 天），承诺的回应永不来。
  let seedPick = null;
  for (const d of Object.values(s.directions || {})) {
    if (d.kind !== 'hist' || !d.alive || s.firedOnce['hs_' + d.id]) continue;
    const card = ctx.pack.cardMap['hs_' + d.seed];
    const [lo, hi] = card?.when?.seedWindow || [];
    if (card && lo !== undefined && s.day >= lo && s.day <= hi) {
      seedPick = { card: card.id, seedOf: d.id };
      break; // 一晨至多一粒史种
    }
  }
  if (!pool.length && !seedPick) return;
  const full = seedPick ? [...pool, seedPick] : pool;
  const picked = step
    ? full[pickOf(hashStr(`${s.seed}|ask|${step.id}`), full.length)]
    : seedPick; // 无步的早晨：种子直接发芽（无池可选）
  const card = ctx.pack.cardMap[picked.card];
  if (step) s.firedOnce['ask_' + step.id] = true;
  if (picked.seedOf) s.firedOnce['hs_' + picked.seedOf] = true; // 史种落地双账
  ctx.emit('FLAG', { key: 'firedOnce', val: structuredClone(s.firedOnce) });
  s.activeEvent = { cardId: picked.card };
  ctx.emit('EVENT_FIRED', { cardId: picked.card });
  ctx.fact('event', { cardId: picked.card, title: card.title });
}

/** 破晓钩子：为 s.day 选步＋抽闲笔＋触发投影；一日至多一条 MAINLINE_STEP */
export function mainlineTick(ctx) {  const s = ctx.s;
  const ml = ctx.pack?.mainline;
  if (!ml || s.sidestory || s.over) return;
  if ((s.mainline || []).some((e) => e.day === s.day)) return; // 一日一步，幂等
  const step = pickStep(ctx);
  const pens = samplePens(ctx);
  const mirrors = fireMirrors(ctx);
  // 主线×玩家回声（ME-2）：大事落定的那天，翻一遍这个家的因果账——
  // 你做过的事在史书的这一天留了影子。钩子长在内容包（echoHooks），内核只对账，零发明。
  const echo = step ? matchStepEcho(ctx, step) : null;
  if (step?.sense?.moodAll) ctx.moodAll(step.sense.moodAll, 'ml_' + step.id, { helpMul: false });
  if (step) {
    s.firedOnce['ml_' + step.id] = true;
    ctx.emit('FLAG', { key: 'firedOnce', val: structuredClone(s.firedOnce) });
  }
  if (!step && !pens.length && !mirrors.length) return;
  const entry = { day: s.day, stepId: step?.id || null, pens, mirrors };
  if (echo) entry.echo = echo;
  (s.mainline ||= []).push(structuredClone(entry));
  ctx.emit('MAINLINE_STEP', entry);
  ctx.fact('mainline_step', { day: s.day, stepId: entry.stepId, pens: pens.length, mirrors: mirrors.length });
  if (echo) ctx.fact('mainline_echo', { step: step.title, text: echo }); // 进当日叙事轨——史与你要在同一页上
}

/** 回声钩子匹配（内容即数据：step.echoHooks = [{when:{...}, text}]，命中即用，先挂先得）
 *  when 支持：{verb, target?}（因果账）、{verb, minCount}、{flag}、{dissolveGte}、{cardShown} */
function matchStepEcho(ctx, step) {
  const s = ctx.s;
  for (const hook of step.echoHooks || []) {
    const w = hook.when || {};
    if (w.verb) {
      const hits = (s.causality?.entries || []).filter((e) =>
        e.verb === w.verb && (!w.target || e.target === w.target));
      if (w.minCount ? hits.length >= w.minCount : hits.length > 0) return hook.text;
    }
    if (w.flag && s.eventFlags?.[w.flag]) return hook.text;
    if (w.dissolveGte !== undefined && (s.dissolve || 0) >= w.dissolveGte) return hook.text;
    if (w.cardShown && (s.cardCount?.[w.cardShown] || 0) > 0) return hook.text;
  }
  return null;
}

function stepWhenOk(s, st) {
  const w = st.when || {};
  if (w.winter === true && !s.winterActive) return false;
  if (w.winter === false && s.winterActive) return false;
  if (w.flag && !s.eventFlags[w.flag]) return false;
  if (w.notFlag && s.eventFlags[w.notFlag]) return false;
  return true;
}

/** 选步：精确日必落；窗口步（dayWindow 宽于一日）逐日 45% 概率、末日必落 */
function pickStep(ctx) {
  const s = ctx.s, ml = ctx.pack.mainline;
  for (const st of ml.steps || []) {
    if (s.firedOnce['ml_' + st.id]) continue;
    const lo = st.dayWindow?.[0] ?? st.day;
    const hi = st.dayWindow?.[1] ?? st.day;
    if (s.day < lo || s.day > hi) continue;
    if (!stepWhenOk(s, st)) continue;
    if (hi > lo && s.day < hi && ctx.rng.int(100) >= 45) continue; // 窗口内择日
    return st;
  }
  return null;
}

/** 闲笔抽样：条件过滤后 40% 出一人（种子确定性） */
function samplePens(ctx) {
  const s = ctx.s;
  const figs = (ctx.pack.historia?.figures || []).filter((f) =>
    s.day >= (f.minDay || 1) && !(s.mainlinePens || []).includes(f.id));
  if (!figs.length) return [];
  if (ctx.rng.int(100) >= 40) return [];
  const pick = figs[ctx.rng.int(figs.length)];
  (s.mainlinePens ||= []).push(pick.id);
  return [pick.id];
}

/** 投影闲笔：旗标/守夜/文档数触发，一局一次（firedOnce 记账） */
function fireMirrors(ctx) {
  const s = ctx.s, ml = ctx.pack.mainline;
  const out = [];
  for (const m of ml.mirrors || []) {
    if (s.firedOnce['mr_' + m.id]) continue;
    const w = m.when || {};
    let ok = false;
    if (w.flag) ok = !!s.eventFlags[w.flag];
    if (w.guardNights) ok = (s.causality?.entries || []).filter((e) => e.verb === 'guard_night').length >= w.guardNights;
    if (w.docs) ok = (s.docsSeen || []).length >= w.docs;
    if (ok) {
      s.firedOnce['mr_' + m.id] = true;
      out.push(m.id);
    }
  }
  if (out.length) ctx.emit('FLAG', { key: 'firedOnce', val: structuredClone(s.firedOnce) });
  return out;
}

// —— 玩家轴日digest（确定性，账不粉饰）——
const DIGEST_VERB = {
  help: '帮过人', donate: '给过药', refuse_help: '拒过求助', steal_civ: '拿过别人的东西',
  kill_civ: '杀过人', kill_enemy: '结果过人', heal: '换过药', comfort: '陪人坐过',
  guard_night: '守过夜', volunteer: '出过门', witness_death: '送走过人', burn_book: '烧过书',
  play_music: '鼓过琴', launch_lighthouse: '点过北津台的火', join_table: '收过符传', trade_evidence: '卖过凭证'
};

/** 一日的我方一行：因果账当日动词（至多两笔）＋人还在几个；无事即平静 */
export function dayDigest(state, day) {
  const s = state;
  const verbs = (s.causality?.entries || []).filter((e) => e.day === day && DIGEST_VERB[e.verb] && e.weight >= 1)
    .map((e) => DIGEST_VERB[e.verb]);
  const uniq = [...new Set(verbs)];
  const alive = s.chars.filter((c) => c.alive).length;
  if (!uniq.length) return `平静的一日。人还在 ${alive} 个。`;
  return `${uniq.slice(0, 2).join('，')}。人还在 ${alive} 个。`;
}

/**
 * 史卷视图（server enrich 直用）：步日志 → 条目（含结局收束步与日digest）。
 * annalsByDay：LLM 史笔（day→text），缺省回落 step.fallback。
 */
export function buildChronicle(state, pack, annalsByDay = null) {
  const ml = pack.mainline;
  if (!ml) return null;
  const stepMap = Object.fromEntries((ml.steps || []).map((x) => [x.id, x]));
  const actMap = Object.fromEntries((ml.acts || []).map((x) => [x.id, x]));
  const figureMap = Object.fromEntries((pack.historia?.figures || []).map((x) => [x.id, x]));
  const mirrorMap = Object.fromEntries((ml.mirrors || []).map((x) => [x.id, x]));
  const entries = [];
  for (const e of state.mainline || []) {
    const step = e.stepId ? stepMap[e.stepId] : null;
    const text = (annalsByDay && annalsByDay[e.day]) || step?.fallback || (e.pens?.length ? '' : '');
    entries.push({
      day: e.day,
      act: step ? (actMap[step.act]?.title || '') : '',
      track: step?.track || null, // v0.3 双轨：city=城轨 / gen=将军轨
      title: step?.title || '闲笔',
      text,
      anchor: !!step,
      ...(step?.cite ? { cite: step.cite } : {}), // 史注（0.33.0）：正史落锚的日子带志书引文
      ...(e.echo ? { echo: e.echo } : {}), // 主线×玩家回声（ME-2）：史册步下带一行"你"的影子
      pens: (e.pens || []).map((id) => figureMap[id]).filter(Boolean).map((f) => ({ name: f.name, line: f.line })),
      mirrors: (e.mirrors || []).map((id) => mirrorMap[id]).filter(Boolean).map((m) => m.line),
      digest: e.day <= state.day ? dayDigest(state, e.day) : null
    });
  }
  // 结局收束步组：war 已终即入卷（含 D45 当日的终局与或然/还师/出江陵）
  const ending = state.war?.ended ? (ml.endings?.[state.war.endingType] || null) : null;
  if (ending) {
    for (const line of ending) entries.push({ day: state.day, act: '收束', title: '结局', text: line, anchor: true, ending: true, pens: [], mirrors: [], digest: null });
  }
  // 当前幕
  const acts = (ml.acts || []).filter((a) => state.day >= a.days[0]);
  return { acts: ml.acts || [], currentAct: acts.length ? acts[acts.length - 1] : null, entries };
}
