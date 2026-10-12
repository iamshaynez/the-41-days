// 因果引擎（因果引擎-v0.1.md §1~§6）：条目/见证/解算/弧线/自主行为。
// 铁律：引擎只组织已发生的事实，永不发明；全程确定性——无随机数（CY-35），
// 唯一通道是 recordCausal → CAUSAL 事件（fold.js 镜像，属性测试守恒）。
import { aliveChars, charById } from './state.js';

// —— 动词表（CY-04/CY-05）：w=默认重量，val=基础读数，ethics=伦理乘区（M-10），
//    ethicsInv=负向读数 × 正向伦理（拒助之于心软者），pair=是否构筑角色间信任弧 ——
export const VERBS = {
  feed:           { w: 0.5, val: 0.5 },
  deny_food:      { w: 1,   val: -2 },
  burn_book:      { w: 1,   val: -0.5 },
  heal:           { w: 2,   val: 1.5, pair: true },
  comfort:        { w: 1,   val: 0.5, pair: true },
  help:           { w: 2,   val: 2,   ethics: 'help' },
  donate:         { w: 2.5, val: 2,   ethics: 'help' },
  refuse_help:    { w: 1.5, val: -1.5, ethicsInv: 'help' },
  steal_civ:      { w: 3,   val: -4,  ethics: 'stealCiv' },
  kill_civ:       { w: 8,   val: -8,  ethics: 'killCiv' },
  kill_enemy:     { w: 2,   val: -0.5, ethics: 'killEnemy' },
  spare:          { w: 2,   val: 1.5 },
  volunteer:      { w: 1,   val: 0.5 },
  guard_night:    { w: 0.5, val: 0.3 },
  play_music:     { w: 1.5, val: 1 },
  listen_radio:   { w: 0.2, val: 0.2 },
  trade_evidence: { w: 4,   val: -2,  tags: ['truth'] },
  witness_death:  { w: 5,   val: -4 },
  launch_lighthouse: { w: 6, val: 2 },
  join_table:     { w: 6,   val: -3 },
  refuse_table:   { w: 4,   val: 1 }
};

// 事件卡选项 → 因果动词（A 层手作卡的埋点表，新卡在这里登记）
const EVENT_VERBS = {
  n_meds:     { give: 'help', refuse: 'refuse_help' },
  n_tool:     { lend: 'help', refuse: 'refuse_help' },
  n_thugs:    { help: 'help', refuse: 'refuse_help' },
  v_deserter: { shelter: 'help', refuse: 'refuse_help' },
  s_priest:   { donate: 'donate' },
  s_tamara:   { donate: 'donate' },
  s_looter:   { share: 'help' },
  t_lighthouse: { launch: 'launch_lighthouse' },
  t_table_offer: { accept: 'join_table', refuse: 'refuse_table' },
  p3_shelling: { share: 'help' },
  p4_door: { open: 'help', shut: 'refuse_help' }
};
export const eventVerb = (cardId, optionKey) => EVENT_VERBS[cardId]?.[optionKey] || null;

// —— 弧线 ——
export const STAGE_THRESHOLDS = [0, 6, 16, 30];
export const STAGE_NAMES = ['陌生', '共事', '托付', '过命'];
export const stageOf = (pos) => {
  let k = 0;
  for (let i = 0; i < STAGE_THRESHOLDS.length; i++) if (pos >= STAGE_THRESHOLDS[i]) k = i;
  return k;
};

const emptyArc = () => ({ pos: 0, neg: 0 });
export function charArc(state, id) {
  return state.causality.charArcs[id] || { pos: 0, neg: 0, privateLedger: [] };
}
/** pairKey(a,b)：b 对 a 的信任弧（a 做过的事，记在 b 账上） */
export const pairKey = (a, b) => `${a}|${b}`;
function pairArc(state, a, b) {
  return state.causality.pairArcs[pairKey(a, b)] || emptyArc();
}
export function pairStage(state, a, b) { return stageOf(pairArc(state, a, b).pos); }
/** b 对 a 的离心（CY-13：反向累积超正向一半） */
export function alienated(state, id) {
  const a = charArc(state, id);
  return a.neg > 4 && a.neg > Math.max(1, a.pos) / 2;
}
/** w 与 t 的亲密档（CY-03 关系加成用）：双向取大 */
export function bondStage(state, w, t) {
  return Math.max(pairStage(state, w, t), pairStage(state, t, w));
}

