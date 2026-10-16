// 事件卡选项结算（内核设计 §8：效果白名单 + riskCheck）与战争后日谈（§9）。
import { charById, combatModOf, aliveChars } from './state.js';
import { applyDayAction } from './dayActions.js';
import { genFrankoStock } from './trade.js';
import { recordCausal, eventVerb } from './causality.js';
import { buildStoryline } from './storyline.js';
import { maybeFireLocScript, combatRound } from './night.js';
import { DEED_PHRASES } from './ge.js';

/** 是否满足选项前置（物品/任一物品） */
export function optionAvailable(ctx, option) {
  const s = ctx.s;
  const req = option.requires || {};
  if (req.item && !ctx.hasItem(req.item)) return false;
  if (req.anyItem && !req.anyItem.some((i) => ctx.hasItem(i))) return false;
  if (req.doc && !s.docsSeen.includes(req.doc)) return false; // 文档门槛（濠鼠活证：先读过勘验才问得出口）
  if (req.flag && !s.eventFlags[req.flag]) return false;
  return true;
}
export function optionCostOk(ctx, option) {
  // cost 为“任选其一”的消耗组（同一物品可多件）——按组内第一件可用者
  for (const cst of option.cost || []) if (ctx.hasItem(cst.item, cst.n)) return true;
  return !(option.cost || []).length;
}

/** 选项不满足时的人话原因（供视图禁用态与拒绝文案共用——玩家得知道缺什么） */
export function optionWhy(s, pack, option) {
  const req = option.requires || {};
  const iname = (id) => pack.itemMap[id]?.name || id;
  if (req.item && !(s.inventory[req.item] >= 1)) return `家里没有${iname(req.item)}`;
  if (req.anyItem && !req.anyItem.some((i) => (s.inventory[i] || 0) >= 1)) return `家里没有${req.anyItem.map(iname).join('、')}中的任何一样`;
  if (req.doc && !s.docsSeen.includes(req.doc)) return `得先读到${pack.docMap?.[req.doc]?.title || '那份纸'}`;
  if (req.flag && !s.eventFlags[req.flag]) return '还差一件事没发生';
  for (const cst of option.cost || []) {
    if ((s.inventory[cst.item] || 0) < (cst.n || 1)) return `缺${iname(cst.item)}×${(cst.n || 1) - (s.inventory[cst.item] || 0)}`;
  }
  return '';
}

/** 事件卡选项视图（enrich 用）：label + ok + why——不可用的选项 UI 直接禁用并写明原因 */
export function eventOptionsView(s, pack, card) {
  card = card || pack.cardMap[s.activeEvent?.cardId] || s.geCards?.[s.activeEvent?.cardId];
  if (!card) return [];
  const ro = { s, hasItem: (i, n = 1) => (s.inventory[i] || 0) >= n }; // 只读鸭子 ctx：optionAvailable/CostOk 只读库存
  return (card.options || []).map((o) => {
    const ok = optionAvailable(ro, o) && optionCostOk(ro, o);
    return { key: o.key, label: o.label, ok, ...(o.note ? { note: o.note } : {}), ...(ok ? {} : { why: optionWhy(s, pack, o) }) };
  });
}


