// 破晓结算（内核设计 PH-02 八步顺序）与六轴状态机。
// 顺序即测试顺序：归位→饥饿→伤病→疲劳→温度→心情→日进→抽取。
import { moodLevel, apMaxOf, difficultyCfg, aliveChars, charById } from './state.js';
import { fireEventCard } from './events.js';
import { genFrankoStock } from './trade.js';
import { recordCausal } from './causality.js';
import { threadsFrankoPick } from './threads.js';
import { unlockMet } from './unlock.js';
import { stepGateOk } from './mainline.js';

const mod = (n) => n;

/** 步骤②：饥饿 tick（H-02/H-04） */
export function tickHunger(ctx) {
  const cfg = difficultyCfg(ctx.pack, ctx.s);
  for (const c of aliveChars(ctx.s)) {
    const to = c.hunger === 4 ? 3 : Math.max(0, c.hunger - 1);
    ctx.setHunger(c, to, '过了一日');
    if (to === 1) ctx.mood(c, -1, '严重饥饿拖累');
    // 因果：柜里有粮，锅里无饭——这是选择，不是命运（CY-01 deny_food）
    if (to <= 1 && ['meal', 'canned', 'raw', 'meat'].some((i) => ctx.hasItem(i))) {
      recordCausal(ctx, 'deny_food', { target: c.id });
    }
    // H-04（v1 修订）：渐进式——首次濒死 50% 转微恙，带病挨饿才升重病
    if (to === 0 && ctx.rng.chance(cfg.starveSick)) {
      ctx.setSick(c, c.sick >= 1 ? Math.max(c.sick, 2) : 1, '饿出病来');
      ctx.fact('starve_sick', { char: c.id });
    }
  }
}

/** 步骤③：伤病结算矩阵（I-08 全表）
 *  cfg 软化系数（内容包难度档提供，缺省 1=原版压力）：
 *  woundWorseMul 未治伤恶化概率、woundDeathMul 危重致死概率、breakdownLeaveMul 崩溃离队概率——
 *  单一低难度靠这三根旋钮保住"多数局能走到交割日"，机制本身不变。 */
