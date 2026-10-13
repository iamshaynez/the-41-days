// 堂屋校验器（人物血肉计划 PR2 · 提示词金样本断言）：
// 归属准确率 / 越界人名拒绝 / 封印泄漏零容忍 / 直读拼装确定性。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PACK } from '../helpers.js';
import { validateEnsemble, renderEnsembleDirect, ENS_CANON_BAN } from '../../packages/core/src/ensemble.js';

const scene = {
  id: 'en_2_1', day: 2, kind: 'comment',
  participants: ['katya', 'marta'],
  topic: { stepId: 'm_d01' },
  outcome: { beat: '话说到末尾，各自点头。', mood: {}, pair: [] }
};

describe('validateEnsemble（LLM 台词的三道闸）', () => {
  test('合格输出放行', () => {
    const out = {
      lines: [
        { char: '白简', text: '捷报的笔画每次一样。' },
        { char: '辛夷', text: '脉搏不撒谎。' },
        { char: '白简', text: '所以我不抄。' }
      ],
      narration: '堂屋晨话。'
    };
    const v = validateEnsemble(scene, out, PACK);
    assert.equal(v.ok, true, JSON.stringify(v.reasons));
  });

  test('越界人名拒绝：场外人一句都不许说', () => {
    const out = { lines: [
      { char: '白简', text: '我说。' }, { char: '辛夷', text: '我也说。' },
      { char: '石大', text: '我旁听也要发言。' }
    ] };
    const v = validateEnsemble(scene, out, PACK);
    assert.equal(v.ok, false);
    assert.ok(v.reasons.some((r) => r.includes('越界')));
  });

  test('封印泄漏零容忍：禁词一句即废整份', () => {
    const out = { lines: [
      { char: '白简', text: '更籍被人卖了。' },
      { char: '辛夷', text: '什么籍？' },
      { char: '白简', text: '没什么。' }
    ] };
    const v = validateEnsemble(scene, out, PACK);
    assert.equal(v.ok, false);
    assert.ok(v.reasons.some((r) => r.includes('禁词')));
    // 禁词表本身覆盖正典最硬的几个秘密
    for (const w of ['更籍', '素伯', '白翎', '白衣渡江', '糜芳']) assert.ok(ENS_CANON_BAN.includes(w));
  });

  test('整场不开口的人：拒', () => {
    const out = { lines: [
      { char: '白简', text: '就我说。' }, { char: '白简', text: '还是我说。' }, { char: '白简', text: '一直是我说。' }
    ] };
    const v = validateEnsemble(scene, out, PACK);
    assert.equal(v.ok, false);
    assert.ok(v.reasons.some((r) => r.includes('没开口')));
  });

  test('台词数量出界：拒（少于三句或多于十句）', () => {
    assert.equal(validateEnsemble(scene, { lines: [{ char: '白简', text: '嗯。' }] }, PACK).ok, false);
    assert.equal(validateEnsemble(scene, { lines: Array.from({ length: 11 }, (_, i) => ({ char: i % 2 ? '辛夷' : '白简', text: `第${i}句` })) }, PACK).ok, false);
  });
});

describe('renderEnsembleDirect（直读拼装兜底）', () => {
  test('评史场：每人一句立场/声口，落内核定的结局拍', () => {
    const out = renderEnsembleDirect(scene, PACK);
    assert.ok(out.lines.length >= 2);
    assert.ok(out.lines.every((l) => scene.participants.includes(l.char)), '只许场内人开口');
    assert.ok(out.narration.includes(scene.outcome.beat), '旁白必须收在结局拍上');
    assert.ok(out.lines[0].text.length >= 4, '台词成句');
  });

  test('暗面场：堕落台词可用作直读原料', () => {
    const sc = { ...scene, kind: 'shadow', participants: ['anton', 'marta'] };
    const out = renderEnsembleDirect(sc, PACK);
    assert.ok(out.lines.length >= 2);
    assert.ok(out.narration.includes(sc.outcome.beat));
  });

  test('确定性：同一场景两次渲染逐字节一致', () => {
    assert.deepEqual(renderEnsembleDirect(scene, PACK), renderEnsembleDirect(scene, PACK));
  });
});
