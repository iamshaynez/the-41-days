// 事件溯源折叠（技术架构 §4.3）：RUN_STARTED 携带初始快照，DAY_STARTED 携带每日晨间快照，
// 其余事件逐条应用到最近快照。属性测试保证 fold(events) === 最终状态。
const clone = (x) => structuredClone(x);

export function fold(events) {
  if (!events.length) return null;
  let state = null;
  for (const ev of events) {
    if (ev.t === 'RUN_STARTED' || ev.t === 'DAY_STARTED') {
      state = clone(ev.d.state ?? ev.d.snapshot);
      if (ev.t === 'DAY_STARTED') { state.day = ev.d.day; state.weather = ev.d.weather; }
      continue;
    }
    if (!state) continue;
    apply(state, ev);
  }
  return state;
}

function ch(state, id) { return state.chars.find((c) => c.id === id); }

function apply(s, ev) {
  const d = ev.d || {};
  switch (ev.t) {
    case 'ITEM_MOVED': {
      s.inventory[d.item] = (s.inventory[d.item] || 0) + d.delta;
      if (s.inventory[d.item] <= 0) delete s.inventory[d.item];
      break;
    }
    case 'HUNGER_CHANGED': { const c = ch(s, d.char); if (c) c.hunger = d.to; break; }
    case 'WOUND_CHANGED': { const c = ch(s, d.char); if (c) c.wound = d.to; break; }
    case 'SICK_CHANGED': { const c = ch(s, d.char); if (c) c.sick = d.to; break; }
    case 'FATIGUE_CHANGED': { const c = ch(s, d.char); if (c) c.fatigue = d.to; break; }
    case 'MOOD_DELTA': { const c = ch(s, d.char); if (c) c.moodPts = d.pts; break; }
    case 'AP_SPENT': { const c = ch(s, d.char); if (c) c.ap = d.left; break; }
    case 'CHAR_DIED': { const c = ch(s, d.char); if (c) { c.alive = false; s.deathDays = { ...(s.deathDays || {}), [d.char]: ev.day }; } break; }
    case 'DEED': s.deeds.push({ day: ev.day, ...d }); break;
    case 'KNOWLEDGE': s.knowledge = d.to; break;
    case 'REPUTATION': s.reputation[d.key] = d.to; break;
    case 'NOTORIETY': s.notoriety = d.to; break;
    case 'FLAG': s[d.key] = d.val; break;
    case 'CHAR_FLAG': { const c = ch(s, d.char); if (c) c[d.key] = d.val; break; }
    case 'FACILITY_BUILT': s.facilities[d.facility] = d.to; break;
    case 'DOOR_LEVEL': s.doorLevel = d.to; break;
    case 'BREAKDOWN_START': { const c = ch(s, d.char); if (c) c.breakdown = { stage: 1 }; break; }
    case 'BREAKDOWN_STAGE': { const c = ch(s, d.char); if (c && c.breakdown) c.breakdown.stage = d.stage; break; }
    case 'BREAKDOWN_RECOVERED': { const c = ch(s, d.char); if (c) { c.breakdown = null; c.soothed = 0; } break; }
    case 'BREAKDOWN_CALM': { const c = ch(s, d.char); if (c) { c.breakdown = null; c.soothed = 0; } break; } // 自伤收场：崩溃态清零的镜像
    case 'NIGHT_STARTED': {
      if (d.home) s.night = { home: true };
      else s.night = clone(d.night);
      if (s.phase === 'dusk') s.phase = 'night';
      break;
    }
    case 'NIGHT_ENDED': {
      if (!d.home) {
        if (s.night && !s.night.home && s.locState[d.loc]) {
          s.locState[d.loc].firstVisit = false;
          if (d.lastVisitDay !== undefined) s.locState[d.loc].lastVisitDay = d.lastVisitDay;
        }
        for (const g of d.gear || []) s.inventory[g] = (s.inventory[g] || 0) + 1;
      }
      s.night = null; s.phase = 'dawn';
      break;
    }
    case 'LOC_NEW': if (!s.locState[d.loc]) s.locState[d.loc] = { searched: {}, npcState: {}, scriptsFired: {}, firstVisit: true }; break;
    case 'LOC_KNOWN': if (!s.knownLocs.includes(d.loc)) s.knownLocs.push(d.loc); break;
    case 'LOC_SEARCHED': if (s.locState[d.loc]) s.locState[d.loc].searched[d.cont] = d.day ?? true; break;
    case 'LOC_REFILL': if (s.locState[d.loc]) delete s.locState[d.loc].searched[d.cont]; break;
    case 'NPC_STATE': if (s.locState[d.loc]) s.locState[d.loc].npcState[d.npc] = d.state; break;
    case 'SCRIPT_FIRED': if (s.locState[d.loc]) s.locState[d.loc].scriptsFired[d.script] = true; break;
    case 'CURSOR': s.rngCursor = d.to; break;
    case 'MOOD_COUNT': { const c = ch(s, d.char); if (c) { c.moodCounts = c.moodCounts || {}; c.moodCounts[d.reason] = d.n; } break; }
    case 'CHAR_FLAGS': {
      const c = ch(s, d.char);
      if (c) {
        c.woundRestDays = d.woundRestDays; c.woundUntreatedDays = d.woundUntreatedDays;
        c.sickRestDays = d.sickRestDays; c.sickUntreatedDays = d.sickUntreatedDays;
        c.sickTreatedHerb = d.sickTreatedHerb;
      }
      break;
    }
    case 'FACILITY_STATE': s.facilities[d.facility] = d.to; break;
    case 'HOUSE_SEARCHED': s.house.searched[d.cont] = true; break;
    case 'HIDDEN_FOUND': s.house.hiddenFound[d.cont] = true; break;
    case 'HOUSE_OPENED': s.house.opened[d.room] = true; break;
    case 'NIGHT_PATCH': {
      if (s.night && !s.night.home) {
        const patch = {};
        for (const k of ['room', 'slots', 'noise', 'packSlots', 'lowSlotsAck', 'atFork', 'micro', 'patrol']) if (d[k] !== undefined) patch[k] = d[k];
        for (const k of ['pack', 'observed', 'unlocked', 'cleared', 'sawed']) if (d[k] !== undefined) patch[k] = clone(d[k]);
        if (d.directive !== undefined) patch.directive = clone(d.directive);
        Object.assign(s.night, patch);
      }
      break;
    }
    case 'EVENT_FIRED': {
      if (d.beat) break; // 节拍卡只入叙述不占门口位（0.38.0 起 beat 不挂 activeEvent——fold 漏了这一层）
      const ae = { cardId: d.cardId };
      if (d.night) ae.night = true;
      if (d.actorId) ae.actorId = d.actorId;
      if (d.duskFate) ae.duskFate = true;
      s.activeEvent = ae;
      break;
    }
    case 'EVENT_CHOSEN': s.activeEvent = null; break;
    case 'FRANKO_ARRIVE': s.franko = { merchant: 'franko', stock: clone(d.stock) }; break;
    case 'TRADE_DONE': {
      for (const [id, n] of Object.entries(d.get || {})) {
        const sku = s.franko?.stock.find((x) => x.item === id);
        if (sku) sku.n -= n;
      }
      break;
    }
    case 'TRADE_REJECTED': break;
    case 'GUARD_SET': { const c = ch(s, d.char); if (c) c.guardTonight = true; break; }
    case 'PHASE': s.phase = d.to; if (d.to === 'dusk') s.night = null; break;
    case 'WEATHER': s.weather = d.to; break;
    case 'WINTER_START': s.winterActive = true; break;
    case 'WINTER_END': s.winterActive = false; break;
    case 'WAR_ENDED': s.war.ended = true; s.war.endingType = d.type; if (d.armyHeld !== undefined) s.war.armyHeld = d.armyHeld; if (d.leverHad !== undefined) s.war.leverHad = d.leverHad; break;
    case 'WAR_TELEGRAPH': s.war.telegraphed = true; break;
    case 'RUN_ENDED': s.over = true; s.ending = clone(d.ending); s.threeThings = clone(d.ending?.threeThings || []); break;
    case 'CAUSAL': {
      if (!s.causality) s.causality = { entries: [], pairArcs: {}, charArcs: {}, shadowTouched: {} };
      s.causality.entries.push(clone(d.entry));
      for (const [k, v] of Object.entries(d.charUpd || {})) s.causality.charArcs[k] = clone(v);
      for (const [k, v] of Object.entries(d.pairUpd || {})) s.causality.pairArcs[k] = clone(v);
      for (const [k, v] of Object.entries(d.shadowUpd || {})) {
        if (!s.causality.shadowTouched) s.causality.shadowTouched = {};
        s.causality.shadowTouched[k] = v;
      }
      break;
    }
    case 'CAUSAL_NOTE': {
      if (!s.causality) s.causality = { entries: [], pairArcs: {}, charArcs: {}, shadowTouched: {} };
      const arc = s.causality.charArcs[d.charId] || (s.causality.charArcs[d.charId] = { pos: 0, neg: 0, privateLedger: [] });
      arc.privateLedger.push(clone(d.note));
      break;
    }
    case 'SEAL_UNLOCKED': { if (!s.seals) s.seals = []; if (!s.seals.includes(d.id)) s.seals.push(d.id); break; }
    case 'PAIR_ARC': {
      if (!s.causality) s.causality = { entries: [], pairArcs: {}, charArcs: {}, shadowTouched: {} };
      s.causality.pairArcs[d.key] = { pos: d.pos, neg: d.neg };
      break;
    }
    case 'ENSEMBLE_SCENE': {
      if (!s.ensemble) s.ensemble = { scenes: [], coveredSteps: [], pairLast: {} };
      s.ensemble.scenes.push(clone(d.scene));
      if (d.scene.topic?.stepId && !s.ensemble.coveredSteps.includes(d.scene.topic.stepId)) s.ensemble.coveredSteps.push(d.scene.topic.stepId);
      const ids = d.scene.participants || [];
      if (ids.length >= 2) s.ensemble.pairLast[[ids[0], ids[1]].sort().join('|')] = d.scene.day;
      break;
    }
    case 'PRELUDE_BEAT': s.prelude = { i: d.i }; break;
    case 'MAINLINE_STEP': {
      if (!s.mainline) s.mainline = [];
      s.mainline.push({ day: d.day, stepId: d.stepId ?? null, pens: d.pens || [], mirrors: d.mirrors || [], ...(d.echo ? { echo: d.echo } : {}) });
      if (!s.mainlinePens) s.mainlinePens = [];
      for (const p of d.pens || []) if (!s.mainlinePens.includes(p)) s.mainlinePens.push(p);
      break;
    }
    case 'NOISE': if (s.night && !s.night.home) s.night.noise = d.to; break;
    default: break; // 叙事/骰子/演出类事件不参与折叠
  }
}
