// 内容包加载与校验（技术架构 §5）：内容即数据，校验失败拒绝启动。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERBS } from './causality.js';
import { DAY_ACTIONS } from './dayActions.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PACK_DIR = join(here, '..', '..', '..', 'content', 'base');

function readJson(dir, f) {
  return JSON.parse(readFileSync(join(dir, f), 'utf8'));
}

/**
 * @returns {object} pack：{manifest, items, itemMap, characters, charMap, locations, locMap,
 *   recipes, facilities, facilityMap, doorReinforce, events, cards, cardMap, broadcasts,
 *   docs, docMap, layerGates, narrations, kpis}
 */
export function loadPack(dir = DEFAULT_PACK_DIR) {
  const manifest = readJson(dir, 'manifest.json');
  const items = readJson(dir, 'items.json').items;
  const charsFile = readJson(dir, 'characters.json');
  const characters = charsFile.characters;
  const relations = charsFile.relations || [];
  const locations = readJson(dir, 'locations.json').locations;
  const rj = readJson(dir, 'recipes.json');
  const ej = readJson(dir, 'events.json');
  const dj = readJson(dir, 'docs.json');
  const narrations = readJson(dir, 'narrations.json');
  const kpis = readJson(dir, 'kpis.json');
  const sj = readJson(dir, 'seals.json');
  let ge = null;
  try { ge = readJson(dir, 'ge.json'); } catch { /* C 层守卫可选 */ }
  // 堂屋直读模板（人物血肉计划 PR2，可选）：LLM 离线时评史/互动照常开演
  let ensembleTemplates = null;
  try { ensembleTemplates = readJson(dir, 'ensemble.json'); } catch { /* 无堂屋模板包 */ }
  // 叙事双轴（叙事双轴-v0.1）：序章三幕 / 舆图 / 主线日步 / 历史轴（全部可选，缺包退老行为）
  let prelude = null, map = null, mainline = null, historia = null;
  try { prelude = readJson(dir, 'prelude.json'); } catch { /* 无序章文本包 */ }
  try { map = readJson(dir, 'map.json'); } catch { /* 无舆图 */ }
  try { mainline = readJson(dir, 'mainline.json'); } catch { /* 无大事轴 */ }
  try { historia = readJson(dir, 'historia.json'); } catch { /* 无历史轴 */ }
  // 别传（可选文件）：旁传角色与旁传卡并入包（side 标记，主线不可见）
  let side = { sideChars: [], stories: [], cards: [] };
  try {
    side = readJson(dir, 'sidestories.json');
  } catch { /* 无别传包 */ }
  // 居家与四问（可选文件）：重心文案、通用日课阶梯、十二人自主包、双人、闲笔
  let autonomy = null;
  try { autonomy = readJson(dir, 'autonomy.json'); } catch { /* 无自主包：角色不长自己的事 */ }
  // 快局预设（可选文件，长线体验 §4.1）：D21 中盘切片的家底
  let quickstart = null;
  try { quickstart = readJson(dir, 'quickstart.json'); } catch { /* 无快局预设 */ }
  // 回响节拍器（可选文件，小说层）：长线的轻触/翻转/物化线索/幕问幕结
  let threads = null;
  try { threads = readJson(dir, 'threads.json'); } catch { /* 无线包 */ }

  const itemMap = Object.fromEntries(items.map((i) => [i.id, i]));
  const charMap = Object.fromEntries(characters.map((c) => [c.id, c]));
  for (const sc of side.sideChars || []) charMap[sc.id] = { ...sc, sideOnly: true };
  const errs = [];
  // 别传专属地点（长线体验 §3.4"不换系统，换眼睛"的另一半——夜访的场也得换）：
  // 并入 locations/locMap 并打 side 标记，主线索引时按 side 过滤，别传局只认自家场
  const mainLocIds = new Set(locations.map((l) => l.id));
  const sideLocs = [];
  for (const st of side.stories || []) {
    for (const l of st.locations || []) {
      if (mainLocIds.has(l.id) || sideLocs.some((x) => x.id === l.id)) { errs.push(`别传地点 ${l.id} 与现有地点重名`); continue; }
      sideLocs.push({ ...l, side: st.id });
    }
  }
  const allLocs = [...locations, ...sideLocs];
  const locMap = Object.fromEntries(allLocs.map((l) => [l.id, l]));
  const allCards = [...ej.cards, ...(side.cards || [])];
  const cardMap = Object.fromEntries(allCards.map((c) => [c.id, c]));
  const docMap = Object.fromEntries(dj.docs.map((d) => [d.id, d]));
  const sealMap = Object.fromEntries((sj.seals || []).map((x) => [x.id, x]));

  // —— 引用完整性校验（启动/种子化前必须通过）——
  const needItem = (id, where) => { if (!itemMap[id]) errs.push(`未知物品 ${id} @ ${where}`); };
  const checkRooms = (l, where) => {
    if (!l.rooms?.length) errs.push(`地点 ${where} 无房间`);
    for (const r of l.rooms || []) {
      for (const c of r.containers || []) {
        for (const e of c.loot || []) { if ((e.w || 0) > 0) needItem(e.item, `${where}.${c.id}`); }
        for (const d of c.docs || []) if (!docMap[d]) errs.push(`未知文档 ${d} @ ${where}.${c.id}`);
      }
    }
  };
  for (const l of locations) {
    checkRooms(l, l.id);
    for (const d of l.docsPool || []) if (!docMap[d]) errs.push(`未知文档 ${d} @ ${l.id}.docsPool`);
    for (const n of l.npcs || []) {
      if (n.firstScript && !ej.cards.some((c) => c.for === n.firstScript)) {
        errs.push(`NPC ${n.id} 引用缺失脚本 ${n.firstScript}`);
      }
    }
  }
  // 别传地点/别传之家：只认物品，不准带兰台文档（别传不喂主线档案）
  for (const l of sideLocs) {
    checkRooms(l, l.id);
    if ((l.docsPool || []).length || (l.rooms || []).some((r) => (r.containers || []).some((c) => (c.docs || []).length))) errs.push(`别传地点 ${l.id} 不得携带文档`);
    for (const n of l.npcs || []) if (n.firstScript && !allCards.some((c) => c.for === n.firstScript)) errs.push(`别传 NPC ${n.id} 引用缺失脚本 ${n.firstScript}`);
  }
  for (const st of side.stories || []) {
    if (st.home) checkRooms(st.home, `${st.id}.home`);
    for (const id of st.roster || []) if (!charMap[id]) errs.push(`别传 ${st.id} 阵容引用未知角色 ${id}`);
    for (const id of st.setup?.knownLocs || []) if (!locMap[id]) errs.push(`别传 ${st.id} 已知地点 ${id} 不存在`);
    for (const k of Object.keys(st.setup?.inventory || {})) needItem(k, `别传 ${st.id} 家底`);
    for (const k of Object.keys(st.setup?.facilities || {})) if (!rj.facilities.some((f) => f.id === k)) errs.push(`别传 ${st.id} 开局设施 ${k} 不存在`);
    for (const v of st.ending?.variants || []) {
      for (const id of [...(v.whenAlive || []), ...(v.whenDead || [])]) if (!charMap[id]) errs.push(`别传 ${st.id} 结局变体引用未知角色 ${id}`);
      if (!v.title) errs.push(`别传 ${st.id} 结局变体缺 title（结局屏标题取自此）`);
    }
    if (!st.ending?.default?.text) errs.push(`别传 ${st.id} 缺默认结局`);
  }
  for (const c of side.cards || []) {
    if (!c.side || !(side.stories || []).some((st) => st.id === c.side)) errs.push(`别传卡 ${c.id} 的 side 不指向任何别传`);
    if (c.as && !charMap[c.as]) errs.push(`别传卡 ${c.id} 的演员 ${c.as} 不存在`);
    if (c.when?.at && c.when.at !== 'dusk') errs.push(`别传卡 ${c.id} 的 when.at 只认 dusk`);
  }
  for (const d of dj.docs) if (!locMap[d.at]) errs.push(`文档 ${d.id} 指向未知地点 ${d.at}`);
  for (const x of sj.seals || []) {
    if (x.trigger?.doc && !docMap[x.trigger.doc]) errs.push(`封印 ${x.id} 引用未知文档 ${x.trigger.doc}`);
    if (x.trigger?.docs && x.trigger.docs > dj.docs.length) errs.push(`封印 ${x.id} 的 docs 门槛超过文档总数`);
  }
  for (const r of rj.recipes) {
    needItem(r.out.item, `配方 ${r.id}`);
    for (const n of r.need || []) needItem(n.item, `配方 ${r.id}`);
  }
  for (const f of rj.facilities) for (const k of Object.keys(f.cost)) needItem(k, `设施 ${f.id}`);
  // 人物血肉计划 PR1：主池全员必须有暗面与五幕立场（旁传角色不受此约束）
  const shadowActIds = new Set((mainline?.acts || []).map((a) => a.id));
  for (const c of characters) {
    if (!c.ethics) errs.push(`角色 ${c.id} 缺伦理向量`);
    const p = c.persona || {};
    const sh = p.shadow;
    if (!sh?.stain) errs.push(`角色 ${c.id} 缺暗面 shadow.stain`);
    if (!['heavy', 'mid', 'soft'].includes(sh?.grade)) errs.push(`角色 ${c.id} 暗面 shadow.grade 必须是 heavy/mid/soft`);
    if (!Array.isArray(sh?.trigger?.verbs) || !sh.trigger.verbs.length) errs.push(`角色 ${c.id} 缺暗面扳机动词 shadow.trigger.verbs`);
    else for (const v of sh.trigger.verbs) if (!VERBS[v]) errs.push(`角色 ${c.id} 扳机动词 ${v} 不在因果动词表`);
    if (sh?.trigger?.act && !shadowActIds.has(sh.trigger.act)) errs.push(`角色 ${c.id} 扳机幕 ${sh.trigger.act} 不在主线幕表`);
    if ((sh?.descent || []).length < 2) errs.push(`角色 ${c.id} 缺堕落台词 shadow.descent（至少两句）`);
    if ((sh?.redemption || []).length < 1) errs.push(`角色 ${c.id} 缺救赎种子 shadow.redemption`);
    if (!p.stances) errs.push(`角色 ${c.id} 缺五幕立场 stances`);
    else for (const a of shadowActIds) if (!p.stances[a]) errs.push(`角色 ${c.id} 缺 ${a} 立场`);
    if ((p.voice || []).length < 8) errs.push(`角色 ${c.id} voice 不足八句（直读对话的原料）`);
  }
  // 叙事双轴引用校验（叙事双轴-v0.1 §9：标不出即不存在）
  if (prelude) {
    for (const cid of Object.keys(prelude.prequels || {})) if (!charMap[cid]) errs.push(`前传引用未知角色 ${cid}`);
    for (const v of prelude.confluence?.variants || []) for (const cid of v.requiresChar || []) if (!charMap[cid]) errs.push(`合流变体引用未知角色 ${cid}`);
    for (const cid of [...(prelude.cardsAct2 || []), ...(prelude.cardsAct3 || [])]) {
      if (!ej.cards.some((c) => c.id === cid && c.kind === 'prologue')) errs.push(`序章节拍引用非序章卡 ${cid}`);
    }
  }
  if (mainline) {
    const actIds = new Set((mainline.acts || []).map((a) => a.id));
    for (const st of mainline.steps || []) {
      if (st.day === undefined && !st.dayWindow) errs.push(`主线步 ${st.id} 缺 day/dayWindow`);
      if (st.act && !actIds.has(st.act)) errs.push(`主线步 ${st.id} 引用未知幕 ${st.act}`);
      for (const h of st.hooks || []) {
        const key = String(h.key || '');
        if (key.startsWith('doc:') && !docMap[key.slice(4)]) errs.push(`主线步 ${st.id} 伏笔引用未知文档 ${key}`);
      }
    }
  }
  if (map) {
    const locIds = new Set(locations.map((l) => l.id));
    for (const p of map.places || []) if (!locIds.has(p.id)) errs.push(`舆图引用未知地点 ${p.id}`);
    for (const t of map.traces || []) if (t.when?.doc && !docMap[t.when.doc]) errs.push(`舆图痕 ${t.id} 引用未知文档 ${t.when.doc}`);
    for (const r of map.roads || []) {
      if (!locIds.has(r.from)) errs.push(`舆图道路引用未知地点 ${r.from}`);
      if (!locIds.has(r.to)) errs.push(`舆图道路引用未知地点 ${r.to}`);
    }
  }
  // 城市扩展引用校验：池成员、依赖地点/文档、标记图例——标不出即不存在
  const poolSeen = new Map();
  for (const p of manifest.locationPools || []) {
    if (!p.group || !Array.isArray(p.members) || p.members.length < 2 || (p.pick || 1) >= p.members.length) {
      errs.push(`地点池 ${p.group} 配置非法（members≥2 且 pick<members）`);
      continue;
    }
    for (const mem of p.members) {
      if (!locMap[mem]) errs.push(`地点池 ${p.group} 成员 ${mem} 不存在`);
      if (poolSeen.has(mem)) errs.push(`地点 ${mem} 同时住在两个池里（${poolSeen.get(mem)} 与 ${p.group}）`);
      poolSeen.set(mem, p.group);
    }
  }
  const MARKS = new Set(['treasure', 'danger', 'story', 'trade', 'food', 'med']);
  for (const l of allLocs) {
    if (l.mark && !MARKS.has(l.mark)) errs.push(`地点 ${l.id} 的 mark ${l.mark} 不在图例`);
    if (l.pool && ![...(manifest.locationPools || [])].some((p) => p.group === l.pool && p.members.includes(l.id))) {
      errs.push(`地点 ${l.id} 自称属于池 ${l.pool}，池不认`);
    }
    for (const cond of [l.requires, l.heardWhen]) {
      for (const v of [...(cond?.visitedAny || []), ...(cond?.visitedAll || [])]) {
        if (!locMap[v]) errs.push(`地点 ${l.id} 的依赖地点 ${v} 不存在`);
      }
      for (const d of cond?.docs || []) if (!docMap[d]) errs.push(`地点 ${l.id} 的依赖文档 ${d} 不存在`);
    }
  }
  if (historia) {
    const names = new Set(historia.persons || []);
    for (const f of historia.figures || []) {
      if (!names.has(f.name)) names.add(f.name);
      if (!f.line) errs.push(`闲笔 ${f.id} 缺 line`);
    }
  }
  for (const c of allCards) {
    for (const o of c.options || []) {
      for (const cst of o.cost || []) needItem(cst.item, `事件 ${c.id}.${o.key}`);
      if (o.effects?.consumeChoice) for (const it of o.effects.consumeChoice) needItem(it, `事件 ${c.id}.${o.key}`);
      for (const k of Object.keys(o.effects?.items || {})) needItem(k, `事件 ${c.id}.${o.key}.items`);
    }
    const w = c.when || {};
    if (w.requiresChar && !charMap[w.requiresChar]) errs.push(`事件 ${c.id} 引用未知角色 ${w.requiresChar}`);
    for (const id of w.requiresChars || []) if (!charMap[id]) errs.push(`事件 ${c.id} 引用未知角色 ${id}`);
    for (const d of [w.requiresDoc, ...(w.requiresDocs || []), ...(w.requiresAnyDoc || [])].filter(Boolean)) {
      if (!docMap[d]) errs.push(`事件 ${c.id} 引用未知文档 ${d}`);
    }
    if (w.requiresFacility && !rj.facilities.some((f) => f.id === w.requiresFacility)) errs.push(`事件 ${c.id} 引用未知设施 ${w.requiresFacility}`);
  }

  // 自主包校验：人名、动作、物品、对象都要标得出
  if (autonomy) {
    const checkItem = (it, where) => {
      if (it.do) {
        const [action] = String(it.do).split(':');
        if (!DAY_ACTIONS.includes(action)) errs.push(`自主包 ${where} 的 do=${it.do} 不是白天动作`);
      }
      for (const k of Object.keys(it.effects?.items || {})) needItem(k, `自主包 ${where}.items`);
      for (const c of [...(it.cost || []), ...(it.effects?.cost || [])]) needItem(c.item, `自主包 ${where}.cost`);
      for (const k of Object.keys(it.when?.item || {})) needItem(k, `自主包 ${where}.when.item`);
      for (const k of [].concat(it.when?.noItem || [])) needItem(k, `自主包 ${where}.when.noItem`);
      if (it.effects?.heard && !locMap[it.effects.heard]) errs.push(`自主包 ${where} 风闻地点 ${it.effects.heard} 不存在`);
      for (const k of Object.keys(it.effects?.facility || {})) if (!rj.facilities.some((f) => f.id === k)) errs.push(`自主包 ${where} 设施 ${k} 不存在`);
      if (!it.id && !where.startsWith('ladder')) errs.push(`自主包 ${where} 缺 id`);
    };
    for (const [cid, kit] of Object.entries(autonomy.kits || {})) {
      if (!charMap[cid]) errs.push(`自主包引用未知角色 ${cid}`);
      for (const it of kit.trade || []) checkItem(it, `${cid}.trade.${it.id}`);
      for (const it of kit.leisure || []) checkItem(it, `${cid}.leisure.${it.id}`);
      for (const it of kit.habits || []) checkItem(it, `${cid}.habits.${it.id}`);
      for (const st of kit.arc?.stages || []) checkItem({ ...st, id: 'stage' }, `${cid}.arc`);
      if (kit.stress) checkItem({ ...kit.stress, id: 'stress' }, `${cid}.stress`);
    }
    for (const p of autonomy.pairs || []) {
      if (!charMap[p.a] || !charMap[p.b]) errs.push(`双人自主 ${p.id} 引用未知角色 ${p.a}/${p.b}`);
      checkItem(p, `pairs.${p.id}`);
    }
    for (const v of autonomy.vignettes?.items || []) checkItem(v, `vignettes.${v.id}`);
    for (const [id, it] of Object.entries(autonomy.ladder?.items || {})) checkItem({ id, ...it }, `ladder.${id}`);
  }

  if (errs.length) throw new Error('内容包校验失败：\n' + errs.join('\n'));

  return {
    manifest, items, itemMap, characters, charMap, locations: allLocs, locMap,
    recipes: rj.recipes, facilities: rj.facilities,
    facilityMap: Object.fromEntries(rj.facilities.map((f) => [f.id, f])),
    doorReinforce: rj.doorReinforce,
    events: ej, cards: allCards, cardMap, broadcasts: ej.broadcasts,
    docs: dj.docs, docMap, layerGates: dj.layerGates, canonAnnals: dj.canonAnnals || [], narrations, kpis,
    sidestories: side.stories || [], sideMap: Object.fromEntries((side.stories || []).map((s) => [s.id, s])),
    ge, ensembleTemplates, quickstart, threads, relations, autonomy,
    seals: sj.seals || [], sealMap,
    prelude, map, mainline, historia
  };
}

/** 提示词模板加载（纯文本；sha 版本记录在 db 层） */
export function loadPrompt(name, dir = DEFAULT_PACK_DIR) {
  return readFileSync(join(dir, 'prompts', `${name}.md`), 'utf8');
}
