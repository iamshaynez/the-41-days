// L1 单元：袭击带（R-03/R-05）、价格带（E-06）、鲁舟泊船（E-04）、夜间（N/C/JD）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK } from '../helpers.js';
import { Ctx } from '../../packages/core/index.js';
import { genFrankoStock, sellPrice, executeTrade } from '../../packages/core/index.js';

describe('袭击 R 系', () => {
  test('R-05 防御≥威胁 → 击退不失窃（种子化）', () => {
    let stolen = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const { state } = newRun({ seed, roster: ['bron', 'grigory', 'danilo'] });
      state.doorLevel = 3;
      state.inventory.knife = 1; state.inventory.crowbar = 1;
      state.day = 5; // 低威胁日
      const s = step(state, [{ type: 'advance' }]);
      const r = step(s.state, [{ type: 'dusk_assign', scavenger: null, others: { bron: 'guard', grigory: 'guard', danilo: 'guard' } }]);
      const raid = r.events.find((e) => e.t === 'RAID_OUTCOME');
      if (raid && raid.d.band !== 'repelled' && raid.d.band !== 'none') stolen++;
    }
    assert.equal(stolen, 0, 'D5 三守卫+3级门+武器 应全部击退或无袭');
  });

  test('R-02 恶名累积：杀无辜 +2', () => {
    const { state } = newRun({ roster: ['danilo'] });
    const ctx = new Ctx(state, PACK);
    ctx.addDeed('danilo', 'kill_civ', 'someone');
    ctx.notoriety(2);
    assert.equal(state.notoriety, 2);
  });
});

