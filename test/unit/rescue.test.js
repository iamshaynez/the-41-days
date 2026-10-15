// 兜底推进卡（补笔）纯逻辑：任何「无卡可点」的存档都要有路走。
// 背景：断线/旧档可能停在没有任何停问卡的状态（渲染链半途被砸断，或
// 落在从不停留的相位）——玩家面对一本翻不动的书。补笔卡按相位给出
// 安全的推进选项；选项必须落在内核已认的意图形状上。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rescueOptions } from '../../packages/web/public/rescue.js';

const ALL_PHASES = ['prologue', 'day', 'dusk', 'night', 'dawn'];

describe('补笔卡：每个相位都有路走', () => {
  for (const phase of ALL_PHASES) {
    test(`${phase}：至少一个可点的推进选项`, () => {
      const opts = rescueOptions({ phase, over: false });
      assert.ok(opts.length >= 1, `${phase} 应有选项`);
      for (const o of opts) {
        assert.ok(typeof o.label === 'string' && o.label.length >= 2, `${phase} 选项要有玩家语言`);
        assert.ok(o.intents || o.input, `${phase} 选项必须能走输入管线（意图或原话）`);
      }
    });
  }
  test('未知相位也有兜底（照常过）——永不无路可走', () => {
    assert.ok(rescueOptions({ phase: 'weird' }).length >= 1);
    assert.ok(rescueOptions(null).length >= 1);
  });
});

describe('补笔卡：选项只走内核认得的形状', () => {
  test('意图型选项都是 {type} 对象', () => {
    for (const phase of ALL_PHASES) {
      for (const o of rescueOptions({ phase })) {
        for (const i of o.intents || []) {
          assert.equal(typeof i.type, 'string', '意图必须带 type（validateIntentShape 的门槛）');
        }
      }
    }
  });
  test('黄昏没有普适按钮——用原话走输入管线（自由文本是万能钥匙）', () => {
    for (const o of rescueOptions({ phase: 'dusk' })) {
      if (!o.intents?.length) assert.ok(o.input && o.input.length >= 4, '无意图选项必须是可落笔的原话');
    }
  });
  test('白天与黑夜的推进都来自既有宏（auto_day / night:retreat）', () => {
    const intents = (s) => rescueOptions(s).flatMap((o) => o.intents || []);
    assert.ok(intents({ phase: 'day' }).some((i) => i.type === 'auto_day'));
    assert.ok(intents({ phase: 'night' }).some((i) => i.type === 'night' && i.action === 'retreat'));
  });
});
