// C 层生成事件导演（内核设计-v0.2 §8.8 GE）：预取-验证-注入三段。
// 破晓后异步提案 → 验证器四重门（预算/锚/防火墙/指纹）→ 白天任一输入边界注入。
// GE-13：LLM 不在线，C 层整体关闭，游戏完整可玩。
// v3 命运导演：随进度解锁的命运弧（ge.json arcs）按弧提案；at:'dusk' 的弧驻场黄昏，
// 与管家方案卡同屏（duskFate），玩家可以答、也可以直接出门让它过去。
import { validateProposal, proposalToCard, anchorPool, normalizeProposal } from '../core/src/ge.js';
import { playwright } from '../llm/gateway.js';
import { worldBrief } from './narrate.js';

/** 当前可用的命运弧（每局一次、按 when 解锁，高档位优先） */
export function currentArc(pack, state) {
  const arcs = pack.ge?.arcs || [];
  return arcs
    .filter((a) => !state.geArcsFired?.[a.id])
    .filter((a) => {
      const w = a.when || {};
      if (w.minDay && state.day < w.minDay) return false;
      if (w.maxDay && state.day > w.maxDay) return false;
      if (w.dayWindow && (state.day < w.dayWindow[0] || state.day > w.dayWindow[1])) return false;
      return true;
    })
    .sort((a, b) => (b.tier || 0) - (a.tier || 0))[0] || null;
}

/** 物品 id 清单（提示词 {{items}}）：id(中文名) 逐个列出——编剧没有这张单子就会
 *  拿中文名当 id 写，验证器整张拒（一周目实测 45 天零注入的根因之一）。 */
export function itemLegend(pack) {
  return (pack.items || []).map((i) => `${i.id}(${i.name})`).join('、');
}

/** 待卡最长滞留天数：跨过一个黄昏是设计内的（白天预取→次日注入），
 *  超过两天世界已变样，弃。 */
const CARD_MAX_AGE_DAYS = 2;
/** 在途预取的等待上限：超时把 promise 留在缓存里下回合再收——
 *  玩家的输入请求绝不为编剧的慢笔买单（一周目实测单步 118s 的根因）。 */
const PREFETCH_WAIT_MS = 1500;
const WAITED = Symbol('waited');

