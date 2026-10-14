// 谋士分工商簿（今日卡可行域重做）：旧版 actionMenu 只按「第一个有行动力的人」
// 算一张单人清单——专长动作只在该人名下出现，模型看不见分工面，出的方略
// 挤在一个人身上，也没有「让累的人歇着」这种安排。
// 新版按人分列：每人一行，带行动力与状态（疲惫/带伤/卧床），可行的事各算各的，
// 休息（sleep/rest/guard）是每个人的常备项——方略=分工，休整也是正经安排。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, ch, PACK } from '../helpers.js';
import { actionMenu, cardBrief } from '../../packages/server/options.js';

describe('分工商簿：按人列可行域', () => {
  test('每个活人一行，带名字、id、行动力；疲惫/带伤点名', () => {
    const { state } = newRun({ seed: 101 });
    ch(state, 'marta').fatigue = 2;
    ch(state, 'bron').wound = 1;
    const menu = actionMenu(state, PACK);
    for (const c of state.chars.filter((x) => x.alive)) {
      const line = menu.split('\n').find((l) => l.includes(`（${c.id}，`));
      assert.ok(line, `${c.name}（${c.id}）要在商簿里有自己的一行`);
    }
    assert.ok(menu.includes('力竭'), '力竭的人要点名（谋士才知道安排他歇着）');
    assert.ok(menu.includes('带伤'), '带伤的人要点名');
  });

  test('行动力耗尽的人：行内明说今天做不了事，只留说话', () => {
    const { state } = newRun({ seed: 102 });
    ch(state, 'anton').ap = 0;
    const menu = actionMenu(state, PACK);
    const line = menu.split('\n').find((l) => l.includes('（anton，'));
    assert.ok(line.includes('做不了事') || line.includes('休整'), '力尽的人要说清楚：今天做不了事');
    assert.ok(!/\bcook\b|\bcraft\b|\bbuild\b/.test(line), '力尽的人名下不该再列干活项');
  });

  test('可行的事各算各的：会做饭的人在谁名下，做饭就在谁行里', () => {
    const { state } = newRun({ seed: 103 });
    // 没有柴、没有余火——做饭只剩「天生会做饭」一条路，考验专长归属
    delete state.inventory.firewood;
    delete state.inventory.wood;
    state.facilities.stove = 1;
    state.facilities.stoveFireLeft = 0;
    const cooker = state.chars.find((c) => c.alive && c.traits?.cook);
    const nonCook = state.chars.find((c) => c.alive && !c.traits?.cook);
    if (!cooker || !nonCook) return; // 名册里没有厨子时此局不适用
    const menu = actionMenu(state, PACK);
    const cookerLine = menu.split('\n').find((l) => l.includes(`（${cooker.id}，`));
    const nonCookLine = menu.split('\n').find((l) => l.includes(`（${nonCook.id}，`));
    assert.ok(cookerLine.includes('cook 做饭'), '厨子名下要有做饭');
    assert.ok(!nonCookLine.includes('cook 做饭'), '不会做饭的人名下不该列做饭——可行域是按人算的');
  });

  test('休息是每个人的常备项：sleep 补眠行行都有', () => {
    const { state } = newRun({ seed: 104 });
    const menu = actionMenu(state, PACK);
    for (const c of state.chars.filter((x) => x.alive && x.ap > 0)) {
      const line = menu.split('\n').find((l) => l.includes(`（${c.id}，`));
      assert.ok(line.includes('sleep 补眠'), `${c.name} 名下要有补眠——主动休息是可选的方略`);
    }
  });
});

describe('今日卡语境：方略=分工', () => {
  test('brief 点明分头安排与休整也是方略', () => {
    const { state } = newRun({ seed: 105 });
    const brief = cardBrief(state, PACK, 'day');
    assert.ok(brief.includes('分工商簿') || brief.includes('分工'), '语境要点明这是分工');
    assert.ok(/休整|歇着/.test(brief), '要点明「让累的人歇着」也是正经方略');
    assert.ok(brief.includes('【id 对照'), 'id 对照不丢（回归）');
  });
});
