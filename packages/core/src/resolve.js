// resolve 管线（技术架构 §4 核心数据流）：意图校验 → 应用 → 阶段推进 → 事实输出。
// LLM 与直读解析器都产出同一套结构化意图，从 resolveInput 进入。
// v2 决断意志模型：auto_day / auto_night 宏意图在这里惰性展开为管家规划（delegate.js），
// 展开产物与玩家手输意图共用同一校验、同一扣账、同一事件流——自动化没有第二条通道。
import { Ctx } from './ctx.js';
import { aliveChars, charById, apMaxOf, policyOf, DEFAULT_POLICY } from './state.js';
import { applyDayAction } from './dayActions.js';
import { startNight, applyNightAction, endNightReturn } from './night.js';
import { resolveRaid } from './raid.js';
import { executeTrade } from './trade.js';
import { chooseEventOption, optionAvailable, optionCostOk } from './events.js';
import { tickHunger, tickHealth, tickFatigue, tickTemperature, tickMood, tickProduction, tickWar, advanceDay, drawMorningEvents } from './vitals.js';
import { tickAutonomous, tickDirections } from './causality.js';
import { evaluateSeals } from './seals.js';
import { buildEnding } from './events.js';
import { planDay, planNightStep, tickDawnLedgers } from './delegate.js';
import { preludeBeats } from './prelude.js';
import { mainlineTick } from './mainline.js';
import { ensembleTick } from './ensemble.js';

/** 意图白名单（shared 契约） */
export function validateIntentShape(intent) {
  if (!intent || typeof intent !== 'object' || !intent.type) return false;
  switch (intent.type) {
    case 'act': return typeof intent.action === 'string';
    case 'dusk_assign': return true;
    case 'night': return typeof intent.action === 'string';
    case 'trade_op': return intent.give || intent.get;
    case 'event_choice': return typeof intent.option === 'string';
    case 'meta': return typeof intent.query === 'string';
    case 'advance': return true;
    case 'skip_prelude': return true;
    case 'prelude_full': return true;
    case 'policy': return typeof intent.key === 'string';
    case 'direction': return typeof intent.text === 'string' && !!intent.text.trim() && intent.text.trim().length <= 60;
    case 'whisper': return typeof intent.text === 'string' && !!intent.text.trim() && intent.text.trim().length <= 60;
    case 'scene': return typeof intent.text === 'string' && !!intent.text.trim() && intent.text.trim().length <= 80;
    case 'night_directive': return ['cautious', 'normal', 'bold'].includes(intent.stance) && typeof intent.text === 'string' && !!intent.text.trim() && intent.text.length <= 60;
    case 'auto_day': return true;
    case 'auto_night': return true;
    default: return false;
  }
}

/**
 * 主入口：对 state 应用一批意图。
 * @returns {{state, events, facts, rejects: Array, ending?: object}}
 */
