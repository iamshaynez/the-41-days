// 家什重整（设施树拍平）：旧升级件上户口、前置声明、件件有说明书——玩家看得见、代理建得成。
// 设计依据：玩家不操作角色，设施清单必须平铺可读；效果文案与内核机制一字不差。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, skipDayAtHome, PACK } from '../helpers.js';
import { planDay } from '../../packages/core/index.js';

const tryBuild = (s, target, actor = 'bron') => step(s, [{ type: 'act', actor, action: 'build', target }]);

describe('场景：家什清单（拍平与说明书）', () => {
  test('升级树下岗：二级/三级工作台、像样的床、滤网集雨器不再出现在清单里', () => {
    const ids = PACK.facilities.map((f) => f.id);
    for (const gone of ['workbench2', 'workbench3', 'bed_good', 'rain_filter']) {
      assert.ok(!ids.includes(gone), `${gone} 应已下岗`);
    }
    for (const f of PACK.facilities) {
      assert.ok(!f.upgrades?.length, `${f.id} 不再挂升级树（拍平为顶层条目）`);
    }
  });

  test('件件有说明书：每个设施都带 effectText（效果）与 flavor（落成卡文案）', () => {
    for (const f of PACK.facilities) {
      assert.ok(f.effectText && f.effectText.length >= 6, `${f.id} 缺 effectText`);
      assert.ok(f.flavor && f.flavor.length >= 6, `${f.id} 缺 flavor`);
    }
  });

  test('旧升级件都有户口：节能灶/铁炉/葵菜园是顶层条目并声明前置', () => {
    const by = Object.fromEntries(PACK.facilities.map((f) => [f.id, f]));
    assert.equal(by.stove_eco?.requires, 'stove', '节能灶需先有炉灶');
    assert.equal(by.heater_iron?.requires, 'heater', '铁炉需先有火盆');
    assert.equal(by.garden_veg?.requires, 'garden', '葵菜园是药圃翻种');
  });

  test('子弹配方下岗：不再有要求高级工作台的配方（子弹走事件获得）', () => {
    assert.ok(!PACK.recipes.some((r) => r.id === 'make_bullet'), 'make_bullet 应下岗');
    for (const r of PACK.recipes) {
      assert.ok((r.wbLevel || 1) <= 1, `${r.id} 还在要求二级以上工作台`);
    }
  });
});

describe('场景：前置设施是门槛不是摆设', () => {
  test('没有火盆建不了铁炉；有了火盆和材料，铁炉落成', () => {
    const { state } = newRun({ seed: 7 });
    state.inventory.wood = 20; state.inventory.parts = 30; state.inventory.comp = 10; // 材料管够
    const r1 = tryBuild(state, 'heater_iron');
    assert.equal(r1.rejects[0]?.reason, 'NEED_FACILITY', '缺火盆应拒 NEED_FACILITY');

    state.facilities.heater = 1;
    const r2 = tryBuild(r1.state, 'heater_iron');
    assert.deepEqual(r2.rejects, []);
    assert.equal(r2.state.facilities.heater_iron, 1, '铁炉落成');
  });

  test('没有炉灶建不了节能灶；有了炉灶，一根柴的余火烧四锅', () => {
    const { state } = newRun({ seed: 7 });
    state.inventory.wood = 20; state.inventory.parts = 30; state.inventory.comp = 10;
    const r1 = tryBuild(state, 'stove_eco');
    assert.equal(r1.rejects[0]?.reason, 'NEED_FACILITY', '缺炉灶应拒 NEED_FACILITY');

    state.facilities.stove = 1;
    const r2 = tryBuild(r1.state, 'stove_eco');
    assert.deepEqual(r2.rejects, []);
    assert.equal(r2.state.facilities.stove_eco, 1);
  });

  test('葵菜园是药圃翻种：没有药圃建不了，翻种后收的是菜不是药', () => {
    const { state } = newRun({ seed: 7 });
    state.inventory.parts = 30; state.inventory.comp = 20; state.inventory.water = 10;
    const r1 = tryBuild(state, 'garden_veg');
    assert.equal(r1.rejects[0]?.reason, 'NEED_FACILITY', '缺药圃应拒 NEED_FACILITY');

    state.facilities.garden = 1;
    state.facilities.gardenStarted = -9; // 药圃闲着才能翻
    const r2 = tryBuild(r1.state, 'garden_veg');
    assert.deepEqual(r2.rejects, []);

    let s = r2.state;
    const vegBefore = s.inventory.veg || 0;
    for (let d = 0; d < 6; d++) s = skipDayAtHome(s);
    assert.ok((s.inventory.veg || 0) > vegBefore, '五天后收菜');
    assert.equal(s.facilities.gardenStarted, -9, '菜园走完了一轮生长（收成后复位）');
  });

  test('园子产量听内容包的：药圃按 facilities 定义收 4 株（不是代码写死的 3）', () => {
    const def = PACK.facilities.find((f) => f.id === 'garden');
    assert.equal(def.yield.herb, 4);
    const { state } = newRun({ seed: 7 });
    state.facilities.garden = 1;
    state.facilities.gardenStarted = state.day;
    let s = state;
    const before = s.inventory.herb || 0;
    for (let d = 0; d < 5; d++) s = skipDayAtHome(s);
    assert.equal((s.inventory.herb || 0) - before >= 4, true, '按内容包产量收成');
  });
});

describe('场景：管家认得新户口（自主可达）', () => {
  const settleBase = (state) => {
    // 底线与中盘件都已落成，把建造序压到铁炉/菜园档——单测只考察这两档
    Object.assign(state.facilities, { stove: 1, stove_eco: 1, bed: 3, heater: 1, trap: 1, garden: 1 });
    state.doorLevel = 1;
    state.inventory.wood = 8; state.inventory.parts = 20; state.inventory.comp = 20;
    return state;
  };

  test('已有火盆且部件够时，管家会提议搭铁炉', () => {
    const { state } = newRun({ seed: 7 });
    settleBase(state);
    const plan = planDay(state, PACK);
    assert.ok(plan.some((i) => i.action === 'build' && i.target === 'heater_iron'), '管家应提议铁炉');
  });

  test('药圃闲着、家里断粮但有药时，管家翻菜园', () => {
    const { state } = newRun({ seed: 7 });
    settleBase(state);
    state.facilities.heater_iron = 1; // 铁炉档也别抢
    state.facilities.gardenStarted = -9;
    state.inventory.meal = 0; state.inventory.raw = 0; state.inventory.veg = 0;
    state.inventory.herbmed = 2;
    const plan = planDay(state, PACK);
    assert.ok(plan.some((i) => i.action === 'build' && i.target === 'garden_veg'), '断粮有药应翻菜园');
  });
});