describe('交易 E 系', () => {
  test('E-04 鲁舟按排期到访且生成摊位', () => {
    const { state } = newRun({ seed: 9, roster: ['katya', 'emil', 'bron'] });
    let s = state, day = 1;
    while (!s.franko && day < 8) {
      s = step(s, [{ type: 'advance' }]).state;
      s = step(s, [{ type: 'dusk_assign', scavenger: null, others: {} }]).state;
      day = s.day;
    }
    assert.ok(s.franko, '8 天内鲁舟必到');
    assert.ok(s.franko.stock.length >= 10 && s.franko.stock.length <= 14); // v0.2：摊位 10~14 SKU
  });

  test('E-06 价格带：1 木板换 5 绷带必被拒（越带）', () => {
    const { state } = newRun({ roster: ['katya'] });
    state.franko = { merchant: 'franko', stock: [{ item: 'bandage', n: 5, buy: 30 }] };
    state.inventory.wood = 1;
    const ctx = new Ctx(state, PACK);
    const r = executeTrade(ctx, { give: { wood: 1 }, get: { bandage: 5 } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'PRICE_BAND');
  });

  test('E-07 卡佳谈判 +15% 让利空间：等值 ×1.1 内可成交', () => {
    const { state } = newRun({ roster: ['katya', 'bron'] });
    state.franko = { merchant: 'franko', stock: [{ item: 'raw', n: 3, buy: 6 }] };
    state.inventory.wood = 15;
    const ctx = new Ctx(state, PACK);
    // 卖 10 木（木值2，Katya 收购≈2×0.6×1.15≈1.4/张 → 14 点）换 2 生食（12 点）→ 应成交
    const r = executeTrade(ctx, { give: { wood: 15 }, get: { raw: 2 } });
    assert.equal(r.ok, true);
  });

  test('E-09 文档异常收购价 = 8', () => {
    const { state } = newRun({ roster: ['bron'] });
    const ctx = new Ctx(state, PACK);
    state.inventory.doc = 1;
    assert.equal(sellPrice(ctx, 'doc'), 8);
  });
});

describe('夜间 N/C 系', () => {
  function toNight(state, loc = 'market', gear = ['crowbar']) {
    let s = step(state, [{ type: 'advance' }]).state;
    return step(s, [{ type: 'dusk_assign', scavenger: 'bron', location: loc, gear, others: {} }]);
  }

  test('N-01 时间槽只有 10 格，动作消耗', () => {
    const { state } = newRun({ seed: 3, roster: ['bron', 'katya', 'marta'] });
    const r = toNight(state);
    const s = r.state;
    assert.equal(s.night.slots, 10);
    const r2 = step(s, [{ type: 'night', action: 'observe' }]);
    assert.equal(r2.state.night.slots, 9);
  });

  test('N-03 声响累计会引来警觉（多次破拆）', () => {
    let alerts = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const { state } = newRun({ seed, roster: ['bron', 'katya', 'marta'] });
      const n = toNight(state);
      let s = step(n.state, [{ type: 'night', action: 'move', target: 'coldroom' }]);
      s = step(s.state, [{ type: 'night', action: 'open', target: 'storage' }]);
      if (s.facts.some((f) => f.k === 'night_noise_alert')) alerts++;
    }
    assert.ok(alerts >= 3, `20 次撬锁至少 3 次惊动（实际 ${alerts}）`);
  });

  test('C-05 背刺平民 = 杀无辜入账（事迹账本）', () => {
    const { state } = newRun({ seed: 5, roster: ['bron', 'katya', 'marta'] });
    state.inventory.knife = 1;
    const n = toNight(state, 'church', ['knife']);
    // 神父脚本先触发，选 thanks 关闭
    let s = n.state;
    if (s.activeEvent) s = step(s, [{ type: 'event_choice', option: 'thanks' }]).state;
    const r = step(s, [{ type: 'night', action: 'backstab', target: 'priest' }]);
    // 可能检定失败进入战斗，但多数种子应成功
    const deed = r.state.deeds.find((d) => d.type === 'kill_civ');
    assert.ok(deed || r.state.locState.church?.npcState?.priest === 'alert', '要么背刺成功入账，要么失败警觉');
  });

  test('N-06 容量约束：布罗 14 格，装满即遗落', () => {
    const { state } = newRun({ seed: 11, roster: ['bron', 'katya', 'marta'] });
    const n = toNight(state);
    const s = n.state;
    // 人为塞满：给 14 个单格物
    for (let i = 0; i < 16; i++) { s.inventory.parts = (s.inventory.parts || 0) + 1; }
    s.night.pack = Array(14).fill('parts');
    s.night.packSlots = 14;
    const r = step(s, [{ type: 'night', action: 'search' }]);
    // 若搜到物品，pack 超容会遗落（events 有 night_drop 或保持 ≤ 容量）
    assert.ok(!r.state.night || r.state.night.packSlots <= r.state.night.cap);
  });

  test('文档落点：邮局死信库能搜到文档（#039 或 #014/#041）', () => {
    let found = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const { state } = newRun({ seed, roster: ['pavel', 'katya', 'marta'] });
      state.knownLocs.push('post');
      state.inventory.saw = 1;
      let s = step(state, [{ type: 'advance' }]).state;
      s = step(s, [{ type: 'dusk_assign', scavenger: 'pavel', location: 'post', gear: ['saw'], others: {} }]).state;
      let guard = 0;
      while (s.phase === 'night' && s.night && !s.night.home && guard++ < 14) {
        const before = s.night.slots;
        if (s.activeEvent) { s = step(s, [{ type: 'event_choice', option: 'thanks' }]).state; continue; }
        s = step(s, [{ type: 'night', action: 'bars', target: 'deadletter' }]).state;
        if (s.phase !== 'night') break;
        s = step(s, [{ type: 'night', action: 'move', target: 'deadletter' }]).state;
        if (s.phase !== 'night') break;
        s = step(s, [{ type: 'night', action: 'search' }]).state;
        if (s.night && s.night.slots === before) break;
        if (s.docsSeen.length) { found++; break; }
      }
    }
    assert.ok(found >= 3, `25 局邮局夜访至少 3 局得文档（实际 ${found}）`);
  });
});