export function resolveInput(state, pack, intents) {
  const events = [];
  const facts = [];
  const ctx = new Ctx(state, pack, events, facts);
  const rejects = [];
  // RUN_STARTED 只在第一批由 createRun 的调用方写入；这里直接处理意图
  // 队列式处理：宏意图（auto_day/auto_night）在弹出时才展开，保证读到的策略/状态是最新的
  const queue = [...intents];
  while (queue.length) {
    const intent = queue.shift();
    if (intent.type === 'auto_day') {
      if (state.phase !== 'day') { rejects.push({ intent, reason: 'BAD_PHASE' }); continue; }
      ctx.fact('auto_day_start', {});
      const planned = planDay(state, pack);
      queue.unshift(...planned);
      // 门口有未决事件时不自动收工——留给玩家先应门。
      // 计划为空也要收卷（材料账预检后 planDay 可能无一事可提——
      // 托管的日子不能因为"今天没事干"就永远停在白天）
      if (!state.activeEvent) queue.push({ type: 'advance', delegated: true });
      continue;
    }
    if (intent.type === 'auto_night') {
      if (state.night && !state.night.home) { state.night.micro = true; ctx.emit('NIGHT_PATCH', { micro: true }); }
      runAutoNight(ctx, rejects, intent);
      continue;
    }
    if (intent.type === 'night_directive') {
      // 夜间方针（宏观模式）：一次决策，整夜自走——岔路按方针立场 + 种子随机自动决策，
      // 不再逐拍问玩家（这是宏观策略游戏，不是微观 RPG）
      if (state.phase !== 'night' || !state.night || state.night.home) { rejects.push({ intent, reason: 'NOT_NIGHT' }); continue; }
      const stance = ['cautious', 'normal', 'bold'].includes(intent.stance) ? intent.stance : 'normal';
      state.night.directive = { stance, text: String(intent.text).trim().slice(0, 60) };
      ctx.emit('NIGHT_PATCH', { room: state.night.room, slots: state.night.slots, noise: state.night.noise, pack: [...state.night.pack], packSlots: state.night.packSlots, observed: { ...state.night.observed }, unlocked: { ...state.night.unlocked }, cleared: { ...state.night.cleared }, sawed: { ...state.night.sawed }, lowSlotsAck: !!state.night.lowSlotsAck, micro: false, directive: state.night.directive });
      ctx.fact('night_directive_set', { stance, text: state.night.directive.text });
      runDirectiveNight(ctx, rejects, stance);
      continue;
    }
    if (!validateIntentShape(intent)) { rejects.push({ intent, reason: 'BAD_SHAPE' }); continue; }
    ctx.delegated = !!intent.delegated;
    const r = applyOne(ctx, intent);
    ctx.delegated = false;
    if (r && r.ok === false) rejects.push({ intent, reason: r.reason });
  }
  // 自动推进：白天 AP 全空且无待决事件 → 黄昏
  if (state.phase === 'day' && !state.activeEvent && aliveChars(state).length && aliveChars(state).every((c) => c.ap === 0)) {
    toDusk(ctx);
  }
  // 夜晚在家 → 立即走完晨线
  if (state.phase === 'night' && state.night?.home) toDawn(ctx);
  // 夜未收工且无待决事件、不停在岔路上：方针/微操自愈续跑——
  // 玩家答完事件或点了单步岔路选项（按钮只带一个 night 动作）后，
  // 夜不能停在半途等人再点「继续」；同一批输入里走到底（到下一个岔路或收工）
  if (state.phase === 'night' && state.night && !state.night.home && !state.activeEvent
    && state.night.slots > 0 && !state.night.atFork) {
    if (state.night.directive) runDirectiveNight(ctx, rejects, state.night.directive.stance);
    else if (state.night.micro) runAutoNight(ctx, rejects, {});
  }
  // 夜晚时间槽耗尽 → 收尾
  if (state.phase === 'night' && state.night && !state.night.home && state.night.slots <= 0) {
    endNightReturn(ctx, 'slots_out');
  }
  if (state.phase === 'dawn') toDawn(ctx);
  // 封印注入协议（§11.4）：每批结算后评估一次，条件满足才解锁
  evaluateSeals(ctx);
  // 战争结束 / 全灭 → 终局
  if (!state.over && (state.war.ended || aliveChars(state).length === 0)) {
    state.over = true;
    const ending = buildEnding(state, pack);
    state.ending = ending;
    state.threeThings = ending.threeThings;
    ctx.emit('RUN_ENDED', { type: ending.type, ending });
    ctx.fact('run_ended', { type: ending.type });
  }
  const out = ctx.done();
  ctx.emit('CURSOR', { to: out.state.rngCursor });
  return { state: out.state, events, facts, rejects };
}

/** 夜间自动流：逐步规划直到岔路停问 / 搜尽撤退 / 事件接管 / 槽尽收工 */
function runAutoNight(ctx, rejects, autoIntent) {
  const s = ctx.s;
  if (s.phase !== 'night' || !s.night || s.night.home) { rejects.push({ intent: autoIntent, reason: 'BAD_PHASE' }); return; }
  let guard = 0;
  while (s.phase === 'night' && s.night && !s.night.home && !s.activeEvent && guard++ < 24) {
    const step = planNightStep(s, ctx.pack, { approach: autoIntent.approach });
    if (!step) { // 搜尽了——回家
      ctx.delegated = true;
      applyOne(ctx, { type: 'night', action: 'retreat' });
      ctx.delegated = false;
      break;
    }
    if (step.stop) {
      if (step.stop.kind === 'event') break; // 事件卡接管叙事
      // 同一岔路只问一次：选项自带的 auto_night 续跑、收尾段自愈都可能再次规划到
      // 同一个停点——atFork 标记「已问过」，不重复落 night_fork 账
      if (!s.night.atFork) {
        s.night.atFork = true;
        ctx.emit('NIGHT_PATCH', { atFork: true });
        ctx.fact('night_fork', { kind: step.stop.kind, text: step.stop.text, options: step.stop.options.map((o) => o.label) });
      }
      break;
    }
    ctx.delegated = true;
    const r = applyOne(ctx, { ...step.intent, delegated: true });
    ctx.delegated = false;
    if (r && r.ok === false) { // 规划与现实脱节（理论不该发生）：不空转，撤退保平安
      ctx.delegated = true;
      applyOne(ctx, { type: 'night', action: 'retreat' });
      ctx.delegated = false;
      break;
    }
  }
}