export function tickHealth(ctx) {
  const day = ctx.s.day;
  const cfg = difficultyCfg(ctx.pack, ctx.s);
  const worseMul = cfg.woundWorseMul ?? 1;
  const deathMul = cfg.woundDeathMul ?? 1;
  const healerHome = aliveChars(ctx.s).some((c) => c.traits?.healer);
  for (const c of aliveChars(ctx.s)) {
    const woundTreated = c.woundTreatedDay === day - 1;
    const sickTreated = c.sickTreatedDay === day - 1 || c.sickTreatedHerb;
    // rested 分两档（F-03 落地的平衡面）：
    //  deepRested = 白天刻意卧床（actRest）——「治过又卧床一整日」的即刻见效只认它；
    //  rested = 任何休养（含夜里睡床）——推进渐进恢复分支（养两日伤势降档）。
    // 夜里睡床人人有份，若也算即刻见效，夜夜带伤的亡命徒等于自带疗养院——
    // 乱玩曲线（赌徒/恶魔）会被治愈压平（实测 sim：赌徒存活 29%→68%）。
    // 另：饿着肚子（hunger<2），觉也白睡——养伤养病都要求吃得饱，
    // 守着家不往外找吃的的活法，治愈会先耗尽（平衡不变量：守家不优于外出）
    const canHeal = c.hunger >= 2;
    const deepRested = canHeal && (c.bedRest || ctx.nightBedRest?.has(c.id) || false);
    const rested = deepRested || (canHeal && ctx.nightBeds?.has(c.id)) || false;

    // —— 伤 ——
    if (c.wound === 3) {
      if (woundTreated && deepRested && healerHome) { ctx.setWound(c, 2, '治过又有人照看'); }
      else if (ctx.rng.chance(0.5 * deathMul)) { ctx.fact('dying_wound', { char: c.id }); ctx.die(c, '重伤不治'); continue; }
      else ctx.fact('critical_wound_hold', { char: c.id });
    } else if (c.wound === 2) {
      if (woundTreated && deepRested) ctx.setWound(c, 1, '治过又卧床静养');
      else if (rested) {
        c.woundRestDays++;
        if (c.woundRestDays >= 2) { ctx.setWound(c, 1, '卧床将养'); c.woundRestDays = 0; }
        if (ctx.rng.chance(0.2 * worseMul)) { c.woundUntreatedDays = 3; }
      } else if (ctx.rng.chance(0.3 * worseMul)) { ctx.setWound(c, 3, '伤未医治，恶化了'); ctx.fact('wound_worse', { char: c.id }); }
      if (!woundTreated) c.woundUntreatedDays++;
    } else if (c.wound === 1) {
      if (rested) ctx.setWound(c, 0, '静养好了'); // 轻伤：睡好两晚就能好
      else { c.woundRestDays++; if (c.woundRestDays >= 3) ctx.setWound(c, 0, '将养数日好了'); }
      if (!woundTreated) c.woundUntreatedDays++;
    } else { c.woundUntreatedDays = 0; c.woundRestDays = 0; }
    // 感染交叉（I-06）
    if (c.wound >= 2 && c.woundUntreatedDays >= 3 && c.sick === 0 && ctx.rng.chance(0.3)) {
      ctx.setSick(c, 1, '伤口感染了'); ctx.fact('infection', { char: c.id });
    }

    // —— 病 ——
    if (c.sick === 3) {
      if (sickTreated && deepRested && healerHome) {
        c.sickRestDays++;
        if (c.sickRestDays >= 2) { ctx.setSick(c, 2, '治过又有人照看'); c.sickRestDays = 0; }
      } else if (sickTreated && deepRested) {
        if (ctx.rng.chance(0.35 * deathMul)) { ctx.fact('dying_sick', { char: c.id }); ctx.die(c, '重病不治'); continue; }
      } else if (ctx.rng.chance(0.5 * deathMul)) { ctx.fact('dying_sick', { char: c.id }); ctx.die(c, '重病不治'); continue; }
      else ctx.fact('critical_sick_hold', { char: c.id });
    } else if (c.sick === 2) {
      if (sickTreated && deepRested) ctx.setSick(c, 1, '治过又卧床静养');
      else if (rested) {
        c.sickRestDays++;
        if (c.sickRestDays >= 2) { ctx.setSick(c, 1, '卧床将养'); c.sickRestDays = 0; }
      } else if (ctx.rng.chance(0.15 * worseMul)) ctx.setSick(c, 3, '病未医治，恶化了');
      if (c.sickTreatedHerb) { c.sickTreatedHerb = false; } // 草药药只顶一晨
    } else if (c.sick === 1) {
      if (rested || sickTreated) {
        c.sickRestDays++;
        if (c.sickRestDays >= 2) { ctx.setSick(c, 0, '将养数日好了'); c.sickRestDays = 0; }
      }
    }
    ctx.emit('CHAR_FLAGS', { char: c.id, woundRestDays: c.woundRestDays, woundUntreatedDays: c.woundUntreatedDays, sickRestDays: c.sickRestDays, sickUntreatedDays: c.sickUntreatedDays, sickTreatedHerb: !!c.sickTreatedHerb });
  }
}

/** 步骤④：疲劳结算（F-02/F-03/F-05 落地）——夜是三口人的夜：
 *  夜访者整夜未眠 +1；守卫遇袭之夜 +1（安静夜睡椅打盹与累积相抵，净零不落账）；
 *  安睡者恢复：睡床 −2（床位够）、地板/半宿 −1。床位分配见 assignNightBeds。
 *  夜里排班（bedRest/guardTonight）会被 advanceDay 在 tick 之前重置——
 *  判定用 toDawn 里存好的快照（ctx.nightBedRest / ctx.nightGuard / ctx.nightBeds）。 */