// —— 读数解算（CY-02/CY-03）：条目只存事实，读数由见证者的伦理×敏感×关系现场解算 ——
export function valenceOf(pack, charDef, entry) {
  const v = VERBS[entry.verb];
  if (!v) return 0;
  let val = v.val;
  if (v.ethics && charDef.ethics?.[v.ethics] != null) val *= charDef.ethics[v.ethics];
  if (v.ethicsInv && charDef.ethics?.[v.ethicsInv] != null) val *= charDef.ethics[v.ethicsInv];
  const sens = charDef.persona?.sensitive?.[entry.verb];
  if (sens != null) val *= sens;
  return val;
}

/**
 * 记一笔因果（唯一入口）。
 * @param {string} verb VERBS 键
 * @param {object} o {actor='player'（谁做的；玩家下令即玩家）, via=执行者 charId,
 *   target=null, witnesses=在场存活者, weight=默认, tags=[], note}
 */
export function recordCausal(ctx, verb, o = {}) {
  const s = ctx.s;
  if (!s.causality) s.causality = { entries: [], pairArcs: {}, charArcs: {} };
  const cz = s.causality;
  const def = VERBS[verb] || { w: 1, val: 0 };
  const actor = o.actor ?? 'player';
  const entry = {
    i: cz.entries.length, day: s.day, verb,
    actor, via: o.via || null, target: o.target ?? null,
    witnesses: (o.witnesses ?? aliveChars(s).map((c) => c.id)).filter(Boolean),
    weight: o.weight ?? def.w,
    tags: [...(def.tags || []), ...(o.tags || [])],
    note: o.note || null,
    // 管家代执行的动作：账照记（玩家立的规矩也是玩家的责任），但复盘措辞要分得开
    delegated: ctx.delegated || undefined
  };
  cz.entries.push(entry);

  // —— 累积（CY-11/CY-51）：敬重弧记玩家，信任弧记角色 ——
  const charUpd = {}, pairUpd = {};
  const bumpChar = (id, read) => {
    const arc = cz.charArcs[id] || (cz.charArcs[id] = { pos: 0, neg: 0, privateLedger: [] });
    if (read > 0) arc.pos += read; else if (read < 0) arc.neg += -read;
    charUpd[id] = structuredClone(arc);
  };
  const bumpPair = (a, b, w) => {
    if (a === b || !w) return;
    const k = pairKey(a, b);
    const arc = cz.pairArcs[k] || (cz.pairArcs[k] = emptyArc());
    if (w > 0) arc.pos += w; else if (w < 0) arc.neg += -w;
    pairUpd[k] = structuredClone(arc);
  };

  const mag = entry.weight; // 贡献 = 读数 × 重量（灭失级一条顶百条，CY-04）
  const actorIsChar = !!ctx.pack.charMap[actor];
  for (const w of entry.witnesses) {
    const wc = charById(s, w);
    if (!wc) continue;
    let read = valenceOf(ctx.pack, wc, entry);
    // CY-03 关系加权：target 是角色时，见证者按与 target 的亲密档加成
    if (entry.target && entry.target !== w && ctx.pack.charMap[entry.target]) {
      read *= 1 + 0.25 * bondStage(s, w, entry.target);
    }
    if (w === entry.target) read *= 1.5; // 直接承受者感受更深
    if (!actorIsChar) {
      // 玩家（或世界）所为 → 记进见证者的敬重弧（char→player）
      bumpChar(w, read * mag);
    } else if (w !== actor && read > 0) {
      // CY-51：看着你怎么对别人——见证者对行动者的评价（信任弧，折扣累积）
      bumpPair(actor, w, read * mag * 0.3);
    }
    // 共患难（world 重事：死亡/惨剧把在场的人焊在一起）
    if (actor === 'world' && entry.weight >= 4) {
      for (const o2 of entry.witnesses) if (o2 !== w) bumpPair(o2, w, 0.5);
    }
  }
  // 角色 → 角色的信任弧（医治/安抚/托付：target 直接把信任记给 actor）
  if (def.pair && actorIsChar && ctx.pack.charMap[entry.target]) {
    bumpPair(actor, entry.target, Math.max(0.2, valenceOf(ctx.pack, ctx.pack.charMap[entry.target], entry)) * mag);
  }

  ctx.emit('CAUSAL', { entry, charUpd, pairUpd });

  // —— 坚持即机制（P-03）：抗议事件 ——
  for (const w of entry.witnesses) {
    const wc = charById(s, w);
    const p = wc?.persona?.protests?.find((x) => x.verb === verb);
    if (!p) continue;
    if (p.oncePerDay && wc[`protested_${verb}`] === s.day) continue;
    ctx.setCharFlag(wc, `protested_${verb}`, s.day);
    if (p.mood) ctx.mood(wc, p.mood, '坚持');
    ctx.fact('protest', { char: w, verb, line: p.line });
  }
  return entry;
}

