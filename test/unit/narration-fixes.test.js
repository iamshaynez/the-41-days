// 玩家体验修复回归（直读叙事）：死亡播报名字、事件选项不可用原因。
// 动机：实测一局（seed 7）中角色死亡播报落成内部 id（"bron的病，没能熬过去"）——
// 全游戏最动情的一秒被变量名打断；事件选项缺件时只说"条件不够"，玩家无从知道缺什么。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK } from '../helpers.js';
import { renderDirect } from '../../packages/server/narrate.js';
import { chooseEventOption, eventOptionsView } from '../../packages/core/src/events.js';
import { Ctx } from '../../packages/core/src/ctx.js';

describe('死亡播报：死者必须用名字，不许漏内部 id（修复①）', () => {
  test('dying_sick / death 事实渲染出中文名，不含英文 id', () => {
    const { state } = newRun({ seed: 11 });
    // 石大（bron）死于病——先标记死亡，再补两条"临终/死亡"事实（时序与内核一致：die() 后才有 dying/death 事实）
    ch(state, 'bron').alive = false;
    const text = renderDirect(state, [
      { k: 'dying_sick', char: 'bron' },
      { k: 'death', char: 'bron' }
    ], PACK);
    assert.match(text, /石大/);
    assert.doesNotMatch(text, /bron/);
  });

  test('饿病发作（未死）照常用名字', () => {
    const { state } = newRun({ seed: 11 });
    const text = renderDirect(state, [{ k: 'starve_sick', char: 'marta' }], PACK);
    assert.match(text, /辛夷/);
    assert.doesNotMatch(text, /marta/);
  });
});

describe('事件选项可用性：视图带 ok/why，选择被拒不裸奔（修复⑤）', () => {
  test('无锸时"借工具"视图标 ok:false 且 why 写明缺什么', () => {
    const { state } = newRun({ seed: 12 });
    state.activeEvent = { cardId: 'n_tool' };
    const view = eventOptionsView(state, PACK);
    const lend = view.find((o) => o.key === 'lend');
    const refuse = view.find((o) => o.key === 'refuse');
    assert.equal(lend.ok, false, '家里没有锸，lend 应不可用');
    assert.ok(lend.why && lend.why.includes('锸'), `why 应写明缺锸（实际：${lend.why}）`);
    assert.equal(refuse.ok, true, '拒绝永远可用');
  });

  test('有锸时 lend 可用', () => {
    const { state } = newRun({ seed: 12 });
    state.inventory.shovel = 1; // 锸
    state.activeEvent = { cardId: 'n_tool' };
    const view = eventOptionsView(state, PACK);
    assert.equal(view.find((o) => o.key === 'lend').ok, true);
  });

  test('选了不可用选项：叙事事实带 why（直读渲染不再只说"条件不够"）', () => {
    const { state } = newRun({ seed: 12 });
    state.activeEvent = { cardId: 'n_tool' };
    const events = [], facts = [];
    const ctx = new Ctx(state, PACK, events, facts);
    const r = chooseEventOption(ctx, 'lend');
    assert.equal(r.ok, false);
    const f = facts.find((x) => x.k === 'option_unavailable');
    assert.ok(f, '落 option_unavailable 事实');
    assert.ok(f.why && f.why.length > 0, 'why 有内容');
    const text = renderDirect(state, facts, PACK);
    assert.match(text, /锸/, '直读渲染写明缺锸');
    assert.doesNotMatch(text, /条件不够/, '不再是无信息量的拒绝');
  });
});