export function assignNightBeds(ctx) {
  const s = ctx.s;
  const beds = (s.facilities.bed || 0) + (s.facilities.bed_good || 0);
  if (!beds) return new Set();
  // 床位不足时优先给：卧床养伤者 > 重伤病 > 疲惫者（F-05 床位约束）
  const rank = (c) => (c.bedRest ? 3 : 0) + (c.wound >= 2 || c.sick >= 2 ? 2 : 0) + (c.fatigue >= 1 ? 1 : 0);
  const sleepers = aliveChars(s)
    .filter((c) => !c.awakeTonight && !ctx.nightHalfSlept?.has(c.id)) // 换守半宿者不占床
    .sort((a, b) => rank(b) - rank(a));
  return new Set(sleepers.slice(0, beds).map((c) => c.id));
}
export function tickFatigue(ctx) {
  const s = ctx.s;
  const out = ctx.outTonight || null;   // 今晚真正出门的人（endNightReturn 置位）
  const quiet = !ctx.nightRaided;       // 劫掠真来了（raid.js 置位）守卫才整夜无眠
  for (const c of aliveChars(s)) {
    if (c.awakeTonight) {
      const isOut = out != null && c.id === out;
      if (quiet && !isOut) { /* F-05 守卫睡椅打盹，与 F-02 相抵——不落账 */ }
      else ctx.setFatigue(c, c.fatigue + 1, isOut ? '夜访未眠' : '守夜未眠');
    } else if (c.fatigue > 0) {
      const half = !!ctx.nightHalfSlept?.has(c.id);
      const bed = !half && ctx.nightBeds?.has(c.id);
      const to = Math.max(0, c.fatigue - (half ? 1 : bed ? 2 : 1));
      if (to !== c.fatigue) {
        ctx.setFatigue(c, to, half ? '半宿将息' : bed ? '睡床安睡' : '安睡将息');
        ctx.fact('night_rest', { char: c.id, bed: !!bed, half });
      }
    }
    c.awakeTonight = false;
    ctx.emit('CHAR_FLAG', { char: c.id, key: 'awakeTonight', val: false });
  }
}

/** 步骤⑤：温度结算（T-03/T-04/H-11） */
export function tickTemperature(ctx) {
  const s = ctx.s;
  if (s.winterActive) {
    const sev = s.weather === 'cold' ? 3 : (s.weather === 'snow' ? 2 : 1);
    const burn = s.facilities.heater_iron ? 3 : (s.facilities.heater ? 2 : 0);
    s.heatedTonight = false;
    ctx.emit('FLAG', { key: 'heatedTonight', val: false });
    if (burn > 0) {
      // 自动烧火：铁炉优先柴/燃料，火盆只烧柴（Z-02 炉火策略）
      let ok = false;
      if (s.facilities.heater_iron && ctx.hasItem('fuel', 1)) { ctx.takeItem('fuel', 1, '取暖'); ok = true; }
      else if (ctx.hasItem('firewood', 2)) { ctx.takeItem('firewood', 2, '取暖'); ok = true; }
      else if (burn >= 3 && ctx.hasItem('firewood', 1)) { ctx.takeItem('firewood', 1, '取暖'); ok = true; }
      s.heatedTonight = ok;
      ctx.emit('FLAG', { key: 'heatedTonight', val: ok });
    }
    if (burn - sev < 0) {
      for (const c of aliveChars(s)) {
        const p = c.frail || c.wound >= 1 || c.sick >= 1 ? 0.3 : 0.18;
        if (ctx.rng.chance(p) && c.sick === 0) { ctx.setSick(c, 1, '冬夜受寒'); ctx.fact('cold_sick', { char: c.id }); }
      }
    }
    // 铁炉化雪（H-11）
    if (s.weather === 'snow' && s.facilities.heater_iron && s.heatedTonight) ctx.addItem('water', 1, '化雪');
  }
}