function applyOne(ctx, intent) {
  const s = ctx.s;
  // 序章守卫：闪回里"选哪个"与"翻页"合法（PH-03：阶段推进只由内核驱动；
  // 翻页只对文本幕开放——卡拍必须选，选择才有旗标与因果账）
  if (s.phase === 'prologue' && intent.type !== 'event_choice' && intent.type !== 'meta'
    && intent.type !== 'skip_prelude' && intent.type !== 'prelude_full'
    && !(intent.type === 'advance' && preludeBeats(ctx.pack, s)[s.prelude?.i ?? 0]?.t !== 'card')) {
    ctx.fact('in_prologue', {});
    return { ok: false, reason: 'IN_PROLOGUE' };
  }
  switch (intent.type) {
    case 'act':
      return applyDayAction(ctx, intent);
    case 'dusk_assign': {
      if (s.phase !== 'dusk') return { ok: false, reason: 'NOT_DUSK' };
      if (s.activeEvent?.duskFate) {
        // 黄昏命运卡：人动身了，门口的问题也就过去了——命运不等人（路过也是一种回答）
        const fateCard = s.geCards?.[s.activeEvent.cardId] || ctx.pack.cardMap[s.activeEvent.cardId];
        const cardId = s.activeEvent.cardId;
        s.activeEvent = null;
        ctx.emit('EVENT_CHOSEN', { cardId, option: 'passed' });
        ctx.fact('fate_passed', { title: fateCard?.title || '' });
      }
      return startNight(ctx, intent);
    }
    case 'night': {
      if (s.night?.home) return { ok: false, reason: 'HOME_NIGHT' };
      const r = applyNightAction(ctx, intent);
      if (r.ok && s.night && !s.night.home) {
        s.night.atFork = false; // 手动作答 = 玩家接过了这个岔路（收尾段可继续自走）
        ctx.emit('NIGHT_PATCH', { room: s.night.room, slots: s.night.slots, noise: s.night.noise, pack: [...s.night.pack], packSlots: s.night.packSlots, observed: { ...s.night.observed }, unlocked: { ...s.night.unlocked }, cleared: { ...s.night.cleared }, sawed: { ...s.night.sawed }, lowSlotsAck: !!s.night.lowSlotsAck, atFork: false, micro: !!s.night.micro, ...(s.night.directive ? { directive: s.night.directive } : {}) });
      }
      return r;
    }
    case 'policy': {
      // 日常委托策略（§5.3）：持久化在 state.policy，经 FLAG 事件回放（fold 通用镜像）
      if (!(intent.key in DEFAULT_POLICY)) return { ok: false, reason: 'BAD_POLICY' };
      const next = { ...policyOf(s), [intent.key]: intent.value };
      ctx.setFlag('policy', next);
      ctx.fact('policy_set', { key: intent.key, value: intent.value });
      return { ok: true };
    }
    case 'direction': {
      // 念头（v3 命运导演）：介于命令与规矩之间的第三种动词——种下方向，不立即执行。
      // 显形由三处延迟消化：晨间回声（causality）、命运导演锚池（ge）、叙事者简报。
      const text = String(intent.text).trim().slice(0, 60);
      const subject = intent.subject && s.chars.some((c) => c.id === intent.subject && c.alive) ? intent.subject : null;
      const alive = Object.values(s.directions || {}).filter((d) => d.alive);
      const same = alive.find((d) => d.subject === subject && d.text === text);
      if (same) { // 再说一遍 = 浇水：延缓枯萎，不重种
        same.lastDay = s.day;
        ctx.setFlag('directions', structuredClone(s.directions));
        ctx.fact('direction_watered', { id: same.id, subject, text });
        return { ok: true };
      }
      if (alive.length >= 3) { // 数量上限：念头不是任务清单，最老的让位
        const oldest = [...alive].sort((a, b) => a.lastDay - b.lastDay)[0];
        oldest.alive = false;
        ctx.fact('direction_faded', { id: oldest.id, subject: oldest.subject, text: oldest.text });
      }
      const id = `d${s.day}_${Object.keys(s.directions || {}).length + 1}`;
      s.directions[id] = { id, subject, text, day: s.day, lastDay: s.day, alive: true };
      ctx.setFlag('directions', structuredClone(s.directions));
      ctx.fact('direction_set', { id, subject, text });
      return { ok: true };
    }
    case 'scene': {
      // 戏文轨（stage-play）：说得出口但内核没有的事——先落一拍请求，
      // 零机械变化；舞台导演（LLM）随后接戏：写一段当场戏文 + 白名单微效果
      const text = String(intent.text || '').trim().slice(0, 80);
      if (!text) return { ok: false, reason: 'EMPTY' };
      ctx.fact('scene_request', { text });
      return { ok: true };
    }
    case 'whisper': {
      // 未被接住的话（离谱输入兜底）：进素材环，命运导演可据此长出回应卡——世界什么都听着
      const text = String(intent.text || '').trim().slice(0, 60);
      if (!text) return { ok: false, reason: 'EMPTY' };
      const ring = [...(s.whispers || []), { day: s.day, text }].slice(-3);
      s.whispers = ring;
      ctx.setFlag('whispers', structuredClone(ring));
      ctx.fact('whisper_kept', { text });
      return { ok: true };
    }
    case 'trade_op':
      if (s.phase !== 'day' || !s.franko) return { ok: false, reason: 'NO_MERCHANT' };
      return executeTrade(ctx, intent);
    case 'event_choice': {
      const r = chooseEventOption(ctx, intent.option);
      // 序章：一选一拍，选完进下一拍，拍完落地第 1 天
      if (r.ok && s.phase === 'prologue') firePreludeBeat(ctx, (s.prelude?.i ?? 0) + 1);
      return r;
    }
    case 'advance': {
      if (s.phase === 'prologue') { firePreludeBeat(ctx, (s.prelude?.i ?? 0) + 1); return { ok: true }; }
      if (s.phase === 'day') { toDusk(ctx); return { ok: true }; }
      if (s.phase === 'night' && !s.night?.home) { endNightReturn(ctx, 'advance'); return { ok: true }; }
      return { ok: false, reason: 'BAD_PHASE' };
    }
    case 'skip_prelude': {
      if (s.phase !== 'prologue') return { ok: false, reason: 'BAD_PHASE' };
      endPrologue(ctx, true);
      return { ok: true };
    }
    case 'prelude_full': {
      // 翻全卷（叙事双轴 §2.4）：单句版展开为完整三幕——从「天下」重读；
      // 已作答的卡不重复（旗标与因果账已入册），正展示未作答的卡退回重演。
      if (s.phase !== 'prologue' || (s.preludeMode || 'full') !== 'short') return { ok: false, reason: 'BAD_PHASE' };
      if (s.activeEvent?.cardId && s.firedOnce[s.activeEvent.cardId]) {
        delete s.firedOnce[s.activeEvent.cardId];
        ctx.emit('FLAG', { key: 'firedOnce', val: structuredClone(s.firedOnce) });
      }
      ctx.setFlag('preludeMode', 'full');
      ctx.fact('prelude_full', {});
      firePreludeBeat(ctx, 0);
      return { ok: true };
    }
    case 'meta':
      ctx.fact('meta', { query: intent.query });
      return { ok: true };
    default:
      return { ok: false, reason: 'BAD_TYPE' };
  }
}

