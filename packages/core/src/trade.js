// 交易（内核设计 §3.3 E 系）：鲁舟泊船生成、价格带、成交校验（LLM 只能在带内演出）。
import { charById, difficultyCfg } from './state.js';
import { recordCausal } from './causality.js';
import { priceMulOf } from './mainline.js';

const COMMON = ['parts', 'wood', 'water', 'raw', 'veg', 'firewood'];
const MID = ['comp', 'canned', 'sugar', 'book', 'tobacco', 'herb', 'fuel'];
const RARE = ['bandage', 'meds', 'herbmed', 'cigs', 'coffee', 'elec', 'chem', 'lockpick'];

/** 生成一次鲁舟摊位（E-04/E-05）。返回 stock: [{item, n, buy(他卖你的价)}] */
export function genFrankoStock(ctx) {
  const s = ctx.s, m = ctx.pack.manifest.franko;
  const cfg = difficultyCfg(ctx.pack, s);
  const n = ctx.rng.range(m.skuCount[0], m.skuCount[1]);
  // 唯一物品 × 权重的候选池（COMMON 常备、MID 中档、RARE 稀缺、冬季燃料必带）
  const pool = [];
  for (const it of COMMON) pool.push({ w: 5, v: it });
  for (const it of MID) pool.push({ w: 3, v: it });
  if (ctx.rng.chance(0.4)) pool.push({ w: 2, v: ctx.rng.pick(RARE) });
  if (s.winterActive) { pool.push({ w: 6, v: 'firewood' }); pool.push({ w: 4, v: 'fuel' }); }
  const seen = new Set();
  const stock = [];
  let tries = 0;
  while (stock.length < n && tries++ < n * 10) {
    const it = ctx.rng.weighted(pool).v;
    if (seen.has(it)) continue;
    seen.add(it);
    const item = ctx.pack.itemMap[it];
    let mult = ctx.rng.range(m.priceBuy[0] * 100, m.priceBuy[1] * 100) / 100;
    if (s.winterActive && ['firewood', 'fuel'].includes(it)) mult *= 2;
    // v0.2 校准：交割日固定 D60，燃料的摊位数量加厚（其余 SKU 不变）；
    // 食物摊刻意减薄（3）：船牙喂不活一个从不出门的家——守家经济的食物有上限
    // （F-03 修复后睡床治愈让守家近乎无敌，渡口成了唯一能掐住的活命线）
    const nMax = ['firewood', 'fuel'].includes(it) ? 6 : item.cat === '食物' ? 3 : 5;
    stock.push({ item: it, n: ctx.rng.range(2, nMax), buy: Math.max(1, Math.round(item.value * mult * cfg.tradeMul * priceMulOf(s, it))) }); // 涟漪物价（史实共振）：锚步改市况
  }
  return stock;
}

/** 玩家出售单价（他收购）：带 + 角色修正（E-06/E-07） */
export function sellPrice(ctx, itemId) {
  const s = ctx.s, m = ctx.pack.manifest.franko;
  const cfg = difficultyCfg(ctx.pack, s);
  const item = ctx.pack.itemMap[itemId];
  let mult = 0.55 + (0.7 - 0.55) * ctx.rng._next();
  // E-09 文档异常价：固定 8
  if (item.docOnly) mult = 1;
  let p = Math.round(item.value * mult * cfg.tradeMul * priceMulOf(s, itemId)); // 涟漪物价同压两端（史实共振）
  if (charById(s, 'katya')) p = Math.round(p * 1.15);
  else if (charById(s, 'vera')) p = Math.round(p * 1.10);
  else if (charById(s, 'yura')) p = Math.round(p * 0.9);
  if (item.docOnly) p = 8;
  return Math.max(1, p);
}

/**
 * 成交校验（LLM 谈判只影响 ±10% 浮动，越带即拒）。
 * trade: { give: {item:n}, get: {item:n}(从 stock), premium?: 谈判让利比例 0~0.1 }
 */
export function executeTrade(ctx, trade) {
  const s = ctx.s;
  if (!s.franko) return { ok: false, reason: 'NO_MERCHANT' };
  const stock = s.franko.stock;
  const giveVal = Object.entries(trade.give || {}).reduce((a, [id, n]) => a + sellPrice(ctx, id) * n, 0);
  let getVal = 0;
  for (const [id, n] of Object.entries(trade.get || {})) {
    const sku = stock.find((x) => x.item === id);
    if (!sku || sku.n < n) { ctx.fact('trade_no_stock', { item: id }); return { ok: false, reason: 'NO_STOCK' }; }
    getVal += sku.buy * n;
  }
  const negotiate = charById(s, 'katya') ? 0.15 : (charById(s, 'vera') ? 0.10 : (trade.premium || 0));
  if (giveVal + 0.001 < getVal * (1 - negotiate)) {
    ctx.fact('trade_reject', { giveVal, getVal });
    ctx.emit('TRADE_REJECTED', { giveVal, getVal });
    return { ok: false, reason: 'PRICE_BAND' };
  }
  // 执行
  for (const [id, n] of Object.entries(trade.give || {})) {
    if (!ctx.hasItem(id, n)) return { ok: false, reason: 'NO_ITEM' };
    ctx.takeItem(id, n, '售出');
    if (ctx.pack.itemMap[id].docOnly) {
      // 卖的不是纸，是符传与更籍（E-09/因果引擎：truth 标签，薄姑与白简的敏感区）
      recordCausal(ctx, 'trade_evidence', { target: 'franko', weight: 4 * n, note: id });
    }
    if (ctx.pack.itemMap[id].docOnly && (charById(s, 'katya') || charById(s, 'vera')) && !s.firedOnce['doc_price_odd']) {
      s.firedOnce['doc_price_odd'] = true;
      ctx.addKnowledge(1, '异常收购价');
      ctx.fact('doc_price_odd', {});
    }
  }
  for (const [id, n] of Object.entries(trade.get || {})) {
    const sku = stock.find((x) => x.item === id);
    sku.n -= n;
    ctx.addItem(id, n, '购入');
  }
  ctx.emit('TRADE_DONE', { give: trade.give, get: trade.get });
  ctx.fact('trade_done', { give: trade.give, get: trade.get });
  return { ok: true };
}
