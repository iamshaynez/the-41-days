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
import { chooseEventOption } from './events.js';
import { tickHunger, tickHealth, tickFatigue, tickTemperature, tickMood, tickProduction, tickWar, advanceDay, drawMorningEvents } from './vitals.js';
import { tickAutonomous } from './causality.js';
import { evaluateSeals } from './seals.js';
import { buildEnding } from './events.js';
import { planDay, planNightStep } from './delegate.js';

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
    case 'policy': return typeof intent.key === 'string';
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
      // 门口有未决事件时不自动收工——留给玩家先应门
      if (!state.activeEvent && planned.length) queue.push({ type: 'advance', delegated: true });
      continue;
    }
    if (intent.type === 'auto_night') {
      runAutoNight(ctx, rejects, intent);
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
      ctx.fact('night_fork', { kind: step.stop.kind, text: step.stop.text, options: step.stop.options.map((o) => o.label) });
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
  // 序章守卫：闪回里只有"选哪个"是合法的（PH-03：阶段推进只由内核驱动）
  if (s.phase === 'prologue' && intent.type !== 'event_choice' && intent.type !== 'meta') {
    ctx.fact('in_prologue', {});
    return { ok: false, reason: 'IN_PROLOGUE' };
  }
  switch (intent.type) {
    case 'act':
      return applyDayAction(ctx, intent);
    case 'dusk_assign': {
      if (s.phase !== 'dusk') return { ok: false, reason: 'NOT_DUSK' };
      return startNight(ctx, intent);
    }
    case 'night': {
      if (s.night?.home) return { ok: false, reason: 'HOME_NIGHT' };
      const r = applyNightAction(ctx, intent);
      if (r.ok && s.night && !s.night.home) {
        ctx.emit('NIGHT_PATCH', { room: s.night.room, slots: s.night.slots, noise: s.night.noise, pack: [...s.night.pack], packSlots: s.night.packSlots, observed: { ...s.night.observed }, unlocked: { ...s.night.unlocked }, cleared: { ...s.night.cleared }, sawed: { ...s.night.sawed }, lowSlotsAck: !!s.night.lowSlotsAck });
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
    case 'trade_op':
      if (s.phase !== 'day' || !s.franko) return { ok: false, reason: 'NO_MERCHANT' };
      return executeTrade(ctx, intent);
    case 'event_choice': {
      const r = chooseEventOption(ctx, intent.option);
      // 序章：一选一拍，选完进下一拍，拍完落地第 1 天
      if (r.ok && s.phase === 'prologue') firePrologueNext(ctx);
      return r;
    }
    case 'advance': {
      if (s.phase === 'day') { toDusk(ctx); return { ok: true }; }
      if (s.phase === 'night' && !s.night?.home) { endNightReturn(ctx, 'advance'); return { ok: true }; }
      return { ok: false, reason: 'BAD_PHASE' };
    }
    case 'meta':
      ctx.fact('meta', { query: intent.query });
      return { ok: true };
    default:
      return { ok: false, reason: 'BAD_TYPE' };
  }
}

/** 序章逐拍推进（kind: prologue 按 seq 排序，once 烧掉）；拍完落到第 1 天白天 */
function firePrologueNext(ctx) {
  const s = ctx.s;
  const next = ctx.pack.cards
    .filter((c) => c.kind === 'prologue')
    .sort((a, b) => (a.seq || 0) - (b.seq || 0))
    .find((c) => !s.firedOnce[c.id]);
  if (!next) {
    s.phase = 'day';
    ctx.emit('PHASE', { to: 'day' });
    ctx.fact('prologue_end', { day: s.day, weather: s.weather });
    return;
  }
  s.firedOnce[next.id] = true;
  ctx.emit('FLAG', { key: 'firedOnce', val: structuredClone(s.firedOnce) });
  s.activeEvent = { cardId: next.id };
  ctx.emit('EVENT_FIRED', { cardId: next.id });
  ctx.fact('prologue_beat', { cardId: next.id, title: next.title });
}

/** 开局第一批 + 序章首拍（若有） */
export function beginRun(state, pack, { prologue = false } = {}) {
  const events = [{ i: 0, day: 1, t: 'RUN_STARTED', d: { state: structuredClone(state) } }];
  const facts = [];
  const ctx = new Ctx(state, pack, events, facts);
  if (prologue && state.phase === 'prologue') {
    ctx.fact('prologue_start', {});
    firePrologueNext(ctx);
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
  tickProduction(ctx);
  tickWar(ctx);
  drawMorningEvents(ctx);
  s.phase = 'day';
  ctx.emit('PHASE', { to: 'day' });
  ctx.fact('phase_day', { day: s.day, weather: s.weather });
}

export { buildEnding };
