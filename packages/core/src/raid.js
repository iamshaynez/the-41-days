// 夜间袭击（内核设计 §7 R 系）。
import { aliveChars, homeValue, bestWeapons, difficultyCfg } from './state.js';
import { slumberGuard } from './causality.js';

export function resolveRaid(ctx) {
  const s = ctx.s, pack = ctx.pack, cfg = difficultyCfg(pack, s);
  if (s.assistTonight) return; // 协防邻居夜：袭击转向（事件卡已结算）
  if (!aliveChars(s).length) return; // 无人则无夜
  let p = Math.min(pack.manifest.raid.maxProb,
    pack.manifest.raid.baseProb + s.day / pack.manifest.raid.dayFactor
    + s.notoriety * pack.manifest.raid.notorietyFactor
    - (aliveChars(s).some((c) => c.guardTonight) ? pack.manifest.raid.guardDeter : 0)) * cfg.raidMul;
  // 家徒四壁减半（流民也懒得来）
  if (homeValue(s, pack) < 20) p *= 0.5;
  // v0.2 校准（交割月衰减）：D40 后城里能走的都走了——士族闭门、流民散尽、商路收摊，
  // 贼也是。交割前的压力从"抢"换成"空"，袭击概率逐日衰减（下限 0.3）。
  if (s.day > 40) p *= Math.max(0.3, 1 - (s.day - 40) * 0.05);
  if (!ctx.rng.chance(p)) {
    ctx.emit('RAID_RESOLVED', { type: 'none' });
    ctx.fact('raid_none', {});
    return;
  }
  // 夜窃变体（15%）：无声，晨报发现
  const quiet = ctx.rng.chance(0.15);
  // 威胁与防御（R-03：家产值 = 库存总值/10，再按 /50 折算——家当越多越招贼）
  const T = 2 + s.day / 5 + homeValue(s, pack) / 500 + s.notoriety;
  let guards = aliveChars(s).filter((c) => c.guardTonight || c.awakeTonight);
  // CY-32 危机兑现：被长期克扣口粮的守夜人可能"没听见"（因果引擎，至多一人）
  const slumbered = slumberGuard(ctx, guards);
  if (slumbered) {
    guards = guards.filter((g) => g.id !== slumbered.id);
    ctx.fact('raid_slumber', { char: slumbered.id });
  }
  const weapons = bestWeapons(s, pack).slice(0, Math.max(1, guards.length));
  const weaponPts = weapons.reduce((a, w) => a + w.weapon, 0);
  const D = weaponPts + guards.length * 2 + s.doorLevel * 2 + (s.house.opened.attic ? 1 : 0);

  // 袭击者类型（R-04 阶梯）
  let type = 'looters';
  if (s.day >= 15 && ctx.rng.chance(0.3)) type = 'drunks';
  else if (s.day >= 8 && ctx.rng.chance(0.5)) type = 'bandits';
  if (s.notoriety >= 3 && ctx.rng.chance(0.4)) type = 'vengeful';

  ctx.emit('RAID_RESOLVED', { type, T: Math.round(T * 10) / 10, D });
  let band;
  if (D >= T) band = 'repelled';
  else if (D >= 0.6 * T) band = 'repelled_hurt';
  else if (D >= 0.35 * T) band = 'theft';
  else band = 'bad';

  // 失窃（按类型口味取物）
  const appetite = { looters: ['food', 'raw', 'canned', 'water'], bandits: ['lux', 'bandage', 'meds', 'canned'], drunks: ['any'], vengeful: ['any'] }[type];
  const stolen = [];
  const stealBudget = { repelled: 0, repelled_hurt: 0.1, theft: 0.25, bad: 0.4 }[band] || 0;
  if (!quiet && stealBudget > 0) stealItems(ctx, stealBudget, appetite, stolen);

  const hurt = [];
  const awakeGuards = quiet ? [] : guards;
  if (band === 'repelled_hurt' && awakeGuards.length && ctx.rng.chance(0.5)) {
    const g = ctx.rng.pick(awakeGuards); ctx.setWound(g, g.wound + 1); hurt.push(g.id);
  }
  if (band === 'theft' && awakeGuards.length && ctx.rng.chance(0.5)) {
    const g = ctx.rng.pick(awakeGuards); ctx.setWound(g, g.wound + 1); hurt.push(g.id);
  }
  if (band === 'bad') {
    const pool = awakeGuards.length ? awakeGuards : aliveChars(s);
    if (!pool.length) return;
    const g = ctx.rng.pick(pool);
    ctx.setWound(g, Math.max(g.wound, ctx.rng.chance(0.5) ? 2 : 1)); hurt.push(g.id);
    if (ctx.rng.chance(0.1)) { ctx.setWound(g, 3); ctx.fact('raid_mortal', { char: g.id }); }
  }
  // 门受损（B-08）
  if (band !== 'repelled' && s.doorLevel > 0) { s.doorLevel--; ctx.emit('DOOR_LEVEL', { to: s.doorLevel }); }
  // 心情（R-07）
  if (band === 'repelled') ctx.moodAll(1, '击退夜袭');
  else ctx.moodAll(-2, '被袭失窃');

  ctx.emit('RAID_OUTCOME', { band, quiet, stolen, hurt });
  ctx.fact('raid', { band, type, quiet, stolen, hurt });
}

function stealItems(ctx, budget, appetite, stolen) {
  const s = ctx.s, pack = ctx.pack;
  const total = homeValue(s, pack);
  let toSteal = total * budget;
  const foodCats = new Set(['food']);
  const items = pack.items.filter((i) => (s.inventory[i.id] || 0) > 0 && !i.docOnly);
  const pickable = items
    .filter((i) => appetite.includes('any') ? true : appetite.includes('food') ? foodCats.has(i.cat) : appetite.includes('lux') ? ['贵重', '嗜好', '药品'].includes(i.cat) : true)
    .sort((a, b) => (appetite.includes('food') ? (foodCats.has(b.cat) - foodCats.has(a.cat)) : b.value - a.value));
  for (const it of pickable) {
    if (toSteal <= 4) break;
    while ((s.inventory[it.id] || 0) > 0 && toSteal > 4) {
      ctx.takeItem(it.id, 1, '被窃'); stolen.push(it.id); toSteal -= it.value;
    }
  }
}
