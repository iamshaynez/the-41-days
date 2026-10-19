// 机器人策略（技术架构 §11.1）：每种策略暴露一类平衡面。
// day(s) → 白天意图数组；dusk(s) → dusk_assign 意图；night(s) → 夜间意图或 null。

function aliveIdle(s, excluding = []) {
  return s.chars.filter((c) => c.alive && c.ap > 0 && !excluding.includes(c.id));
}
function eaters(s) { return s.chars.filter((c) => c.alive); }

/** 通用白天内核：吃饭 > 治疗 > 建造 > 做饭 > 搜家 */
function baseDay(s, pack, { build = true, treat = true, searchHome = true } = {}) {
  const acts = [];
  // 吃：优先熟食，饿了才吃
  for (const c of eaters(s)) {
    if (c.hunger <= 1 && (s.inventory.meal > 0)) acts.push({ type: 'act', actor: c.id, action: 'eat', target: 'meal' });
    else if (c.hunger === 0 && (s.inventory.canned > 0 || s.inventory.raw > 0 || s.inventory.veg > 0 || s.inventory.meat > 0)) {
      const tgt = s.inventory.canned > 0 ? 'canned' : s.inventory.raw > 0 ? 'raw' : s.inventory.meat > 0 ? 'meat' : 'veg';
      acts.push({ type: 'act', actor: c.id, action: 'eat', target: tgt });
    }
  }
  // 治疗：有药就治伤员/病人
  if (treat) {
    // v0.2 仪表校准：没有医护时谁都能喂药（玩家本来就会这么做；I-07 只是加成）
    const healer = s.chars.find((c) => c.alive && c.traits?.healer && c.ap > 0 && !acts.some((a) => a.actor === c.id))
      || s.chars.find((c) => c.alive && c.ap > 0 && !acts.some((a) => a.actor === c.id));
    if (healer) {
      const wounded = s.chars.find((c) => c.alive && c.wound >= 1);
      const sick = s.chars.find((c) => c.alive && c.sick >= 1);
      if (wounded && s.inventory.bandage > 0) acts.push({ type: 'act', actor: healer.id, action: 'treat', target: 'bandage', patient: wounded.id });
      else if (sick && s.inventory.meds > 0) acts.push({ type: 'act', actor: healer.id, action: 'treat', target: 'meds', patient: sick.id });
      else if (sick && s.inventory.herbmed > 0) acts.push({ type: 'act', actor: healer.id, action: 'treat', target: 'herbmed', patient: sick.id });
    }
  }
  // 卧床：重伤病者休息
  for (const c of s.chars.filter((x) => x.alive && (x.wound >= 2 || x.sick >= 2) && !x.bedRest && !acts.some((a) => a.actor === x.id))) {
    acts.push({ type: 'act', actor: c.id, action: 'rest' });
  }
  for (const c of s.chars.filter((x) => x.alive && x.sick === 1 && !x.bedRest && !acts.some((a) => a.actor === x.id) && (s.inventory.meal || 0) > 0)) {
    acts.push({ type: 'act', actor: c.id, action: 'rest' });
  }
  // 建造序：炉灶 → 门 → 床 → 工作台（造价与前置一律读内容包——别在机器人里养第二份账本）
  if (build) {
    // 吃饭是 0AP 的嘴上事，不占手——只有被排了正经活的人不让再建（delegate 同口径）
    const heavyBusy = new Set(acts.filter((a) => a.action !== 'eat').map((a) => a.actor));
    const builder = s.chars.find((c) => c.alive && c.ap >= 2 && !heavyBusy.has(c.id));
    const canAfford = (target) => {
      if (target === 'door') {
        const lv = pack.doorReinforce?.levels[s.doorLevel];
        if (!lv) return false;
        if (lv.facility && !s.facilities[lv.facility]) return false;
        return Object.entries(lv.cost || {}).every(([k, n]) => (s.inventory[k] || 0) >= n);
      }
      const f = pack.facilityMap?.[target];
      return !!f && (!f.requires || !!s.facilities[f.requires]) && Object.entries(f.cost || {}).every(([k, n]) => (s.inventory[k] || 0) >= n);
    };
    if (builder) {
      const winterSoon = s.winterActive || s.day >= s.winterStart - 4;
      if (!s.facilities.stove && canAfford('stove')) acts.push({ type: 'act', actor: builder.id, action: 'build', target: 'stove' });
      else if (s.doorLevel < 1 && canAfford('door')) acts.push({ type: 'act', actor: builder.id, action: 'build', target: 'door' });
      else if (winterSoon && !s.facilities.heater && canAfford('heater')) acts.push({ type: 'act', actor: builder.id, action: 'build', target: 'heater' });
      // v0.2 校准：药路是冬季疫病的答案——工作台要早建（汤药=草药×3）
      else if (!s.facilities.workbench && canAfford('workbench')) acts.push({ type: 'act', actor: builder.id, action: 'build', target: 'workbench' });
      else if (!s.facilities.garden && canAfford('garden')) acts.push({ type: 'act', actor: builder.id, action: 'build', target: 'garden' });
      // 菜园是设计好的食物自给 loop：药圃收获一次后升级葵菜园（v0.2）
      else if (s.facilities.garden && !s.facilities.garden_veg && s.facilities.gardenStarted === -9 && canAfford('garden_veg')) acts.push({ type: 'act', actor: builder.id, action: 'build', target: 'garden_veg' });
      else if (!s.facilities.trap && canAfford('trap')) acts.push({ type: 'act', actor: builder.id, action: 'build', target: 'trap' });
      else if ((s.facilities.bed || 0) < 2 && canAfford('bed')) acts.push({ type: 'act', actor: builder.id, action: 'build', target: 'bed' });
      else if (s.doorLevel < 3 && canAfford('door')) acts.push({ type: 'act', actor: builder.id, action: 'build', target: 'door' });
      else if (!s.facilities.stove_eco && canAfford('stove_eco')) acts.push({ type: 'act', actor: builder.id, action: 'build', target: 'stove_eco' });
      else if (!s.facilities.heater_iron && canAfford('heater_iron')) acts.push({ type: 'act', actor: builder.id, action: 'build', target: 'heater_iron' });
    }
  }
  // 煎药：草药够了且有人手就熬汤药（疫病季的命根子）
  if (s.facilities.workbench && (s.inventory.herb || 0) >= 3 && (s.inventory.herbmed || 0) < 3) {
    const brewer = aliveIdle(s, acts.map((a) => a.actor))[0];
    if (brewer) acts.push({ type: 'act', actor: brewer.id, action: 'craft', target: 'make_herbmed' });
  }
  // 做饭（循环到没料或没人）
  let guard = 0;
  while ((s.inventory.raw > 0 || s.inventory.meat > 0 || (s.inventory.veg || 0) >= 2) && s.facilities.stove && (s.inventory.meal || 0) < 4 && guard++ < 4) {
    const cook = aliveIdle(s, acts.map((a) => a.actor)).find((c) => !acts.some((x) => x.actor === c.id));
    if (!cook) break;
    acts.push({ type: 'act', actor: cook.id, action: 'cook' });
  }
  // 交易：卖余粮（木/珠宝/酒）换食物、药品、柴
  if (s.franko) {
    const give = {};
    // 建材留底线（与管家 tradeDeals 的 RESERVE 同口径）：家什没立起来前，零件/木板不进货担
    if ((s.inventory.jewel || 0) > 0) give.jewel = 1;
    else if ((s.inventory.wine || 0) > 0) give.wine = 1;
    else if ((s.inventory.parts || 0) >= 12) give.parts = 4;
    else if ((s.inventory.wood || 0) >= 10) give.wood = 4;
    if (Object.keys(give).length) {
      // 家什未立时先紧着建材（与管家 tradeDeals 的建材档同口径）：余粮换零件，别等饿不死了才补到 4
      const homeThin = (s.facilities.bed || 0) < 2 || s.doorLevel < 3 || !s.facilities.workbench;
      const partsSku = s.franko.stock.find((x) => x.item === 'parts' && x.n > 0);
      if (homeThin && (s.inventory.parts || 0) < 8 && partsSku && !give.parts) {
        acts.push({ type: 'trade_op', give, get: { parts: 2 } });
        return acts;
      }
      const lowFuel = (s.inventory.firewood || 0) + (s.inventory.wood || 0) + (s.inventory.book || 0) < 2;
      const winterSoon = s.winterActive || s.day >= s.winterStart - 6;
      const fw = s.franko.stock.find((x) => x.item === 'firewood' && x.n > 0);
      if (fw && (lowFuel || winterSoon)) acts.push({ type: 'trade_op', give, get: { firewood: 3 } });
      else {
        const prio = ['bandage', 'meds', 'canned', 'raw'].map((it) => s.franko.stock.find((x) => x.item === it && x.n > 0)).filter(Boolean);
        const want = prio.find((x) => x.item === 'bandage' && (s.inventory.bandage || 0) === 0) || prio.find((x) => x.item === 'meds') || prio.find((x) => ['canned', 'raw'].includes(x.item) && (s.inventory.canned || 0) + (s.inventory.raw || 0) < 3) || prio[0];
        if (want) acts.push({ type: 'trade_op', give, get: { [want.item]: 2 } });
      }
    }
  }
  // 搜家
  if (searchHome) {
    const idler = aliveIdle(s, acts.map((a) => a.actor))[0];
    if (idler && Object.keys(s.house.searched).length < 8) acts.push({ type: 'act', actor: idler.id, action: 'search_home' });
  }
  return acts;
}

