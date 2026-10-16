// 黄昏方案的可读性与断粮诚实性（线上实测：断粮 0 顿时排第一的方案是
// 「江鳅去北津台」——北津台容器里没有任何食物，还盖着「这趟先为嘴」的章；
// 玩家看不出哪个方案偏向补给，点了也带不回吃的）。
// 铁律：①断粮时嘴压过誓位——富食地方排第一，无食誓地不再冒充找吃的方案；
// ②但誓地保底一席（闭合纪律：答应过的话看得见兑现口）；
// ③每个方案的 hint 写明产出（翻得出吃的：X／翻不出吃的，只有Y）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, PACK } from '../helpers.js';
import { planDusk } from '../../packages/core/src/delegate.js';
import { cardBrief } from '../../packages/server/options.js';

const ROSTER = ['bron', 'marta', 'katya'];
const famineDusk = (seed = 710) => {
  const s = newRun({ seed, roster: ROSTER }).state;
  s.day = 22; s.phase = 'dusk';
  for (const k of ['market', 'beacon', 'sewer', 'church', 'villas', 'hospital', 'post']) if (!s.knownLocs.includes(k)) s.knownLocs.push(k);
  s.inventory.meal = 0; s.inventory.canned = 0; s.inventory.raw = 0; s.inventory.meat = 0; s.inventory.veg = 0;
  s.inventory.crowbar = 1;
  return s;
};

describe('断粮诚实性：嘴压过誓位', () => {
  test('0 顿＋北津台的誓：第一方案必须是富食地点——无食誓地不冒充找吃的', () => {
    const s = famineDusk();
    s.directions = { d1: { id: 'd1', text: '天黑前登北津台看看', kind: 'vow', target: 'beacon', day: 20, lastDay: 20, alive: true, watered: 0 } };
    const plans = planDusk(s, PACK).plans;
    const top = plans.find((p) => p.intent.scavenger && p.intent.location);
    assert.notEqual(top.intent.location, 'beacon', `断粮 0 顿，排第一的不该是没有任何食物的北津台（实际：${top.intent.location}）`);
    assert.match(top.hint, /翻得出吃的/, '第一方案的 hint 要写明翻得出吃的');
    assert.doesNotMatch(plans.find((p) => p.intent.location === 'beacon')?.hint || '', /先为嘴/, '北津台方案不得盖「先为嘴」的章——它带不回吃的');
  });

  test('誓地保底一席：断粮压过誓位时，北津台方案仍出现在卡上（闭合纪律）', () => {
    const s = famineDusk();
    s.directions = { d1: { id: 'd1', text: '天黑前登北津台看看', kind: 'vow', target: 'beacon', day: 20, lastDay: 20, alive: true, watered: 0 } };
    const plans = planDusk(s, PACK).plans;
    const beaconPlan = plans.find((p) => p.intent.location === 'beacon');
    assert.ok(beaconPlan, '誓指向的地点必须仍在方案之列——答应过的话看得见兑现口');
    assert.match(beaconPlan.hint, /践誓/, '誓地方案 hint 点明践誓');
    assert.match(beaconPlan.hint, /翻不出吃的/, '北津台 hint 要写明翻不出吃的（只有柴铁）');
  });

  test('非危急缺口（还有 3 顿）：誓仍排第一——嘴没到压过诺言的地步（不回归）', () => {
    const s = famineDusk(711);
    s.inventory.raw = 9; // 3 人 3 顿
    s.directions = { d1: { id: 'd1', text: '天黑前登北津台看看', kind: 'vow', target: 'beacon', day: 20, lastDay: 20, alive: true, watered: 0 } };
    const plans = planDusk(s, PACK).plans;
    const top = plans.find((p) => p.intent.scavenger && p.intent.location);
    assert.equal(top.intent.location, 'beacon', '没到断粮，誓仍优先');
  });
});

describe('产出可读性：方案与谋士简报都写明偏什么', () => {
  test('每个带人带地方的方案 hint 都有产出线（吃的在前）', () => {
    const s = famineDusk();
    const plans = planDusk(s, PACK).plans;
    for (const p of plans.filter((x) => x.intent.scavenger && x.intent.location)) {
      assert.match(p.hint, /翻得出吃的|翻不出吃的/, `「${p.label}」的 hint 要写明产出（${p.hint}）`);
    }
  });

  test('谋士简报的已知地点带产出标注：北津台标「翻不出吃的」', () => {
    const s = famineDusk();
    const brief = cardBrief(s, PACK, 'dusk');
    assert.match(brief, /北津台（[^）]*翻不出吃的/, `简报要给北津台标产出（找「北津台（」）`);
    assert.match(brief, /被焚的南市（[^）]*翻得出吃的/, '南市要标富食');
  });

  test('断粮时留守方案点明保底：明早挖野菜', () => {
    const s = famineDusk();
    const stay = planDusk(s, PACK).plans.find((p) => p.key === 'stay');
    assert.match(stay.hint, /野菜/, `留守方案要交代保底出路（${stay.hint}）`);
  });
});