/** 步骤⑥：心情拖累与崩溃链（M-05/M-14） */
export function tickMood(ctx) {
  const cfg = difficultyCfg(ctx.pack, ctx.s);
  const leaveMul = cfg.breakdownLeaveMul ?? 1;
  for (const c of aliveChars(ctx.s)) {
    if (c.wound >= 2) ctx.mood(c, -1, '重伤拖累');
    if (c.addiction && ctx.s.day - c.addictionServedDay > 1) ctx.mood(c, -1, '瘾头');
    // 崩溃链推进（可被安抚累计 +4 逆转）
    if (c.breakdown) {
      if (c.soothed >= 4) {
        c.breakdown = null; c.soothed = 0;
        ctx.emit('BREAKDOWN_RECOVERED', { char: c.id });
        ctx.fact('breakdown_recovered', { char: c.id });
      } else if (c.breakdown.stage >= 2) {
        // 第 3 晨：离队或自伤
        if (ctx.rng.chance(0.5 * leaveMul)) {
          ctx.fact('breakdown_left', { char: c.id });
          ctx.die(c, '崩溃离队'); // 移出队伍（带走份额的叙事由 facts 承载）
        } else {
          ctx.setWound(c, 2, '崩溃自戕');
          for (const o of aliveChars(ctx.s)) if (o.id !== c.id) ctx.moodRaw(o, -4, '同伴崩溃自伤');
          c.breakdown = null; c.soothed = 0;
          // 事件镜像（回放一致性铁律）：这层清零必须能被 fold 还原——
          // 旧版在此静默清零，重放永远停在崩溃态（管理台 replay match:false）
          ctx.emit('BREAKDOWN_CALM', { char: c.id, selfhurt: true });
        }
      } else {
        c.breakdown.stage++;
        ctx.emit('BREAKDOWN_STAGE', { char: c.id, stage: c.breakdown.stage });
        ctx.fact('breakdown_stage', { char: c.id, stage: c.breakdown.stage });
      }
    }
  }
}
/** 生产设施结算（H-09/H-10/K 表：陷阱/园子/蒸馏/集雨） */
export function tickProduction(ctx) {
  const s = ctx.s, day = s.day;
  if (s.facilities.trap && s.facilities.trapBaited && day - s.facilities.trapDay >= 3) {
    if (ctx.rng.chance(0.5)) { ctx.addItem('raw', 1, '捕鼠'); ctx.fact('trap_caught', {}); }
    else ctx.fact('trap_empty', {});
    // v1 简化：自动补饵（诱饵成本并入建造维护的叙事）
    s.facilities.trapDay = day;
    ctx.emit('FACILITY_STATE', { facility: 'trapDay', to: day });
  }
  const gardenLevel = s.facilities.garden_veg || s.facilities.garden;
  const gardenDef = ctx.pack.recipes?.facilities?.find((f) => f.id === (s.facilities.garden_veg ? 'garden_veg' : 'garden'));
  if (gardenLevel && s.facilities.gardenStarted > 0 && day - s.facilities.gardenStarted >= (gardenDef?.days || (s.facilities.garden_veg ? 5 : 4))) {
    const yieldItems = gardenDef?.yield || (s.facilities.garden_veg ? { veg: 3 } : { herb: 3 });
    for (const [it, n] of Object.entries(yieldItems)) ctx.addItem(it, n, '园子');
    s.facilities.gardenStarted = -9;
    ctx.emit('FACILITY_STATE', { facility: 'gardenStarted', to: -9 });
    ctx.fact('garden_harvest', yieldItems);
  }
  if (s.facilities.distill && s.facilities.distillReady > 0 && day >= s.facilities.distillReady) {
    ctx.addItem('moonshine', 1, '蒸馏'); s.facilities.distillReady = -9;
    ctx.emit('FACILITY_STATE', { facility: 'distillReady', to: -9 });
    ctx.fact('moonshine_ready', {});
  }
  // 集雨（雨天 ×2，雪天需滤网）
  if (s.facilities.rain && s.weather === 'rain') ctx.addItem('water', 2, '集雨');
  else if (s.facilities.rain_filter && s.weather === 'snow') ctx.addItem('water', 1, '集雪');
  // 借出工具归还（事件卡 flag）
  if (s.shovelReturnDay && day >= s.shovelReturnDay) {
    ctx.addItem('shovel', 1, '归还'); s.shovelReturnDay = 0;
    ctx.emit('FLAG', { key: 'shovelReturnDay', val: 0 });
    ctx.moodAll(1, '邻里守信'); ctx.fact('shovel_returned', {});
  }
}

