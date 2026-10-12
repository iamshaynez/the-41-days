// L3 业务场景 e2e（无头）：场景 DSL——用游戏语言写断言（技术架构 §10 L3）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK } from '../helpers.js';

const given = (opts) => newRun(opts);

function runDays(state, days, dayPolicy) {
  let s = state;
  for (let d = 0; d < days; d++) {
    if (s.over) break;
    if (s.activeEvent) {
      const card = s.activeEvent.cardId;
      const opt = card === 'n_meds' ? 'refuse' : (PACK.cardMap[card]?.options?.[0]?.key ?? 'refuse');
      s = step(s, [{ type: 'event_choice', option: opt }]).state;
    }
    const acts = dayPolicy(s) || [];
    s = step(s, [...acts, { type: 'advance' }]).state;
    if (s.over) break;
    s = step(s, [{ type: 'dusk_assign', scavenger: null, others: {} }]).state;
  }
  return s;
}

describe('场景：熟食经济（内核 §12 收支试算的落地）', () => {
  test('守财奴（从不出门）三人局 20 天内出现饿死危机', () => {
    const { state } = given({ seed: 21, roster: ['anton', 'marta', 'bron'] });
    const s = runDays(state, 20, () => []);
    const alive = s.chars.filter((c) => c.alive).length;
    const hungry = s.chars.filter((c) => c.alive && c.hunger <= 1).length;
    assert.ok(alive < 3 || hungry >= 1, `20 天守家必现危机（存活 ${alive}，挨饿 ${hungry}）`);
  });

  test('会玩的人（建灶/夜间搜刮/隔天餐/以物易物）：10 种子中 ≥6 局 ≥2 人活过 12 天', () => {
    let ok = 0, wipes = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const { state } = given({ seed, roster: ['anton', 'marta', 'bron'] });
      let s = state;
      for (let d = 0; d < 12; d++) {
        if (s.over) break;
        if (s.activeEvent) {
          const card = s.activeEvent.cardId;
          const opt = card === 'n_meds' ? 'refuse' : (PACK.cardMap[card]?.options?.find((o) => !o.cost && !o.requires)?.key ?? 'refuse');
          s = step(s, [{ type: 'event_choice', option: opt }]).state;
        }
        const acts = [];
        if (!s.facilities.stove) acts.push({ type: 'act', actor: 'bron', action: 'build', target: 'stove' });
        if (s.doorLevel < 1 && (s.inventory.wood || 0) >= 7) acts.push({ type: 'act', actor: 'bron', action: 'build', target: 'door' });
        if (!s.house.opened.cellar) acts.push({ type: 'act', actor: 'bron', action: 'open_room', target: 'cellar' });
        const idle = s.chars.find((c) => c.alive && c.ap > 0 && !acts.some((a) => a.actor === c.id));
        if (idle && Object.keys(s.house.searched).length < 8) acts.push({ type: 'act', actor: idle.id, action: 'search_home' });
        while ((s.inventory.raw > 0 || s.inventory.meat > 0) && s.facilities.stove && !s.inventory.meal) {
          const cook = s.chars.find((x) => x.alive && x.ap > 0 && !acts.some((a) => a.actor === x.id));
          if (!cook) break;
          acts.push({ type: 'act', actor: cook.id, action: 'cook' });
        }
        for (const c of s.chars.filter((x) => x.alive)) {
          if (c.hunger <= 2 && s.inventory.meal > 0) acts.push({ type: 'act', actor: c.id, action: 'eat', target: 'meal' });
          else if (c.hunger === 0 && (s.inventory.canned > 0 || s.inventory.raw > 0)) acts.push({ type: 'act', actor: c.id, action: 'eat', target: s.inventory.canned > 0 ? 'canned' : 'raw' });
        }
        if (s.franko) {
          const give = {};
          if (s.inventory.wine) give.wine = 1; else if (s.inventory.jewel) give.jewel = 1;
          const g = s.franko.stock.find((x) => x.item === 'canned' || x.item === 'raw');
          if (Object.keys(give).length && g) s = step(s, [{ type: 'trade_op', give, get: { [g.item]: 2 } }]).state;
        }
        s = step(s, [...acts, { type: 'advance' }]).state;
        if (s.over) break;
        const fit = ['bron', 'marta', 'anton'].map((id) => s.chars.find((c) => c.id === id)).find((c) => c && c.alive && c.wound < 2 && c.sick < 2 && c.hunger > 0);
        if (fit) {
          const locs = ['villas', 'market', 'church'];
          s = step(s, [{ type: 'dusk_assign', scavenger: fit.id, location: locs[d % 3], gear: ['crowbar'], others: { marta: 'guard', anton: 'sleep' } }]).state;
          let g = 0;
          while (s.phase === 'night' && s.night && !s.night.home && g++ < 14) {
            if (s.activeEvent) { s = step(s, [{ type: 'event_choice', option: PACK.cardMap[s.activeEvent.cardId]?.options?.find((o) => !o.cost && !o.requires)?.key ?? 'thanks' }]).state; continue; }
            const before = s.night.slots;
            const loc = PACK.locMap[s.night.locId];
            const idx = loc.rooms.findIndex((r) => r.id === s.night.room);
            let r = step(s, [{ type: 'night', action: 'search' }]);
            s = r.state;
            if (s.night && s.night.slots === before) {
              const next = loc.rooms[idx + 1];
              if (next && next.door === 'locked') r = step(s, [{ type: 'night', action: 'open', target: next.id }]);
              else if (next) r = step(s, [{ type: 'night', action: 'move', target: next.id }]);
              if (r.state.night && r.state.night.slots === before) { s = step(s, [{ type: 'night', action: 'retreat' }]).state; break; }
              s = r.state;
              if (!s.night || s.night.home) break;
              continue;
            }
            if (!s.night || s.night.home) break;
          }
        } else {
          s = step(s, [{ type: 'dusk_assign', scavenger: null, others: { marta: 'guard' } }]).state;
        }
        if (s.phase === 'night') s = step(s, [{ type: 'night', action: 'retreat' }]).state;
      }
      const alive = s.chars.filter((c) => c.alive).length;
      if (alive >= 2) ok++;
      if (alive === 0) wipes++;
    }
    assert.ok(ok >= 6, `10 局中 ${ok} 局 ≥2 人存活（应 ≥6）`);
    assert.ok(wipes <= 1, `全灭 ${wipes} 局（应 ≤1）`);
  });
});

