// 内核对外出口（分层边界：core 是零 I/O 纯函数包）。
export { Rng, clamp, hashStr } from './src/rng.js';
export { loadPack, loadPrompt, DEFAULT_PACK_DIR } from './src/content.js';
export {
  createRun, newChar, moodLevel, apMaxOf, combatModOf, aliveChars, charById, homeValue, bestWeapons,
  MOOD_LEVELS, HUNGER_NAMES, HARM_NAMES, SICK_NAMES, FATIGUE_NAMES, difficultyCfg,
  DEFAULT_POLICY, policyOf
} from './src/state.js';
export { Ctx } from './src/ctx.js';
export {
  tickHunger, tickHealth, tickFatigue, tickTemperature, tickMood, tickProduction, tickWar, advanceDay, drawMorningEvents
} from './src/vitals.js';
export { applyDayAction, DAY_ACTIONS, lootContainer, findDoc, docAvailable } from './src/dayActions.js';
export { startNight, applyNightAction, endNightReturn } from './src/night.js';
export { resolveRaid } from './src/raid.js';
export { genFrankoStock, sellPrice, executeTrade } from './src/trade.js';
export { chooseEventOption, buildEnding, optionAvailable } from './src/events.js';
export { resolveInput, beginRun, validateIntentShape } from './src/resolve.js';
export { fold } from './src/fold.js';
export { parseDirect } from './src/parser.js';
export { planDay, planDusk, planNightStep, dawnProblems, tradeDeals, suggests, charDigest } from './src/delegate.js';
export {
  VERBS, recordCausal, addPrivateNote, eventVerb, tickAutonomous, slumberGuard, denyFoodCount,
  valenceOf, charArc, pairKey, pairStage, bondStage, alienated, stageOf, STAGE_NAMES
} from './src/causality.js';
export { buildStoryline, renderMemoirDirect, memoirLint } from './src/storyline.js';
export { evaluateSeals, sealMet, unlockedSealTexts } from './src/seals.js';