/** 战争与季节推进（§9 W 系 + T-01） */
export function tickWar(ctx) {
  const s = ctx.s, war = s.war;
  // ── v0.3 军心环境账（同步日历）：日子过得越体面，"家里都好"传得越远 ──
  // 家里有存粮的每一天，家访的簿子上就多一笔安。这是历史的暗河：
  // 吕蒙不需要说服任何人，他只需要让每家都过得去。（溶解阈值见 manifest.war.dissolveThreshold）
  if (!s.sidestory) {
    const foodTotal = ['meal', 'canned', 'raw', 'meat', 'veg'].reduce((a, i) => a + (s.inventory[i] || 0), 0);
    const drift = foodTotal >= 6 ? 0.5 : 0;
    if (drift) {
      s.dissolve = (s.dissolve || 0) + drift;
      ctx.emit('FLAG', { key: 'dissolve', val: s.dissolve });
    }
  }
  if (!s.winterActive && s.day >= s.winterStart) {
    s.winterActive = true;
    ctx.emit('WINTER_START', { end: s.winterEnd });
    ctx.fact('winter_start', {});
  }
  if (s.winterActive && s.day > s.winterEnd) {
    s.winterActive = false;
    ctx.emit('WINTER_END', {}); ctx.fact('winter_end', {});
  }
  if (!war.telegraphed && !s.sidestory && s.day >= war.endDay - ctx.pack.manifest.war.telegraphDays) { // 别传没有交割前兆
    war.telegraphed = true;
    ctx.emit('WAR_TELEGRAPH', {}); ctx.fact('war_telegraph', {});
  }
  if (!war.ended && s.eventFlags.lighthouse_day && s.day >= s.eventFlags.lighthouse_day) {
    war.ended = true; war.endingType = 'lighthouse';
    ctx.emit('WAR_ENDED', { type: 'lighthouse', day: s.day });
    ctx.fact('war_lighthouse', {});
  }
  // 出江陵记（W-04）：接了券局的价，当夜解缆——你离席了，剩下的天数由别人数
  if (!war.ended && s.eventFlags.join_table) {
    war.ended = true; war.endingType = 'join_table';
    ctx.emit('WAR_ENDED', { type: 'join_table', day: s.day });
    ctx.fact('war_join_table', {});
  }
  // ── D41 铰链（正典圣经 v0.3 §8：三刀）─────────────────────────────
  // 刀落/刀偏须同时满足两件事：手上有历史杠杆（证据/烽鼓/机关），且军心未散
  // （dissolve < 阈值——家访与家书四十一天累积的暗河没有漫过河床）。
  // 只有杠杆而军心已散：刀照样落——一个人拦不住已经化掉的大军，史册连你拦过都不记。
  // 没有杠杆而军心未散：刀也落——个人的沉默拦得住一封家书，拦不住大势。
  // 这两条都归入正史，但野史批注会记下你拦过。
  if (!war.ended && s.day >= war.endDay) {
    war.ended = true;
    const th = ctx.pack.manifest.war.dissolveThreshold ?? 22;
    const armyHeld = (s.dissolve || 0) < th;
    // 军事杠杆（须军心未散才撬得动大势）：麦城鼓 / 火线证据 / 双杠杆叠加
    const mil = (s.eventFlags.alt_maicheng && s.eventFlags.alt_jiangling) ? 'alt_both'
      : s.eventFlags.alt_maicheng ? 'maicheng'
      : s.eventFlags.alt_jiangling ? 'pyrrhic'
      : null;
    // 人心杠杆（《蜀记》"权欲活羽"的争论）：一页联名帖压秤——不看军心，
    // 配合到底的家只要读够了这座城，也救得下那条命
    const plea = s.eventFlags.alt_plea ? 'hostage' : null;
    war.endingType = armyHeld ? (mil || plea || 'ceasefire') : (plea || 'ceasefire');
    war.armyHeld = armyHeld;      // 野史批注用：军心未散而刀仍落 → 「你拦过，史官不知道」
    war.leverHad = !!mil;         // 军事杠杆而军心已散 → 「机关拆了，军队散了」（联名帖不在此列）
    // 铰链读数随事件落盘（A-2 二周目实测：只写 state 不发事件，fold 重放即丢这对字段）
    ctx.emit('WAR_ENDED', { type: war.endingType, day: s.day, armyHeld, leverHad: war.leverHad });
  }
  if (!war.ended && s.day >= ctx.pack.manifest.war.forceEndDay) {
    war.ended = true; war.endingType = 'contract_end';
    ctx.emit('WAR_ENDED', { type: 'contract_end', day: s.day });
  }
}