/** 私人账（薄姑的簿记那类：CY-23 自主行为的数据载体） */
export function addPrivateNote(ctx, charId, note) {
  const s = ctx.s;
  const arc = s.causality.charArcs[charId] || (s.causality.charArcs[charId] = { pos: 0, neg: 0, privateLedger: [] });
  arc.privateLedger.push(note);
  ctx.emit('CAUSAL_NOTE', { charId, note });
}

/** 近 lastDays 天针对某角色的 deny_food 次数（袭击睡岗 CY-32 用） */
export function denyFoodCount(state, charId, lastDays = 5) {
  return (state.causality?.entries || []).filter((e) =>
    e.verb === 'deny_food' && e.target === charId && e.day >= state.day - lastDays
  ).length;
}

/** 晨间自主行为（CY-23）：弧线过阈值后角色自发行动，晨报里只看得见结果 */
export function tickAutonomous(ctx) {
  const s = ctx.s, y = s.day - 1;
  const cz = s.causality;
  if (!cz) return;
  const yesterday = (verb) => cz.entries.filter((e) => e.day === y && e.verb === verb);

  // 玛尔塔：你昨天关的门，她夜里自己打开了——消耗她自己的疲劳
  const marta = charById(s, 'marta');
  if (marta && marta.fatigue < 2) { // 护栏：不把自己累死
    const refusals = yesterday('refuse_help').filter((e) => e.witnesses.includes('marta'));
    if (refusals.length) {
      ctx.setFatigue(marta, marta.fatigue + 1);
      ctx.mood(marta, -1, '良心');
      ctx.fact('auto_marta_care', { char: 'marta' });
    }
  }
  // 安东：烧掉的书累计过线——他把你从生日账里划掉（永久，无演出，只在日后显形）
  const anton = charById(s, 'anton');
  if (anton && !anton.antonStruck) {
    const burnW = cz.entries.filter((e) => e.verb === 'burn_book' && e.witnesses.includes('anton'))
      .reduce((a, e) => a + e.weight, 0);
    if (burnW >= 2) {
      ctx.setCharFlag(anton, 'antonStruck', true);
      ctx.fact('auto_anton_struck', { char: 'anton' });
    }
  }
  // 薄姑：每一次来路不明的交易，她都记进私人簿记
  const vera = charById(s, 'vera');
  if (vera) {
    const evs = yesterday('trade_evidence').filter((e) => e.witnesses.includes('vera'));
    for (const e of evs) addPrivateNote(ctx, 'vera', { day: e.day, entry: e.i });
    if (evs.length && !vera.veraLedgerNoted) {
      ctx.setCharFlag(vera, 'veraLedgerNoted', true);
      ctx.fact('auto_vera_ledger', { char: 'vera' });
    }
  }
  // 尤拉目击账：什么都不用做——他什么都记得（永不衰减，storyline 直接读 entries）
}

/**
 * 念头晨间结算（v3 命运导演）：种下的事，世界替你记着。
 * - 枯萎：满 10 天没人再提 → 淡出（无惩罚，只有文学后果）
 * - 回声：种下至少一天后，每 3 天在晨间轻轻响一声（fact，零状态副作用）
 * 全程确定性（无随机数）：回声时机 = (day - day0) % 3 === 1，一天至多一声。
 */
export function tickDirections(ctx) {
  const s = ctx.s;
  const all = Object.values(s.directions || {});
  if (!all.length) return;
  let dirty = false;
  for (const d of all) {
    if (d.alive && s.day - d.lastDay > 10) {
      d.alive = false; dirty = true;
      ctx.fact('direction_faded', { id: d.id, subject: d.subject, text: d.text });
    }
  }
  for (const d of all.filter((x) => x.alive)) {
    if (s.day <= d.day) continue;
    if ((s.day - d.day) % 3 !== 1 || d.echoDay === s.day) continue;
    if (d.subject && !charById(s, d.subject)) continue; // 人不在了，念头无处落
    d.echoDay = s.day; dirty = true;
    ctx.fact('direction_echo', { id: d.id, char: d.subject, text: d.text });
    break; // 一天至多一声回响
  }
  if (dirty) ctx.setFlag('directions', structuredClone(s.directions));
}

/** 袭击睡岗判定（CY-32）：被长期克扣的守夜人可能"没听见"。返回睡着的守卫（至多一人） */
export function slumberGuard(ctx, guards) {
  for (const g of guards) {
    if (g.hunger <= 1 && denyFoodCount(ctx.s, g.id, 5) >= 3 && ctx.rng.chance(0.25)) return g;
  }
  return null;
}
