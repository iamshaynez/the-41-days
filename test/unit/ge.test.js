// C 层生成事件验证器（内核设计-v0.2 §8.8 GE-03~10）：白名单/锚/防火墙/指纹/预算
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, PACK } from '../helpers.js';
import { validateProposal, proposalToCard, anchorPool } from '../../packages/core/src/ge.js';

function good() {
  return {
    title: '半块麦饼',
    text: '对门的老者把半块麦饼放在你们门槛上，没留话。文简捡起来时饼还是热的，说明他家里今天有火。',
    theme: '稀缺',
    anchors: ['第5天', '天气:clear'],
    options: [
      { label: '收进来，分着吃', mood_all: 1, outcomeText: '饼很硬，很暖。' },
      { label: '放回去', outcomeText: '门槛空了。' }
    ]
  };
}

function stateAt(day = 5) {
  const { state } = newRun({ seed: 11, roster: ['anton', 'marta', 'bron'] });
  state.day = day;
  return state;
}

describe('GE 验证器（四重门）', () => {
  test('合格提案通过并给指纹', () => {
    const s = stateAt();
    const v = validateProposal(PACK, s, good(), { anchors: anchorPool(PACK, s) });
    assert.ok(v.ok, `应通过（实际拒绝：${v.reasons}）`);
    assert.ok(v.fingerprint);
  });
  test('防火墙：正典词与正史名人秒拒', () => {
    const s = stateAt();
    const p = good();
    p.text += '听说关羽的军营里……';
    const v = validateProposal(PACK, s, p, { anchors: anchorPool(PACK, s) });
    assert.ok(!v.ok && v.reasons.some((r) => r.includes('防火墙')), '正史锚点拦截');
    const p2 = good();
    p2.text += '渡口的白翎又放箭了';
    assert.ok(!validateProposal(PACK, s, p2, { anchors: anchorPool(PACK, s) }).ok, '暗线词拦截');
  });
  test('锚不足两个即拒（GE-04）', () => {
    const s = stateAt();
    const p = good();
    p.anchors = ['第5天'];
    assert.ok(!validateProposal(PACK, s, p, { anchors: anchorPool(PACK, s) }).ok);
    p.anchors = ['第5天', '编造的锚'];
    assert.ok(!validateProposal(PACK, s, p, { anchors: anchorPool(PACK, s) }).ok, '锚必须在锚池里');
  });
  test('效果白名单：越带即拒（GE-03）', () => {
    const s = stateAt();
    let p = good();
    p.options[0].mood_all = 5;
    assert.ok(!validateProposal(PACK, s, p, { anchors: anchorPool(PACK, s) }).ok, '心情越带');
    p = good();
    p.options[0].items_gain = { canned: 4 }; // 肉脯 4×12=48 ≫ 4
    assert.ok(!validateProposal(PACK, s, p, { anchors: anchorPool(PACK, s) }).ok, '得物超值');
    p = good();
    p.options[0].items_gain = { nosuch: 1 };
    assert.ok(!validateProposal(PACK, s, p, { anchors: anchorPool(PACK, s) }).ok, '未知物品');
    p = good();
    p.options = [p.options[0]]; // 只剩 1 个应对面
    assert.ok(!validateProposal(PACK, s, p, { anchors: anchorPool(PACK, s) }).ok, '应对面不足');
  });
  test('指纹 7 天冷却（GE-08）', () => {
    const s = stateAt(5);
    const p = good();
    const v1 = validateProposal(PACK, s, p, { anchors: anchorPool(PACK, s) });
    assert.ok(v1.ok);
    s.geFingers = { [v1.fingerprint]: 5 };
    assert.ok(!validateProposal(PACK, s, p, { anchors: anchorPool(PACK, s) }).ok, '同指纹冷却期内拒');
    s.day = 13;
    p.anchors = ['第13天', '天气:clear']; // 锚随日子走（锚池现算）
    assert.ok(validateProposal(PACK, s, p, { anchors: anchorPool(PACK, s) }).ok, '冷却过后放行');
  });
  test('预算：占比 25% 封顶（GE-02）', () => {
    const s = stateAt(10);
    s.geShown = 2; s.firedOnce = { a: true, b: true, c: true }; // 5 件里 2 件 C 层，再一件即超
    assert.ok(!validateProposal(PACK, s, good(), { anchors: anchorPool(PACK, s) }).ok, '占比封顶');
  });
});

describe('GE 提案 → 卡 → 结算', () => {
  test('生成卡进 run 级卡册，选项正常结算', () => {
    let s = stateAt(5);
    const v = validateProposal(PACK, s, good(), { anchors: anchorPool(PACK, s) });
    const card = proposalToCard(PACK, s, good());
    s.geCards = { [card.id]: card };
    s.activeEvent = { cardId: card.id, generated: true };
    const before = s.chars[0].moodPts;
    s = step(s, [{ type: 'event_choice', option: 'g0' }]).state;
    assert.ok(s.chars[0].moodPts > before, '全队心情 +1 生效');
    assert.ok(!s.activeEvent, '卡结算完即收');
  });
});