/** 玩家选了事件卡选项 */
export function chooseEventOption(ctx, optionKey) {
  const s = ctx.s;
  const ev = s.activeEvent;
  if (!ev) return { ok: false, reason: 'NO_EVENT' };
  const card = ctx.pack.cardMap[ev.cardId] || s.geCards?.[ev.cardId]; // C 层生成卡走 run 级卡册
  if (!card) return { ok: false, reason: 'NO_CARD' };
  const option = (card.options || []).find((o) => o.key === optionKey);
  if (!option) return { ok: false, reason: 'BAD_OPTION' };
  if (!optionAvailable(ctx, option) || !optionCostOk(ctx, option)) {
    ctx.fact('option_unavailable', { key: optionKey, why: optionWhy(s, ctx.pack, option) });
    return { ok: false, reason: 'UNAVAILABLE' };
  }
  s.activeEvent = null;
  ctx.emit('EVENT_CHOSEN', { cardId: card.id, option: optionKey });
  // 夜间 NPC 剧本落幕：若无更具体的处置（npcState 效果/战斗），记为"打过照面"，管家不再为他停问
  if (ev.night && s.night && !s.night.home) {
    const loc = ctx.pack.locMap[s.night.locId];
    const npc = (loc?.npcs || []).find((x) => x.firstScript === card.id);
    const st = npc && s.locState[s.night.locId];
    if (npc && st && !st.npcState[npc.id]) {
      st.npcState[npc.id] = 'greeted';
      ctx.emit('NPC_STATE', { loc: s.night.locId, npc: npc.id, state: 'greeted' });
    }
  }
  // 因果埋点：求助/捐赠/拒助（登记表见 causality.EVENT_VERBS）
  const verb = eventVerb(card.id, optionKey);
  if (verb) {
    const tgt = card.actor || card.for || null;
    // 夜间剧本卡的见证者只有外出者本人（CY-06）；序章卡打 prologue 标签（回忆录序章段）
    recordCausal(ctx, verb, {
      target: tgt,
      witnesses: ev.night && ev.actorId ? [ev.actorId] : undefined,
      note: card.title,
      tags: card.kind === 'prologue' ? ['prologue'] : []
    });
  }
  applyEffects(ctx, card, option, ev);
  // B-3 选择→回应不断链（二周目实测：拒了逃兵，回应叙事只字不提逃兵）——
  // 结算事实带足上下文：哪张卡、玩家选了什么、卡面落定的结果文本，叙事者有料可接
  ctx.fact('card_resolved', {
    card: card.title,
    option: option.label,
    result: (option.effects || {}).text || option.label,
    ...(card.actor || card.for ? { who: card.actor || card.for } : {})
  });
  // 夜访链续火（北津台或然 A 的三段）：选项落旗后，同地同夜续点下一拍
  if (s.night && !s.night.home && !s.activeEvent) {
    const loc = ctx.pack.locMap[s.night.locId];
    if (loc) maybeFireLocScript(ctx, loc, charById(s, s.night.charId) || { id: s.night.charId });
  }
  return { ok: true };
}

/** 点卡的统一入口（剧情分层总纲）：日常剧本是背景流，关键抉择才配一张卡。
 *  card.beat（内容侧标记）＝节拍卡：到点即自动落账（auto 选项或首项），
 *  故事随 event/event_text/card_resolved 三段事实流入当日叙述——不占 activeEvent，
 *  不拦玩家的生存拍子。决断卡照旧挂 activeEvent 等玩家选。
 *  发火点的 firedOnce 记账职责不变（各点自设，beat 不重设）。 */
export function fireEventCard(ctx, cardId, extra = {}) {
  const s = ctx.s;
  const card = ctx.pack.cardMap[cardId] || s.geCards?.[cardId];
  if (card?.beat) {
    ctx.emit('EVENT_FIRED', { cardId: card.id, beat: true });
    ctx.fact('event', { cardId: card.id, title: card.title });
    if (card.text) ctx.fact('event_text', { text: String(card.text).replaceAll('{{names}}', s.chars.map((c) => c.name).join('、')) });
    const opt = (card.options || []).find((o) => o.auto) || (card.options || [])[0];
    if (opt && optionAvailable(ctx, opt) && optionCostOk(ctx, opt)) {
      applyEffects(ctx, card, opt, { beat: true });
      ctx.fact('card_resolved', { card: card.title, option: opt.label, result: (opt.effects || {}).text || opt.label, beat: true, ...(card.actor || card.for ? { who: card.actor || card.for } : {}) });
    }
    return { ok: true, beat: true };
  }
  s.activeEvent = { cardId, ...extra };
  ctx.emit('EVENT_FIRED', { cardId, ...(extra.actorId ? { actorId: extra.actorId } : {}), ...(extra.night ? { night: true } : {}) });
  ctx.fact('event', { cardId, title: card?.title, ...(extra.actorId ? { who: extra.actorId } : {}) });
  return { ok: true };
}

