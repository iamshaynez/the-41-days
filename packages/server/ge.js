// C 层生成事件导演（内核设计-v0.2 §8.8 GE）：预取-验证-注入三段。
// 破晓后异步提案 → 验证器四重门（预算/锚/防火墙/指纹）→ 白天任一输入边界注入。
// GE-13：LLM 不在线，C 层整体关闭，游戏完整可玩。
import { validateProposal, proposalToCard, anchorPool } from '../core/src/ge.js';
import { playwright } from '../llm/gateway.js';
import { worldBrief } from './narrate.js';

export function createGeDirector({ pack, prompts, getProvider, log = () => {} }) {
  const cache = new Map(); // runId -> { ready:boolean, card?, fingerprint? } | Promise

  async function generate(runId, state) {
    const provider = getProvider();
    if (!provider || !pack.ge) return null;
    const theme = pack.ge.themeWheel[state.day % pack.ge.themeWheel.length];
    if (theme === '沉默日') return null; // GE-07：留白也是节奏
    try {
      const anchors = anchorPool(pack, state);
      const p = await playwright({ provider, prompts }, { theme, anchors, worldBrief: worldBrief(state, pack) });
      if (!p) return null;
      const v = validateProposal(pack, state, p, { anchors });
      if (!v.ok) { log('ge_reject', { runId, reasons: v.reasons }); return null; }
      return { card: proposalToCard(pack, state, p), fingerprint: v.fingerprint };
    } catch (e) {
      log('ge_error', { runId, error: String(e?.message || e) });
      return null;
    }
  }

  return {
    /** 每个输入边界调用：先看在路上的生成能不能落地，再为下一回合预取 */
    async onTurn(runId, state) {
      if (!pack.ge) return;
      let cached = cache.get(runId);
      if (cached?.promise) { // 在路上的生成：等它一下（一个回合边界之内）
        cached = await cached.promise.catch(() => null);
        cache.delete(runId);
      }
      // 注入：白天且门口没有未决事件时才落（不抢手作卡的位置）
      const watchedDay = state.closureClosed && (state.geLastDay || 0) > 0 && state.day - state.geLastDay < 2; // §3.6 守望档：合上兰台后隔天至多一张
      if (cached?.card && !state.activeEvent && state.phase === 'day' && !state.over && !watchedDay) {
        state.geCards = { ...(state.geCards || {}), [cached.card.id]: cached.card };
        state.geFingers = { ...(state.geFingers || {}), [cached.fingerprint]: state.day };
        state.geShown = (state.geShown || 0) + 1;
        state.geLastDay = state.day;
        state.activeEvent = { cardId: cached.card.id, generated: true };
      }
      // 预取下一张（后台；GE-13：LLM 不在线则整层静默）
      if (getProvider() && !state.over && state.phase === 'day' && !state.activeEvent) {
        cache.set(runId, { promise: generate(runId, state) });
      }
    },
    /** 终局/封局清理 */
    drop(runId) { cache.delete(runId); }
  };
}