describe('场景：暗线节奏（Q 系）', () => {
  test('邮局两夜 + 教堂一夜的「档案学家」路线能集起知晓度', () => {
    let knowledge = 0, docs = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const { state } = newRun({ seed, roster: ['pavel', 'katya', 'marta'] });
      state.knownLocs.push('post');
      state.inventory.saw = 1;
      let s = state;
      for (let night = 0; night < 3; night++) {
        const loc = night < 2 ? 'post' : 'church';
        s = step(s, [{ type: 'advance' }]).state;
        s = step(s, [{ type: 'dusk_assign', scavenger: 'pavel', location: loc, gear: night < 2 ? ['saw'] : [], others: {} }]).state;
        let g = 0;
        while (s.phase === 'night' && s.night && !s.night.home && g++ < 14) {
          if (s.activeEvent) {
            const card = s.activeEvent.cardId;
            const opt = card === 's_looter' ? 'share' : (PACK.cardMap[card]?.options?.find((o) => !o.cost && !o.requires)?.key ?? 'thanks');
            s = step(s, [{ type: 'event_choice', option: opt }]).state;
            continue;
          }
          const b = s.night.slots;
          if (loc === 'post' && !s.night.sawed?.deadletter && s.night.room !== 'deadletter') {
            s = step(s, [{ type: 'night', action: 'bars', target: 'deadletter' }]).state;
            if (s.phase !== 'night') break;
            s = step(s, [{ type: 'night', action: 'move', target: 'deadletter' }]).state;
          }
          if (s.phase !== 'night') break;
          s = step(s, [{ type: 'night', action: 'search' }]).state;
          if (s.night && s.night.slots === b) { s = step(s, [{ type: 'night', action: 'retreat' }]).state; break; }
        }
        if (s.phase === 'night') s = step(s, [{ type: 'night', action: 'retreat' }]).state;
        s = step(s, [{ type: 'act', actor: 'katya', action: 'eat' }]).state;
      }
      knowledge += s.knowledge; docs += s.docsSeen.length;
    }
    assert.ok(docs >= 6, `10 局 ×3 夜文档总收获 ${docs} ≥ 6`);
    assert.ok(knowledge >= 6, `知晓度合计 ${knowledge} ≥ 6`);
  });
});
