// 测试助手：固定种子、固定阵容、快速推进。
import { loadPack, createRun, beginRun, resolveInput } from '../packages/core/index.js';

export const PACK = loadPack();

export function newRun({ seed = 100, roster = ['anton', 'marta', 'bron'], difficulty = 'documentary', prologue = false, preludeMode = 'full', sidestory = null } = {}) {
  const state = createRun(PACK, { seed, roster: sidestory ? null : roster, difficulty, prologue, preludeMode, sidestory });
  const { events, facts } = beginRun(state, PACK, { prologue });
  return { state, events, facts };
}

export function step(state, intents) {
  return resolveInput(state, PACK, intents);
}

/** 快速过完一天（无外出） */
export function skipDayAtHome(state, dayActs = []) {
  let s = state;
  if (s.phase === 'day') {
    const r = step(s, [...dayActs, { type: 'advance' }]);
    s = r.state;
  }
  if (s.phase === 'dusk') {
    const r = step(s, [{ type: 'dusk_assign', scavenger: null, others: {} }]);
    s = r.state;
  }
  return s;
}

export function ch(state, id) { return state.chars.find((c) => c.id === id); }
