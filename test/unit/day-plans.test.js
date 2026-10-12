// 今日方略（闭合节奏）：白天选项 = 多人意图束 + 自动收卷（auto_day 殿后）。
// 点一个 ◇ 方略 = 这一天安排完并进入黄昏——不再一个一个选。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack, createRun, beginRun } from '../../packages/core/index.js';
import { validateOptions } from '../../packages/server/options.js';

const PACK = loadPack();

function dayState() {
  const state = createRun(PACK, { seed: 51, roster: ['anton', 'marta', 'bron'] });
  beginRun(state, PACK, {});
  return state;
}

const RAW = {
  options: [
    { label: '文简守门，辛夷跟石大学认字', hint: '一天的门与一点指望',
      intents: [
        { type: 'act', actor: 'anton', action: 'guard' },
        { type: 'direction', subject: 'marta', text: '跟石大学认字' }
      ] },
    { label: '翻完家里，晚上交给自己', intents: [{ type: 'act', actor: 'bron', action: 'search_home' }, { type: 'auto_day' }] },
    { label: '全是不可行的', intents: [{ type: 'act', actor: 'nobody', action: 'guard' }] }
  ]
};

describe('今日方略（card=day 闭环）', () => {
  test('白天选项尾部自动补 auto_day 收卷；模型自带的收走重排到最后', () => {
    const out = validateOptions(PACK, dayState(), RAW, { card: 'day' });
    assert.equal(out.length, 2, '第三个全不可行被滤');
    for (const o of out) {
      assert.equal(o.intents.at(-1).type, 'auto_day', `${o.label} 应以收卷结尾`);
      assert.equal(o.intents.filter((i) => i.type === 'auto_day').length, 1, '收卷不重复');
      assert.ok(o.hint.includes('入黄昏'), `hint 应交代收卷：${o.hint}`);
    }
    // 第二个：模型自带 auto_day 被收走重排，search_home 仍在最前
    assert.equal(out[1].intents[0].action, 'search_home');
  });

  test('黄昏/夜间选项不收卷（世界的问题不越权）', () => {
    const out = validateOptions(PACK, dayState(), RAW, { card: 'dusk' });
    assert.ok(out.every((o) => o.intents.every((i) => i.type !== 'auto_day')));
    assert.ok(out.every((o) => !o.hint.includes('入黄昏')));
  });

});

import { resolveInput } from '../../packages/core/index.js';
import { newRun } from '../helpers.js';

describe('方略执行（内核侧）', () => {
  test('点方略 → 自动收卷 → 相位入夜线（dusk）', () => {
    const { state } = newRun({ seed: 52, roster: ['anton', 'marta', 'bron'] });
    const plan = [
      { type: 'act', actor: 'anton', action: 'guard' },
      { type: 'direction', subject: 'marta', text: '跟石大学认字' },
      { type: 'auto_day' }
    ];
    const r = resolveInput(state, PACK, plan);
    assert.equal(r.state.phase, 'dusk', `应收卷入黄昏（实际 ${r.state.phase}）`);
    assert.ok(r.facts.some((f) => f.k === 'direction_set'), '念头种下');
    assert.ok(r.facts.some((f) => f.k === 'phase_dusk'), '入黄昏');
  });
});