/** 步骤⑦：日计数、天气、AP 刷新、商人排期（快照随 DAY_STARTED 落盘；事件抽取由 resolve 在 tick 后调用） */
export function advanceDay(ctx) {
  const s = ctx.s;
  s.day += 1;
  s.weatherForecast = null;
  const winter = s.winterActive;
  const wTable = winter
    ? [{ w: 3, v: 'snow' }, { w: 2, v: 'cold' }, { w: 2, v: 'fog' }, { w: 1, v: 'clear' }]
    : [{ w: 4, v: 'clear' }, { w: 2, v: 'fog' }, { w: 2, v: 'rain' }, { w: winter ? 1 : 0, v: 'snow' }];
  const old = s.weather;
  s.weather = ctx.rng.weighted(wTable).v;
  if (old !== s.weather) ctx.emit('WEATHER', { to: s.weather });
  for (const c of aliveChars(s)) {
    c.ap = apMaxOf(c); c.bedRest = false; c.guardTonight = false; c.readToday = false;
  }
  s.assistTonight = false;
  // 商人排期（E-04）：昨日来访的收摊，新的一天按排期到访
  if (s.franko) {
    s.franko = null;
    ctx.fact('franko_left', {});
  }
  if (!s.sidestory && s.day >= s.frankoNextDay) { // 别传无船牙（鲁舟自己的船上不该有第二个鲁舟）
    s.frankoNextDay = s.day + ctx.rng.range(ctx.pack.manifest.franko.cadence[0], ctx.pack.manifest.franko.cadence[1]);
    const stock = genFrankoStock(ctx);
    s.franko = { merchant: 'franko', stock };
    ctx.emit('FRANKO_ARRIVE', { stock });
    // 回响（EC/出江陵记的跨周目代价）：接受过券局提议的人，商路第一眼就认得
    const dark = !!(s.echoes?.joinTableDark && !s.echoes.frankoGreeted);
    if (dark) s.echoes.frankoGreeted = true;
    // 外客连续性（F·戏剧弧）：船牙每访捎一句城里的话——最近一件大事，
    // 常客是城与家之间的信使，不是一张会走路的价目表
    const stepMap = new Map((ctx.pack.mainline?.steps || []).map((x) => [x.id, x]));
    const news = [...(s.mainline || [])].reverse().map((m) => m.stepId && stepMap.get(m.stepId)?.title).find(Boolean) || null;
    const say = threadsFrankoPick(ctx); // 线的捎话轨（回响节拍器）：母题句搭船牙的船
    ctx.fact('franko_incoming', { ...(dark ? { dark: true } : {}), ...(news ? { news } : {}), ...(say ? { say } : {}) });
  }
  ctx.emit('DAY_STARTED', { day: s.day, weather: s.weather, snapshot: structuredClone(s) });
}