function applyEffects(ctx, card, option, ev) {  const s = ctx.s, e = option.effects || {};
  // 消耗（cost 组取第一个持有项；consumeChoice 同）
  for (const cst of option.cost || []) {
    if (ctx.hasItem(cst.item, cst.n)) { ctx.takeItem(cst.item, cst.n, '事件'); break; }
  }
  if (e.consumeChoice) {
    for (const it of e.consumeChoice) if (ctx.hasItem(it)) { ctx.takeItem(it, 1, '事件'); break; }
  }
  // 心情：all / softHearted+default / 指定角色 / actor
  if (e.mood) {
    const m = e.mood;
    if (m.all !== undefined) {
      if (ev.night && ev.actorId) { const c = charById(s, ev.actorId); if (c) ctx.mood(c, m.all, card.id, { helpMul: false }); }
      else for (const c of aliveChars(s)) ctx.mood(c, m.all, card.id);
    }
    if (m.softHearted !== undefined) {
      for (const c of aliveChars(s)) ctx.mood(c, c.softHearted ? m.softHearted : m.default, card.id);
    } else if (m.default !== undefined) {
      for (const c of aliveChars(s)) ctx.mood(c, m.default, card.id);
    }
    for (const [id, v] of Object.entries(m)) {
      if (['all', 'default', 'softHearted', 'actor'].includes(id)) continue;
      const c = charById(s, id); if (c) ctx.mood(c, v, card.id);
    }
    if (m.actor !== undefined && ev.actorId) {
      const c = charById(s, ev.actorId); if (c) ctx.mood(c, m.actor, card.id);
    }
  }
  if (e.reputation) for (const [k, v] of Object.entries(e.reputation)) ctx.reputation(k, v);
  // v0.3 军心溶解账：家访/家书的效果通道（正=报平安，负=如实/劝归队）；FLAG 镜像可回放
  if (typeof e.dissolve === 'number' && e.dissolve !== 0) {
    s.dissolve = (s.dissolve || 0) + e.dissolve;
    ctx.emit('FLAG', { key: 'dissolve', val: s.dissolve });
    ctx.fact('dissolve_shift', { n: e.dissolve, why: card.id });
  }
  if (e.items) for (const [k, v] of Object.entries(e.items)) ctx.addItem(k, v, '事件'); // 得物（别传日卡/GE 白名单同款）
  if (e.knowledge) ctx.addKnowledge(e.knowledge, card.id);
  if (e.flags) {
    const flags = { ...s.eventFlags };
    let shovel = s.shovelReturnDay;
    for (const [k, v] of Object.entries(e.flags)) {
      if (k === 'shovel_return_day') { shovel = s.day + parseInt(String(v).replace('+', ''), 10); continue; }
      // "+N" = 相对天数旗标（停火窗口/灯塔倒计时这类）
      if (typeof v === 'string' && v.startsWith('+')) flags[k] = s.day + parseInt(v.slice(1), 10);
      else flags[k] = v;
    }
    s.eventFlags = flags;
    ctx.emit('FLAG', { key: 'eventFlags', val: structuredClone(flags) });
    if (shovel !== s.shovelReturnDay) { s.shovelReturnDay = shovel; ctx.emit('FLAG', { key: 'shovelReturnDay', val: shovel }); }
    // 出江陵线：拒绝之后，鲁舟不再泊船
    if (flags.franko_gone) {
      s.franko = null;
      s.frankoNextDay = 9999;
      ctx.emit('FLAG', { key: 'frankoNextDay', val: 9999 });
    }
  }
  if (e.ap_cost) {
    const c = ev.actorId ? charById(s, ev.actorId) : null;
    if (c) { ctx.spendAp(c, e.ap_cost); }
  }
  if (e.flagTonight === 'assist_neighbor') s.assistTonight = true;
  if (e.npcState && ev.night) {
    const st = s.locState[s.night?.locId || ''];
    if (st) for (const [k, v] of Object.entries(e.npcState)) st.npcState[k] = v;
  }
  if (e.abortNight && s.night) { // 撤离夜访
    const n = s.night;
    ctx.emit('NIGHT_ENDED', { loc: n.locId, reason: 'abort', carried: n.pack.length, gear: n.gear || [] });
    ctx.fact('night_end', { char: n.charId, loc: ctx.pack.locMap[n.locId]?.name || n.locId, carried: n.pack.length, reason: 'abort' }); // A-1：中断收工也点名夜访者
    s.lastScavenger = n.charId;
    ctx.emit('FLAG', { key: 'lastScavenger', val: n.charId });
    s.night = null; s.phase = 'dawn';
    ctx.fact('night_abort', {});
  }
  if (e.openTrade) {
    if (e.openTrade === 'hospital') {
      const stock = hospitalStock(ctx);
      s.franko = { merchant: 'hospital', stock };
      ctx.emit('FRANKO_ARRIVE', { stock });
      ctx.fact('hospital_trade_open', {});
    }
    return;
  }
  if (e.stealValue !== undefined) {
    // 夜窃效果（逃兵那类）：按价值扣物
    let left = e.stealValue;
    const items = ctx.pack.items.filter((i) => (s.inventory[i.id] || 0) > 0).sort((a, b) => b.value - a.value);
    for (const it of items) { while ((s.inventory[it.id] || 0) > 0 && left > 0) { ctx.takeItem(it.id, 1, '失窃'); left -= it.value; } }
  }
  if (e.text) ctx.fact('event_text', { text: String(e.text).replaceAll('{{names}}', s.chars.map((c) => c.name).join('、')) });
  if (e.wound && ev.actorId) {
    const c = charById(s, ev.actorId); if (c) ctx.setWound(c, c.wound + e.wound, `《${card.title}》`);
  }
  // riskCheck（GE-03 白名单：一次检定，伤上限 1）
  if (option.riskCheck) {
    const rc = option.riskCheck;
    let mod = 0;
    if (ev.actorId) {
      const c = charById(s, ev.actorId);
      if (c) {
        mod = rc.stealth ? (c.traits?.stealthy || 0) : rc.combat ? combatModOf(c) + 1 : 0;
        if (rc.ambush) mod += 1;
      }
    }
    const r = ctx.check(card.id + ':' + option.key, mod);
    const br = r.outcome === 'fail' ? rc.onFail : (r.outcome === 'cost' ? { ...(rc.onPass || {}), ...(rc.onCost || {}) } : rc.onPass);
    if (br) applyEffects(ctx, card, { key: option.key + ':r', label: '', effects: br, cost: [] }, ev);
    // 检定失败转入战斗（修 v1 遗留：onFail.combat 曾被静默丢弃——偷袭失败从没真打起来过）
    if (br?.combat && ev.night && s.night && !s.night.home) {
      const loc = ctx.pack.locMap[s.night.locId];
      const npc = (loc?.npcs || []).find((x) => x.id === br.combat);
      const c = ev.actorId ? charById(s, ev.actorId) : null;
      if (npc && c) combatRound(ctx, npc, c, { surprise: false });
    }
  }
}