/** 序章节拍引擎（叙事双轴-v0.1 §2）：文本幕 advance 翻页、卡拍 event_choice 推进；
 *  老存档（无 prelude 指针）自愈——已烧掉的卡拍自动跳过。 */
function firePreludeBeat(ctx, from) {
  const s = ctx.s;
  const beats = preludeBeats(ctx.pack, s);
  let i = from;
  while (i < beats.length && beats[i].t === 'card' && s.firedOnce[beats[i].id]) i++;
  if (i >= beats.length) { endPrologue(ctx); return; }
  s.prelude = { i };
  ctx.emit('PRELUDE_BEAT', { i });
  const b = beats[i];
  if (b.t === 'card') {
    s.firedOnce[b.id] = true;
    ctx.emit('FLAG', { key: 'firedOnce', val: structuredClone(s.firedOnce) });
    s.activeEvent = { cardId: b.id };
    ctx.emit('EVENT_FIRED', { cardId: b.id });
    ctx.fact('prologue_beat', { cardId: b.id, title: ctx.pack.cardMap[b.id]?.title });
  } else {
    s.activeEvent = null; // 文本幕接管（翻全卷会从卡拍跳回天下，旧卡必须卸下）
    ctx.fact('prelude_beat', { kind: b.t, id: b.id });
  }
}

