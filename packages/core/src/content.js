// 内容包加载与校验（技术架构 §5）：内容即数据，校验失败拒绝启动。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const characters = readJson(dir, 'characters.json').characters;
  const locations = readJson(dir, 'locations.json').locations;
  const rj = readJson(dir, 'recipes.json');
  const ej = readJson(dir, 'events.json');
  const dj = readJson(dir, 'docs.json');
  const narrations = readJson(dir, 'narrations.json');
  const kpis = readJson(dir, 'kpis.json');
  const sj = readJson(dir, 'seals.json');
  let ge = null;
  try { ge = readJson(dir, 'ge.json'); } catch { /* C 层守卫可选 */ }
  // 别传（可选文件）：旁传角色与旁传卡并入包（side 标记，主线不可见）
  let side = { sideChars: [], stories: [], cards: [] };
  try {
    side = readJson(dir, 'sidestories.json');
  } catch { /* 无别传包 */ }

  const itemMap = Object.fromEntries(items.map((i) => [i.id, i]));
  const charMap = Object.fromEntries(characters.map((c) => [c.id, c]));
  for (const sc of side.sideChars || []) charMap[sc.id] = { ...sc, sideOnly: true };
  const locMap = Object.fromEntries(locations.map((l) => [l.id, l]));
  const allCards = [...ej.cards, ...(side.cards || [])];
  const cardMap = Object.fromEntries(allCards.map((c) => [c.id, c]));
  const docMap = Object.fromEntries(dj.docs.map((d) => [d.id, d]));
  const sealMap = Object.fromEntries((sj.seals || []).map((x) => [x.id, x]));

  // —— 引用完整性校验（启动/种子化前必须通过）——
  const errs = [];
  const needItem = (id, where) => { if (!itemMap[id]) errs.push(`未知物品 ${id} @ ${where}`); };
  for (const l of locations) {
    if (!l.rooms?.length) errs.push(`地点 ${l.id} 无房间`);
    for (const r of l.rooms) {
      for (const c of r.containers || []) {
        for (const e of c.loot || []) { if ((e.w || 0) > 0) needItem(e.item, `${l.id}.${c.id}`); }
        for (const d of c.docs || []) if (!docMap[d]) errs.push(`未知文档 ${d} @ ${l.id}.${c.id}`);
      }
    }
    for (const d of l.docsPool || []) if (!docMap[d]) errs.push(`未知文档 ${d} @ ${l.id}.docsPool`);
    for (const n of l.npcs || []) {
      if (n.firstScript && !ej.cards.some((c) => c.for === n.firstScript)) {
        errs.push(`NPC ${n.id} 引用缺失脚本 ${n.firstScript}`);
      }
    }
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
  for (const c of characters) if (!c.ethics) errs.push(`角色 ${c.id} 缺伦理向量`);
  for (const c of ej.cards) {
    for (const o of c.options || []) {
      for (const cst of o.cost || []) needItem(cst.item, `事件 ${c.id}.${o.key}`);
      if (o.effects?.consumeChoice) for (const it of o.effects.consumeChoice) needItem(it, `事件 ${c.id}.${o.key}`);
    }
    const w = c.when || {};
    if (w.requiresChar && !charMap[w.requiresChar]) errs.push(`事件 ${c.id} 引用未知角色 ${w.requiresChar}`);
    for (const id of w.requiresChars || []) if (!charMap[id]) errs.push(`事件 ${c.id} 引用未知角色 ${id}`);
    for (const d of [w.requiresDoc, ...(w.requiresDocs || []), ...(w.requiresAnyDoc || [])].filter(Boolean)) {
      if (!docMap[d]) errs.push(`事件 ${c.id} 引用未知文档 ${d}`);
    }
    if (w.requiresFacility && !rj.facilities.some((f) => f.id === w.requiresFacility)) errs.push(`事件 ${c.id} 引用未知设施 ${w.requiresFacility}`);
  }

  if (errs.length) throw new Error('内容包校验失败：\n' + errs.join('\n'));

  return {
    manifest, items, itemMap, characters, charMap, locations, locMap,
    recipes: rj.recipes, facilities: rj.facilities,
    facilityMap: Object.fromEntries(rj.facilities.map((f) => [f.id, f])),
    doorReinforce: rj.doorReinforce,
    events: ej, cards: allCards, cardMap, broadcasts: ej.broadcasts,
    docs: dj.docs, docMap, layerGates: dj.layerGates, canonAnnals: dj.canonAnnals || [], narrations, kpis,
    sidestories: side.stories || [], sideMap: Object.fromEntries((side.stories || []).map((s) => [s.id, s])),
    ge,
    seals: sj.seals || [], sealMap
  };
}

/** 提示词模板加载（纯文本；sha 版本记录在 db 层） */
export function loadPrompt(name, dir = DEFAULT_PACK_DIR) {
  return readFileSync(join(dir, 'prompts', `${name}.md`), 'utf8');
}