/** 晨间事件抽取（V-01/V-02：时间轴必发 + 随机外部 55%） */
export function drawMorningEvents(ctx) {
  const s = ctx.s, cards = ctx.pack.cards;
  // 地点解锁扫描（E 系情报门槛 + 城市扩展依赖链）：条件到位即解锁，晨报追认。
  // 依赖口径：intelUnlock=旗标（旧）；requires=组合条件（visitedAny/visitedAll/flags/docs/minDay）；
  // 周目池外的地点（unlockMet 内裁剪）永不开——一周目去不全城。
  for (const loc of s.locationsCache || []) { /* noop 占位防旧档 */ }
  for (const loc of ctx.pack.locations) {
    if (loc.home || s.knownLocs.includes(loc.id)) continue;
    if ((loc.side || null) !== (s.sidestory?.id || null)) continue; // 别传只认自家场；江陵的门在别传里不开
    if (unlockMet(s, ctx.pack, loc)) {
      s.knownLocs.push(loc.id);
      ctx.emit('LOC_KNOWN', { loc: loc.id });
      ctx.fact('loc_unlocked', { loc: loc.name });
    }
  }
  // 或然种子注入（正典圣经-v0.2 §8：满足即触发，无骰；优先于时间轴与随机抽取）
  if (!s.activeEvent && !s.war.ended && !s.sidestory) { // 别传局不注入主线或然
    // 或然 B《惨胜》：火线勘破（#058 勘验 + #063 手令）+ 里社渠道 + D30 前
    if (!s.firedOnce['alt_jiangling'] && !s.eventFlags.alt_jiangling
      && s.day <= 30 && ['#058', '#063'].every((d) => s.docsSeen.includes(d))
      && (s.reputation?.church || 0) >= 1
      && s.eventFlags.fire_witness) { // 濠鼠活证（正典圣经-v0.2 §7.2：人证齐了才谈得上拆机关）
      s.firedOnce['alt_jiangling'] = true;
      fireEventCard(ctx, 'alt_jiangling');
      return;
    }
    // 或然 A《麦城得脱》：交割前夜之晨（endDay-1），素徽线已揭示 + 逄灶在 + 知晓度 8
    if (!s.firedOnce['alt_maicheng_drum'] && !s.eventFlags.alt_maicheng
      && s.day === s.war.endDay - 1
      && charById(s, 'zofia') && charById(s, 'alexey')
      && s.eventFlags.zofia_brother && s.knowledge >= 8) {
      s.firedOnce['alt_maicheng_drum'] = true;
      fireEventCard(ctx, 'alt_maicheng_drum');
      return;
    }
  }
  // 时间轴卡（timeline）：窗口内必发一次
  for (const card of cards.filter((c) => c.kind === 'timeline')) {
    if ((card.side || null) !== (s.sidestory?.id || null)) continue; // 别传卡只进别传局，主线亦然
    const [lo, hi] = card.when.dayWindow || [];
    if (card.when.at === 'dusk') continue; // 黄昏卡走 drawDuskEvents
    if (s.firedOnce[card.id]) continue; // firedOnce 的语义就是"发过一次"——不论从哪条路径烧的
    if (!flagGateOk(s, card.when)) continue;
    if (card.when.requiresChar && !charById(s, card.when.requiresChar)) continue; // 人不在，他的那一页就翻过去
    if (card.when.requiresChars && !card.when.requiresChars.every((id) => charById(s, id))) continue;
    if (!stepGateOk(s, ctx.pack, card.when)) continue; // 主线门控（史实共振）：锚前期待窗/锚后余波窗
    if (lo !== undefined && (s.day < lo || s.day > hi)) continue;
    if (s.activeEvent) break; // 一次一张
    s.firedOnce[card.id] = true;
    ctx.emit('FLAG', { key: 'firedOnce', val: structuredClone(s.firedOnce) });
    fireEventCard(ctx, card.id);
    break;
  }
  if (s.activeEvent) return;
  // C 心事保底前置（史实共振加固）：D15 起心结首拍欠着的人先于随机晨抽显形——
  // 余波卡/停问把晨位占满的日子，心事不再无限期让路（「人人有心结」由内核兜底，
  // 不再赌空晨）。D12~14 仍留给随机池自然接住，之后硬保证。
  if (!s.sidestory && s.day >= 15) {
    const pending = aliveChars(s)
      .map((c) => ctx.pack.charMap[c.id]?.persona?.knotCard)
      .filter((id) => id && ctx.pack.cardMap[id] && !s.firedOnce[id]);
    if (pending.length) {
      s.firedOnce[pending[0]] = true;
      ctx.emit('FLAG', { key: 'firedOnce', val: structuredClone(s.firedOnce) });
      fireEventCard(ctx, pending[0]);
      return;
    }
  }
  drawRandomPool(ctx);
}

/** 随机外部/内部卡（V-02：55%）——晨抽的尾段；别传的黄昏在没有暮卡时也从这里抽一张 */
export function drawRandomPool(ctx) {
  const s = ctx.s, cards = ctx.pack.cards;
  if (!ctx.rng.chance(0.55)) return;
  const eligible = cards.filter((c) => {
    if (c.kind !== 'knock' && c.kind !== 'internal') return false;
    if ((c.side || null) !== (s.sidestory?.id || null)) return false;
    // 或然注入路径会把命运卡写进 firedOnce 但不标 when.once——发过就是发过，不许从随机池重入
    // （一周目实测：《火线·证据交给谁》D6 或然触发、D29 又被随机池抽中重演）
    if (s.firedOnce[c.id]) return false;
    const w = c.when || {};
    if (w.chance === 0) return false; // 零概率卡（或然手作卡）只走或然注入路径，不入随机池
    if (s.eventCooldowns[c.id] && s.day < s.eventCooldowns[c.id]) return false;
    if (w.requiresChar && !charById(s, w.requiresChar)) return false;
    if (w.requiresChars && !w.requiresChars.every((id) => charById(s, id))) return false; // 对子卡：两人同局才触发（REL-01）
    if (!flagGateOk(s, w)) return false;
    if (w.requiresDoc && !s.docsSeen.includes(w.requiresDoc)) return false;
    if (w.requiresDocs && !w.requiresDocs.every((d) => s.docsSeen.includes(d))) return false;
    if (w.requiresAnyDoc && !w.requiresAnyDoc.some((d) => s.docsSeen.includes(d))) return false;
    if (w.requiresFacility && !s.facilities[w.requiresFacility]) return false;
    if (!stepGateOk(s, ctx.pack, w)) return false; // 主线门控（史实共振）：日常卡感知锚步
    if (w.knowledge && s.knowledge < w.knowledge - (s.echoBoon || 0) * 2) return false; // 或然亲和：读过城的人，门槛让二分
    if (w.flagDayGte && s.day < (s.eventFlags[w.flagDayGte] || 0)) return false; // "几天后"相对门（"+N"旗标配套）
    if (w.minDay && s.day < w.minDay) return false;
    if (w.maxDay && s.day > w.maxDay) return false; // 或然 B 的 D30 截止
    if (w.eveOfWarEnd && s.day !== s.war.endDay - 1) return false; // 或然 A 只在交割前夜
    if (!cardAllowedInPool(s, c)) return false; // C-2：来过两回的卡不再入池
    return true;
  });
  if (!eligible.length) return;
  // C-2 卡池降重（二周目实测：同一寡妇带着同一句台词来了三回）——
  // 出场过的卡权重打折（来过一回减半），来过两回的直接出池（cardCount 账随 FLAG 落盘可回放）
  const card = ctx.rng.weighted(eligible.map((c) => ({ w: (c.weight ?? 5) / (1 + (s.cardCount?.[c.id] || 0)), c }))).c; // ?? 不把 0 当缺省
  s.cardCount = { ...(s.cardCount || {}), [card.id]: (s.cardCount?.[card.id] || 0) + 1 };
  ctx.emit('FLAG', { key: 'cardCount', val: structuredClone(s.cardCount) });
  if (card.when?.once) { s.firedOnce[card.id] = true; ctx.emit('FLAG', { key: 'firedOnce', val: structuredClone(s.firedOnce) }); }
  s.eventCooldowns[card.id] = s.day + (card.when?.cooldown || 8);
  ctx.emit('FLAG', { key: 'eventCooldowns', val: structuredClone(s.eventCooldowns) });
  fireEventCard(ctx, card.id);
}

