// 封印注入协议（GDD §11.4 / 正典圣经 §7）：
// 正典秘密不进任何常规上下文；触发条件满足时内核解锁，SEAL_UNLOCKED 事件入流（fold 可重放）。
// 模型在条件未满足时真的不知道——玩家套话套不出来；条件满足后揭示永远与正典一致。

export function sealMet(s, t) {
  if (!t) return false;
  if (t.doc && !s.docsSeen.includes(t.doc)) return false;
  if (t.flag && !s.eventFlags[t.flag]) return false;
  if (t.knowledge && s.knowledge < t.knowledge) return false;
  if (t.docs && s.docsSeen.length < t.docs) return false;
  return true;
}

/** 每批意图结算后调用一次（resolve 管线尾部） */
export function evaluateSeals(ctx) {
  const s = ctx.s;
  if (!s.seals) s.seals = [];
  for (const seal of ctx.pack.seals || []) {
    if (s.seals.includes(seal.id)) continue;
    if (!sealMet(s, seal.trigger)) continue;
    s.seals.push(seal.id);
    ctx.emit('SEAL_UNLOCKED', { id: seal.id, layer: seal.layer });
    ctx.fact('seal_unlock', { id: seal.id, layer: seal.layer, text: seal.text });
  }
}

/** 已显形真相的文本（裁判/回忆录的上下文注入——只有解锁的） */
export function unlockedSealTexts(state, pack) {
  return (state.seals || []).map((id) => pack.sealMap?.[id]).filter(Boolean);
}