/** 序章落幕：落地第 1 天白天；D1 的大事步与序章落定同拍（叙事双轴 §4.3） */
function endPrologue(ctx, skipped = false) {
  const s = ctx.s;
  s.phase = 'day';
  ctx.emit('PHASE', { to: 'day' });
  ctx.fact(skipped ? 'prologue_skipped' : 'prologue_end', { day: s.day, weather: s.weather });
  mainlineTick(ctx);
}

/** 开局第一批 + 序章首拍（若有） */
export function beginRun(state, pack, { prologue = false } = {}) {
  const events = [{ i: 0, day: 1, t: 'RUN_STARTED', d: { state: structuredClone(state) } }];
  const facts = [];
  const ctx = new Ctx(state, pack, events, facts);
  if (prologue && state.phase === 'prologue') {
    ctx.fact('prologue_start', {});
    firePreludeBeat(ctx, 0);
  } else {
    ctx.emit('PHASE', { to: 'day' });
    ctx.fact('run_started', { day: 1, chars: state.chars.map((c) => c.name).join('、') });
    // 别传 D1 日更卡（主线 D1 无晨抽，别传的开场牌即是第一天）
    if (state.sidestory) {
      const card = pack.cards.find((c) => c.side === state.sidestory.id && c.kind === 'timeline' && (c.when?.dayWindow || [])[0] === 1);
      if (card) {
        state.firedOnce[card.id] = true;
        state.activeEvent = { cardId: card.id };
        ctx.emit('EVENT_FIRED', { cardId: card.id });
        ctx.fact('event', { cardId: card.id, title: card.title });
      }
    }
    mainlineTick(ctx); // 主线 D1 大事步（无序章开局与序章落幕同拍）
  }
  ctx.emit('CURSOR', { to: state.rngCursor });
  return { state, events, facts };
}

function toDusk(ctx) {
  const s = ctx.s;
  if (s.phase !== 'day') return;
  s.phase = 'dusk';
  s.night = null;
  ctx.emit('PHASE', { to: 'dusk' });
  ctx.fact('phase_dusk', {});
}

/** 破晓管线（PH-02）：袭击 → 日进(快照) → 六轴 tick → 战争 → 事件抽取 → 回白天 */
function toDawn(ctx) {
  const s = ctx.s;
  if (s.phase !== 'dawn' && s.phase !== 'night') return;
  resolveRaid(ctx);
  advanceDay(ctx);           // day++、天气、AP、商人、DAY_STARTED 快照
  tickHunger(ctx);
  tickHealth(ctx);
  tickFatigue(ctx);
  tickTemperature(ctx);
  tickMood(ctx);
  tickAutonomous(ctx);       // CY-23 因果自主行为（辛夷/文简/薄姑）
  tickDirections(ctx);       // v3 念头晨间结算（回声/枯萎）
  tickProduction(ctx);
  tickWar(ctx);
  drawMorningEvents(ctx);
  mainlineTick(ctx);      // 大事轴日步：破晓选步＋闲笔＋投影（叙事双轴 §4.3）
  ensembleTick(ctx);      // 堂屋（人物血肉计划 PR2）：主线日必评史＋随机场，内核先裁决结局拍
  tickDawnLedgers(ctx);   // 晨报衰减账/知晓度里程碑账（批次二 C-3/体验9；FLAG 镜像可回放）
  s.phase = 'day';
  ctx.emit('PHASE', { to: 'day' });
  ctx.fact('phase_day', { day: s.day, weather: s.weather });
}