export function createGeDirector({ pack, prompts, getProvider, log = () => {} }) {
  const cache = new Map(); // runId -> { card?, fingerprint?, arcId?, bornDay? } | { promise }

  async function generate(runId, state) {
    const provider = getProvider();
    if (!provider || !pack.ge) return null;
    const arc = currentArc(pack, state);
    const theme = arc ? arc.theme : pack.ge.themeWheel[state.day % pack.ge.themeWheel.length];
    if (theme === '沉默日') return null; // GE-07：留白也是节奏
    try {
      const anchors = anchorPool(pack, state);
      const p = await playwright({ provider, prompts }, { theme, anchors: anchors.slice(0, 24), worldBrief: worldBrief(state, pack), arc, itemLegend: itemLegend(pack) });
      if (!p) return null;
      const n = normalizeProposal(pack, p); // 中文名物品 → id（宽容面：写得对不上再拒）
      const v = validateProposal(pack, state, n, { anchors, arc });
      if (!v.ok) { log('ge_reject', { runId, reasons: v.reasons }); return null; }
      return { card: proposalToCard(pack, state, n, { arc }), fingerprint: v.fingerprint, arcId: arc?.id || null, bornDay: state.day };
    } catch (e) {
      log('ge_error', { runId, error: String(e?.message || e) });
      return null;
    }
  }

  return {
    /** 每个输入边界调用：先看在路上的生成能不能落地，再为下一回合预取。
     *  卡片滞留：白天预取的普通卡在下一次输入（多半已收卷入黄昏）不能注入——
     *  不丢弃，留在缓存里等次日白天的输入边界（旧版到黄昏即丢卡，与物品 id
     *  拒收叠加成"命运导演整局零注入"）。 */
    async onTurn(runId, state) {
      if (!pack.ge) return;
      let cached = cache.get(runId);
      if (cached?.promise) { // 在途的生成：至多等一小会儿，超时留给下一回合
        const raced = await Promise.race([
          cached.promise.then((r) => r, () => null),
          new Promise((r) => setTimeout(() => r(WAITED), PREFETCH_WAIT_MS))
        ]);
        if (raced === WAITED) {
          cached = null; // promise 仍留在 cache（不 delete 不覆盖），下回合接着收
        } else {
          cached = raced;
          cache.delete(runId);
        }
      }
      // 别传局不注入 C 层生成卡（CH-04 是 A 层手作场：樊城不说江陵话）
      if (state.sidestory) { cache.delete(runId); return; }
      // 注入：白天（普通卡）；黄昏（at:'dusk' 的命运弧，与黄昏方案卡同屏）
      const watchedDay = state.closureClosed && (state.geLastDay || 0) > 0 && state.day - state.geLastDay < 2; // §3.6 守望档：合上兰台后隔天至多一张
      const atDusk = cached?.card?.at === 'dusk';
      const notStale = !!cached?.card && state.day - (cached.bornDay ?? state.day) <= CARD_MAX_AGE_DAYS;
      // 注入侧配额（GE-02）：验证器只在生成时核配额——生成通过后玩家每个输入边界
      // 都可能撞上注入窗口，注入自身必须再核一遍（验证局实测：同一天连环注入 286 张）
      const quotaOk = !((state.geShown || 0) >= 1 && state.day - (state.geLastDay || 0) < 1);
      const totalFired = Object.keys(state.firedOnce || {}).length + (state.geShown || 0);
      const shareOk = (state.geShown || 0) + 1 <= Math.max(1, Math.floor(Math.max(totalFired, 1) * (pack.ge.budget.maxShareOfEvents ?? 0.25)));
      const fpSeen = cached?.fingerprint ? state.geFingers?.[cached.fingerprint] : undefined;
      const fpOk = !!cached?.card && (!fpSeen || state.day - fpSeen >= (pack.ge.cooldownDays ?? 7));
      const injectable = notStale && quotaOk && shareOk && fpOk
        && !state.activeEvent && !state.over && !watchedDay
        && ((state.phase === 'day' && !atDusk) || (state.phase === 'dusk' && atDusk));
      if (injectable) {
        cache.delete(runId); // 卡已消费——缓存里不能再留它（否则毒化后续回合）
        state.geCards = { ...(state.geCards || {}), [cached.card.id]: cached.card };
        state.geFingers = { ...(state.geFingers || {}), [cached.fingerprint]: state.day };
        state.geShown = (state.geShown || 0) + 1;
        state.geLastDay = state.day;
        if (cached.arcId) { // 命运弧每局一次：注入即烧掉（拒答 = 你路过了命运）
          state.geArcsFired = { ...(state.geArcsFired || {}), [cached.arcId]: state.day };
          state.activeEvent = { cardId: cached.card.id, generated: true, duskFate: atDusk };
        } else {
          state.activeEvent = { cardId: cached.card.id, generated: true };
        }
      } else if (cached?.card && notStale && fpOk && !state.activeEvent && !state.over) {
        // 留到下一个边界：相位不符，或当日配额已用（配额次日自动解除，卡不该为此作废）
        cache.set(runId, cached);
      } else if (cached?.card) {
        cache.delete(runId); // 陈卡/指纹冷却中的卡：弃（不留缓存）
      }
      // 预取下一张（后台；GE-13：LLM 不在线则整层静默）。黄昏也预取——
      // 否则 at:'dusk' 的命运弧永远凑不齐"预取在途→下一输入注入"的窗口
      if (getProvider() && !state.over && !state.activeEvent
        && (state.phase === 'day' || state.phase === 'dusk') && !cache.get(runId)) {
        cache.set(runId, { promise: generate(runId, state) });
      }
    },
    /** 终局/封局清理 */
    drop(runId) { cache.delete(runId); }
  };
}