/** 旗标门（时间轴与随机池共用）：requiresFlag 全要 / requiresNotFlag 全不要 / requiresAnyFlag 有一个即可 */
function flagGateOk(s, w = {}) {
  const F = s.eventFlags || {};
  if (w.requiresFlag && !F[w.requiresFlag]) return false;
  if (w.requiresFlags && !w.requiresFlags.every((f) => F[f])) return false;
  if (w.requiresNotFlag && F[w.requiresNotFlag]) return false;
  if (w.requiresNotFlags && w.requiresNotFlags.some((f) => F[f])) return false;
  if (w.requiresAnyFlag && !w.requiresAnyFlag.some((f) => F[f])) return false;
  return true;
}

/** 黄昏发卡（别传专用）：when.at='dusk' 的时间轴卡在窗口内的黄昏必发一次——
 *  一天两拍（晨决断 + 暮余波），短局才配得上"页页都值钱"。主线无此类卡，行为不变。 */
export function drawDuskEvents(ctx) {
  const s = ctx.s;
  if (!s.sidestory || s.over || s.activeEvent) return;
  if (s.duskDrawnDay === s.day) return; // 每日至多一次（补发与直发同账，防连环池卡）
  s.duskDrawnDay = s.day;
  ctx.emit('FLAG', { key: 'duskDrawnDay', val: s.day });
  for (const card of ctx.pack.cards) {
    if (card.kind !== 'timeline' || card.when?.at !== 'dusk') continue;
    if ((card.side || null) !== s.sidestory.id) continue;
    if (s.firedOnce[card.id]) continue;
    const [lo, hi] = card.when.dayWindow || [];
    if (lo !== undefined && (s.day < lo || s.day > hi)) continue;
    if (!flagGateOk(s, card.when)) continue;
    if (card.when.requiresChar && !charById(s, card.when.requiresChar)) continue;
    if (card.when.requiresChars && !card.when.requiresChars.every((id) => charById(s, id))) continue;
    s.firedOnce[card.id] = true;
    ctx.emit('FLAG', { key: 'firedOnce', val: structuredClone(s.firedOnce) });
    fireEventCard(ctx, card.id);
    break;
  }
  // 没有暮卡的黄昏：别传的随机池（叩门/屋内）在这里出场——晨位已被日卡占满
  if (!s.activeEvent) drawRandomPool(ctx);
}

/** C-2 随机池资格（纯函数，测试直查）：同卡一局至多两回 */
export function cardAllowedInPool(s, card) {
  return ((s.cardCount?.[card.id] || 0) < 2);
}