export { buildEnding };

/** 方针夜循环：auto 探索；岔路与事件不停问，按立场自动应答（种子随机，确定性可回放） */
function runDirectiveNight(ctx, rejects, stance) {
  const s = ctx.s;
  let guard = 0;
  while (s.phase === 'night' && s.night && !s.night.home && guard++ < 48) {
    if (s.activeEvent) { // 夜里触发的事件卡：按立场自动应
      const card = ctx.pack.cardMap[s.activeEvent.cardId] || s.geCards?.[s.activeEvent.cardId];
      const opt = card ? pickEventOptionByStance(card, ctx, stance) : null;
      if (!opt) break;
      ctx.fact('night_choice', { why: stance, label: opt.label });
      ctx.delegated = true;
      const r = applyOne(ctx, { type: 'event_choice', option: opt.key, delegated: true });
      ctx.delegated = false;
      if (r && r.ok === false) break;
      continue;
    }
    const step = planNightStep(s, ctx.pack, { approach: stance });
    if (!step) { // 搜尽——回家
      ctx.delegated = true;
      applyOne(ctx, { type: 'night', action: 'retreat', delegated: true });
      ctx.delegated = false;
      break;
    }
    if (step.stop) { // 岔路：不停问，按立场选路
      if (step.stop.kind === 'event') break;
      ctx.fact('night_fork', { kind: step.stop.kind, text: step.stop.text, options: step.stop.options.map((o) => o.label) });
      const opt = pickForkOptionByStance(step.stop.options, stance);
      ctx.fact('night_choice', { why: stance, label: opt.label });
      ctx.delegated = true;
      for (const it of opt.intents) applyOne(ctx, { ...it, delegated: true });
      ctx.delegated = false;
      continue;
    }
    ctx.delegated = true;
    const r = applyOne(ctx, { ...step.intent, delegated: true });
    ctx.delegated = false;
    if (r && r.ok === false) break;
  }
}

/** 岔路选项按立场排序挑选（确定性：平分取先出现者） */
function pickForkOptionByStance(options, stance) {
  const PRIORITY = {
    // 谨慎 =「见人就绕」：遇人先绕开（ignore）接着翻；绕不开（敌意无绕行项）才撤；
    // 火柴见底、有人警觉也是先撤——撤退仍然排在硬撑（push_on）前面
    cautious: ['ignore', 'retreat', 'push_on', 'dialogue', 'attack', 'backstab'],
    normal: ['dialogue', 'ignore', 'retreat', 'push_on', 'attack', 'backstab'],
    bold: ['backstab', 'attack', 'push_on', 'dialogue', 'ignore', 'retreat']
  };
  const rank = (o) => {
    let best = 99;
    for (const it of o.intents || []) {
      if (it.type !== 'night') continue;
      const i = PRIORITY[stance].indexOf(it.action);
      if (i >= 0 && i < best) best = i;
    }
    return best === 99 ? 50 : best; // 无夜间动作的选项（如纯撤退包装）居中
  };
  return [...options].sort((a, b) => rank(a) - rank(b))[0] || options[0];
}

/** 事件卡按立场自动应：谨慎挑无代价无风险项，放手挑有收益/敢冒险的项。
 *  弃夜选项（effects.abortNight）是"就此收工"的保底，不是立场首选——
 *  只有别无可行项时才自动撤（否则照常/谨慎方针在南市首访会"到达即退出"，整夜零探索）。 */
function pickEventOptionByStance(card, ctx, stance) {
  const opts = (card.options || []).filter((o) => optionAvailable(ctx, o) && optionCostOk(ctx, o));
  if (!opts.length) return null;
  const risk = (o) => (o.riskCheck ? 1 : 0) + (o.cost?.length ? 1 : 0);
  const gain = (o) => Object.keys(o.effects?.items || {}).length;
  const stay = opts.filter((o) => !o.effects?.abortNight);
  const pool = stay.length ? stay : opts;
  const pick = stance === 'cautious' ? pool.sort((a, b) => risk(a) - risk(b))[0]
    : stance === 'bold' ? pool.sort((a, b) => (gain(b) - gain(a)) || (risk(b) - risk(a)))[0]
    : pool.find((o) => risk(o) === 0) || pool.sort((a, b) => risk(a) - risk(b))[0];
  return pick || null;
}