/** 夜访地点轮换 */
function pickLoc(s, i) {
  const known = s.knownLocs.filter((l) => l !== 'home');
  return known[i % known.length];
}

export function operatorPolicy(name) {
  switch (name) {
    case 'hoarder': // 守财奴：从不出门，暴露静态经济与袭击
      return {
        day: (s, pack) => baseDay(s, pack, { build: true }),
        dusk: (s) => {
          const others = {};
          const guard = s.chars.find((c) => c.alive);
          if (guard) others[guard.id] = 'guard';
          return { type: 'dusk_assign', scavenger: null, others };
        },
        night: () => null
      };
    case 'gambler': // 赌徒：每晚冲最险地点，暴露死亡分布
      return {
        day: (s, pack) => baseDay(s, pack, { build: false, searchHome: true }),
        dusk: (s) => {
          const known = s.knownLocs.filter((l) => l !== 'home');
          const riskOrder = ['frontline', 'market', 'post', 'villas', 'church', 'hospital'];
          const loc = riskOrder.find((l) => known.includes(l)) || known[0];
          const fit = s.chars.filter((c) => c.alive && c.wound < 3 && c.sick < 3);
          const scav = fit.sort((a, b) => b.combat - a.combat)[0];
          const others = {};
          for (const c of s.chars.filter((x) => x.alive)) others[c.id] = 'sleep';
          if (!scav) return { type: 'dusk_assign', scavenger: null, others };
          return { type: 'dusk_assign', scavenger: scav.id, location: loc, gear: ['crowbar'], others };
        },
        night: (s) => {
          const loc = s.knownLocs; // 当前地点由 state.night 提供
          const n = s.night;
          const npcs = (require0(n) || []);
          return { type: 'night', action: 'search' };
        }
      };
    case 'devil': // 恶魔：见人就抢，暴露道德成本
      return {
        day: (s, pack) => baseDay(s, pack, { build: true }),
        dusk: (s) => {
          const known = s.knownLocs.filter((l) => l !== 'home');
          const fit = s.chars.filter((c) => c.alive && c.wound < 3 && c.sick < 3);
          const scav = fit.sort((a, b) => b.combat - a.combat)[0];
          const others = {};
          for (const c of s.chars.filter((x) => x.alive && x.id !== scav?.id)) others[c.id] = 'sleep';
          if (!scav) return { type: 'dusk_assign', scavenger: null, others };
          return { type: 'dusk_assign', scavenger: scav.id, location: known[0], gear: ['crowbar'], others };
        },
        night: (s, pack) => {
          const n = s.night;
          const loc = pack.locMap[n.locId];
          const prey = (loc.npcs || []).find((x) => !s.locState[n.locId].npcState[x.id]);
          if (prey) return { type: 'night', action: 'attack', target: prey.id };
          return { type: 'night', action: 'search' };
        }
      };
    default: // balanced：参考运营
      return {
        day: (s, pack) => baseDay(s, pack, { build: true }),
        dusk: (s, pack) => {
          const fit = s.chars.filter((c) => c.alive && c.wound < 3 && c.sick < 3);
          const scav = fit.sort((a, b) => b.backpack - a.backpack)[0];
          const others = {};
          const guards = s.chars.filter((c) => c.alive && c.id !== scav?.id && c.combat >= 0);
          // v0.2 校准：枯竭期（D30+）双守夜，对齐"会玩的玩家"的防御投入
          for (const g of guards.slice(0, s.day >= 30 ? 2 : 1)) others[g.id] = 'guard';
          for (const c of s.chars.filter((x) => x.alive)) if (!others[c.id]) others[c.id] = 'sleep';
          if (!scav) return { type: 'dusk_assign', scavenger: null, others };
          const known = s.knownLocs.filter((l) => l !== 'home' && pack?.locMap[l]);
          // 夜野校准：旧版硬编码六地名单把机器人锁死在五地（40 局模拟其余全零到访）——
          // 改为全已知地点动态轮换：缺粮直奔粮仓，其余「没去过的优先，去过的最久未访优先」
          const foodEq = (s.inventory.raw || 0) + (s.inventory.canned || 0) + (s.inventory.meat || 0) + (s.inventory.veg || 0) + (s.inventory.meal || 0) * 2;
          const lastV = (l) => s.locState?.[l]?.lastVisitDay ?? -1;
          const never = (l) => !s.locState?.[l];
          const ranked = [...known].sort((a, b) => (Number(never(b)) - Number(never(a))) || (lastV(a) - lastV(b)));
          const famine = foodEq < 8;
          const foodRich = (l) => {
            const loc = pack?.locMap[l];
            if (!loc) return false;
            return (loc.rooms || []).some((r) => (r.containers || []).some((c) => (c.loot || []).some((e) => ['meal', 'canned', 'raw', 'meat', 'veg'].includes(e.item) && e.w > 0)));
          };
          const loc = famine ? (ranked.find(foodRich) || ranked[0] || known[0]) : (ranked[0] || known[0]);
          // 家什按地点配（锁→撬棍，瓦砾/埋→铲，栅栏→锯，险地带刀）
          const gear = [];
          const doors = new Set(((pack?.locMap[loc]?.rooms || [])).map((r) => r.door));
          if (doors.has('locked') && s.inventory.crowbar) gear.push('crowbar');
          if ((doors.has('rubble') || (pack?.locMap[loc]?.rooms || []).some((r) => (r.containers || []).some((c) => c.type === 'buried'))) && s.inventory.shovel) gear.push('shovel');
          if (doors.has('bars') && s.inventory.saw) gear.push('saw');
          if ((pack?.locMap[loc]?.threat || 0) >= 2 && s.inventory.knife) gear.push('knife');
          return { type: 'dusk_assign', scavenger: scav.id, location: loc, gear, others };
        },
        night: (s, pack) => {
          // 埋着的容器先挖（夜野）：搜不动埋瓮——机器人也得会拿铲子
          const n = s.night;
          const loc = pack?.locMap[n?.locId];
          const room = loc?.rooms?.find((r) => r.id === n?.room);
          const buried = (room?.containers || []).find((c) => c.type === 'buried' && !(s.locState?.[n.locId]?.searched?.[c.id + ':open']));
          if (buried) return { type: 'night', action: 'dig' };
          return { type: 'night', action: 'search' };
        }
      };
  }
}
function require0() { return null; }
