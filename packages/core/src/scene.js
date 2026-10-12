// 戏文结算（stage-play）：舞台导演的微效果提案在此落地——
// 全部走既有白名单（心情 ±1/±2、声望 ±1、种念头），经 Ctx 记账，fold 天然镜像。
// 铁律不变：LLM 只提案，内核裁决；提案越界即整份丢弃（不降档、不折衷）。
import { Ctx } from './ctx.js';

const CAPS = { moodAll: [-1, 1], moodChar: [-2, 2], reputation: [-1, 1] };
const REP_KEYS = ['neighbor', 'church', 'hospital', 'market'];

/** 校验并应用舞台导演的微效果提案。返回 {ok, reasons, events, facts}；越界即拒。 */
export function applySceneEffects(state, pack, eff) {
  const reasons = [];
  if (!eff || typeof eff !== 'object') return { ok: false, reasons: ['无提案'], events: [], facts: [] };
  const moodAll = eff.mood_all;
  const moodChar = eff.mood_char;
  const rep = eff.reputation;
  const seed = eff.seed;
  if (moodAll !== undefined && (typeof moodAll !== 'number' || moodAll < CAPS.moodAll[0] || moodAll > CAPS.moodAll[1])) reasons.push('mood_all 越带');
  if (moodChar !== undefined) {
    const c = moodChar && pack.characters.find((x) => x.name === moodChar.name && state.chars.some((y) => y.id === x.id && y.alive));
    if (!c) reasons.push('mood_char 对象不在队');
    else if (typeof moodChar.n !== 'number' || moodChar.n < CAPS.moodChar[0] || moodChar.n > CAPS.moodChar[1]) reasons.push('mood_char 越带');
  }
  if (rep !== undefined && (!REP_KEYS.includes(rep.key) || typeof rep.n !== 'number' || Math.abs(rep.n) > 1)) reasons.push('reputation 越带');
  if (seed !== undefined && (typeof seed.text !== 'string' || !seed.text.trim() || seed.text.length > 60)) reasons.push('seed 不合法');
  if (reasons.length) return { ok: false, reasons, events: [], facts: [] };

  const events = [], facts = [];
  const ctx = new Ctx(state, pack, events, facts);
  if (typeof moodAll === 'number' && moodAll !== 0) ctx.moodAll(moodAll, '戏文');
  if (moodChar) {
    const c = state.chars.find((x) => pack.charMap[x.id]?.name === moodChar.name && x.alive);
    if (c) ctx.moodRaw(c, moodChar.n, '戏文');
  }
  if (rep) ctx.reputation(rep.key, rep.n);
  if (seed && seed.text) {
    const alive = state.chars.filter((c) => c.alive);
    const subject = seed.subject && state.chars.some((c) => c.id === seed.subject && c.alive) ? seed.subject : null;
    const same = Object.values(state.directions || {}).find((d) => d.alive && d.subject === subject && d.text === seed.text);
    if (same) { same.lastDay = state.day; }
    else {
      const alive_dirs = Object.values(state.directions || {}).filter((d) => d.alive);
      if (alive_dirs.length >= 3) {
        const oldest = [...alive_dirs].sort((a, b) => a.lastDay - b.lastDay)[0];
        oldest.alive = false;
        ctx.fact('direction_faded', { id: oldest.id, subject: oldest.subject, text: oldest.text });
      }
      const id = `d${state.day}_${Object.keys(state.directions || {}).length + 1}`;
      state.directions[id] = { id, subject, text: seed.text.slice(0, 60), day: state.day, lastDay: state.day, alive: true };
      ctx.fact('direction_set', { id, subject, text: seed.text.slice(0, 60) });
    }
    ctx.setFlag('directions', structuredClone(state.directions));
  }
  ctx.done();
  return { ok: true, reasons: [], events, facts };
}