function hospitalStock(ctx) {
  // 医院药剂师：药换食物（E-08）——小摊
  return [
    { item: 'bandage', n: 1, buy: 24 },
    { item: 'herbmed', n: 2, buy: 18 },
    { item: 'meds', n: 1, buy: 30 }
  ];
}

// —— 战争后日谈（N 系）——
const DEED_TIERS = {
  kill_civ: { bad: 1, weight: 6 },
  steal_civ: { bad: 1, weight: 3 },
  kill_enemy: { neutral: 1, weight: 2 },
  help: { good: 1, weight: 3 },
  donate: { good: 1, weight: 4 }
};
export function buildEnding(state, pack) {
  const s = state;
  const alive = s.chars.filter((c) => c.alive);
  const dead = s.chars.filter((c) => !c.alive);
  const story = buildStoryline(s, pack); // 单一源：chars[].fate 消费 storyline.direction（口径统一）
  // ── 擦痕（史×你）：同一天，史册记的大事 × 因果账里你做的事。最多四对，重者优先。
  // 全部内核事实拼装，零发明——LLM 局与直读局拿到同一份底稿
  {
    const stepMap = new Map((pack.mainline?.steps || []).map((x) => [x.id, x]));
    const name = (id) => s.chars.find((c) => c.id === id)?.name || pack.charMap?.[id]?.name || '';
    const deedsByDay = new Map();
    for (const e of (s.causality?.entries || [])) {
      if (e.weight < 1.5 || e.tags?.includes('prologue')) continue;
      if (!deedsByDay.has(e.day)) deedsByDay.set(e.day, []);
      deedsByDay.get(e.day).push(e);
    }
    const echoes = [];
    for (const m of (s.mainline || [])) {
      const def = m.stepId ? stepMap.get(m.stepId) : null;
      if (!def) continue;
      const hits = [...(deedsByDay.get(m.day) || []), ...(deedsByDay.get(m.day - 1) || [])];
      if (!hits.length) continue;
      const e = [...hits].sort((a, b) => b.weight - a.weight)[0];
      const phrase = DEED_PHRASES[e.verb];
      if (!phrase) continue;
      const who = e.via ? name(e.via) : (e.actor === 'player' ? '你' : '');
      echoes.push({ day: m.day, hist: def.title, histText: (def.fallback || '').slice(0, 40), deed: `${who}${phrase}${e.target && pack.charMap?.[e.target] ? '·' + name(e.target) : ''}` });
      if (echoes.length >= 4) break;
    }
    story.echoes = echoes;
  }
  // ── codex（结局屏自足数据：正史压卷/落幕行/双轨/题卷）──
  {
    const stepMap = new Map((pack.mainline?.steps || []).map((x) => [x.id, x]));
    const tracks = { city: [], gen: [] };
    for (const m of (s.mainline || [])) {
      const def = m.stepId ? stepMap.get(m.stepId) : null;
      if (!def) continue;
      const t = def.track === 'gen' ? tracks.gen : tracks.city;
      t.push({ day: m.day, title: def.title, text: def.fallback || '' });
    }
    // 正史压卷（0.31.0 落幕仪式感）：正脊各结局共享——历史不因玩家而动；
    // 分岔结局在 fork 点换行，forked 标记给前端做「改注」特排
    const annals = (pack.mainline?.annals || []).map((e) => {
      const f = e.fork?.[s.war.endingType];
      return f ? { day: e.day, text: f.text, src: f.src || e.src, forked: true }
        : { day: e.day, text: e.text, src: e.src };
    });
    story.codex = {
      annals,
      // 案语（0.32.0 落幕史源纵深）：每结局 3~4 条《三国志》/《三国演义》前因后果
      notes: pack.mainline?.endingNotes?.[s.war.endingType] || [],
      lines: pack.mainline?.endings?.[s.war.endingType] || [],
      futures: pack.mainline?.futures?.[s.war.endingType] || [],
      tracks
    };
    // 尾句（小说层·反转回收）：最后一夜的门、纸的去处——玩家 41 天的选择在此回声
    {
      const F = s.eventFlags || {};
      const tail = [];
      if (F.final_door_open) tail.push('第四十一天的门是开着的——你救散的人，最后一夜替你守了整条巷子。你曾在家书里写「都好」，这一夜他们来核对了这两个字，然后信了。');
      else if (F.final_door_shut) tail.push('第四十夜你守住了门。门外的人没砸——散掉的人砸不动任何东西了。他们靠着你家的墙坐到天亮，门里门外，听着彼此的呼吸。');
      if (F.mercy_debt_paid) tail.push('那碗粥后来替你巡了夜巷。善有善报不是天道，是那个吃过粥的人记得。');
      if (F.archive_smuggled) tail.push('档案馆的纸出了城——这座城的记忆，在某条你看不见的船上活着。');
      else if (F.archive_walled) tail.push('纸留在了墙里。城会忘，墙不会。');
      if (tail.length) story.codex.lines = [...story.codex.lines, ...tail];
    }
  }
  const epById = Object.fromEntries(story.epilogues.map((e) => [e.id, e]));
  const chars = [...alive, ...dead].map((c) => {
    const ep = epById[c.id] || {};
    const ep2 = ep.epithet ? `——${ep.epithet}` : '';
    // 誓的结账（念头演化）：这个人的誓——践了写「放下」，赖账念「说过几遍」
    const myVows = Object.values(s.directions || {}).filter((d) => d.kind === 'vow' && (d.subject ? d.subject === c.id : true));
    const done = myVows.find((d) => d.fulfilledDay);
    const owe = myVows.find((d) => !d.fulfilledDay && (d.watered || 0) >= 1);
    const vowLine = done
      ? `第 ${done.fulfilledDay} 天，那句「${(done.text || '').slice(0, 12)}」落了地——放下了。`
      : owe ? `你说过${(owe.watered || 0) + 1}遍「${(owe.text || '').slice(0, 12)}」。最后那遍之后，${c.name}不再数了。`
      : '';
    const fate = (ep.direction === 'fallen'
      ? `没能撑过去。第 ${deathsDay(s, c.id)} 天，橘里的墙上多了一个名字${ep2}。`
      : ep.direction === 'haunted' ? `活下来了，但有些夜晚会突然惊醒，手先于他摸向不存在的刀${ep2}。`
      : ep.direction === 'honored' ? `活下来了。战争结束后很久，还有人敲他家的门——为了道谢，不是为了讨债${ep2}。`
      : `活下来了。就是活下来了。在这个年头，这四个字已经够写一整页${ep2}。`) + (vowLine ? vowLine : '');
    return { id: c.id, name: c.name, alive: c.alive, fate, direction: ep.direction || 'survived' };
  });
  // 三件事（EX-02）：戏剧分 top3。deeds 只在击杀等重事落笔——和平局的账在因果引擎里
  // （施舍/拒援/医治/守夜/送走死者都是"带走的事"），两周目实测零击杀局三件事恒空。
  // 合并取材：deeds ∪ 因果条目，权重沿用各自的账；文案必须是人话（名字，不是 id）
  const name = (id) => s.chars.find((c) => c.id === id)?.name || pack.charMap?.[id]?.name
    || (id === 'player' ? '你' : (id === 'world' || id === 'home' || !id ? '' : id));
  const drama = [];
  for (const d of s.deeds) {
    const w = DEED_TIERS[d.type]?.weight || 1;
    drama.push({ day: d.day, text: `${name(d.actor)}${DEED_PHRASES[d.type] || d.type}${d.target ? `·${name(d.target)}` : ''}`, w });
  }
  const seenDrama = new Set(drama.map((x) => x.text));
  for (const e of (s.causality?.entries || [])) {
    const phrase = DEED_PHRASES[e.verb];
    if (!phrase || e.weight < 1) continue; // 琐事不上榜；守夜/喂饭这类轻账让位给重账
    const who = e.via ? name(e.via) : (e.actor === 'world' ? '' : name(e.actor));
    const text = `${who}${phrase}${e.target && pack.charMap?.[e.target] ? `·${name(e.target)}` : ''}`;
    if (seenDrama.has(text)) continue;
    seenDrama.add(text);
    drama.push({ day: e.day, text, w: e.weight });
  }
  const three = drama.sort((a, b) => b.w - a.w || b.day - a.day).slice(0, 3);
  // 别传结局（长线体验-v0.2 §3.4）：按旗标选变体，史书体/批注进史册格
  if (s.sidestory) {
    const def = pack.sideMap[s.sidestory.id];
    const variant = (def.ending.variants || []).find((v) => (v.whenFlags || []).every((f) => s.eventFlags[f]));
    const chosen = variant || def.ending.default;
    const sideStory = { ...story, title: `${def.title} · ${chosen.title}`, annals: [{ text: chosen.text, note: chosen.note, ending: 'side_' + def.id }] };
    const ending = {
      type: 'sidestory',
      day: s.day,
      title: sideStory.title,
      sidestory: { id: def.id, title: def.title },
      chars,
      threeThings: three,
      docs: s.docsSeen,
      knowledge: s.knowledge,
      storyline: sideStory
    };
    return ending;
  }
  return {
    type: s.war.endingType || 'wiped',
    day: s.day,
    title: story.title, // C-6：结局对象自带题名（二周目实测 UI/报告侧都得自己去 storyline 里翻）
    chars,
    threeThings: three,
    docs: s.docsSeen,
    knowledge: s.knowledge,
    // 因果引擎：这一局的完整故事线与人的账（CY-33/EPI-01）
    storyline: story
  };
}
function deathsDay(s, id) {
  // 真实死亡日优先（ctx.die 记账，fold 镜像）；旧档无此账再退 deeds，最后退当日
  return s.deathDays?.[id] ?? s.deeds.find((x) => x.actor === id && x.type === 'died')?.day ?? s.day;
}
