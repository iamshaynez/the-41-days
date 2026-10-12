// 内容包 v2 场景测试：裂缝卡（HIDE-01）+ 文档布线（孤儿文档清零）+ 对子卡门槛
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK, skipDayAtHome } from '../helpers.js';

describe('文档布线审计（正典圣经 §7：每条事实必须有可抵达的纸）', () => {
  test('所有已定义文档都能在某个地点被找到', () => {
    const placed = new Set();
    for (const loc of PACK.locations) {
      for (const r of loc.rooms) {
        for (const c of r.containers || []) {
          for (const d of c.docs || []) placed.add(d);
          if (c.doc) placed.add(c.doc);
        }
      }
      for (const d of loc.docsPool || []) placed.add(d);
    }
    const defined = PACK.docs.map((d) => d.id);
    const orphans = defined.filter((id) => !placed.has(id));
    assert.deepEqual(orphans, [], `孤儿文档（定义了但不可抵达）：${orphans.join(', ')}`);
  });
});

describe('裂缝卡（人物设计 §3 HIDE-01）', () => {
  test('素徽在队：第 4 天后裂缝卡可触发且选项结算', () => {
    const { state } = newRun({ seed: 41, roster: ['zofia', 'marta', 'bron'] });
    let s = state;
    // 直接注入事件（裂缝卡的触发条件由 drawMorningEvents 保证，此处测结算）
    s.day = 5;
    s.activeEvent = { cardId: 'i_zofia_hum' };
    const r = step(s, [{ type: 'event_choice', option: 'listen' }]);
    assert.ok(r.state.eventFlags.zofia_hum, '裂缝揭示标记落账');
    const card = PACK.cardMap.i_zofia_hum;
    assert.ok(card.text.includes('三短'), '裂缝卡携带灰雀线的听觉钩子');
  });

  test('对子卡：薄姑×大柯缺一不触发（requiresChars 门槛）', () => {
    // 同在队 → 可触发
    const both = newRun({ seed: 42, roster: ['vera', 'grigory', 'bron'] });
    let s = both.state;
    s.day = 12;
    s.activeEvent = { cardId: 'i_pair_doorplank' };
    s = step(s, [{ type: 'event_choice', option: 'ask' }]).state;
    assert.ok(s.eventFlags.pair_door_seen);
    assert.ok(ch(s, 'vera').moodPts < 2 && ch(s, 'grigory').moodPts < 2, '两个人都被刺痛');
    // 缺一 → 抽牌过滤器拒绝
    const solo = newRun({ seed: 43, roster: ['vera', 'marta', 'bron'] });
    const card = PACK.cardMap.i_pair_doorplank;
    const eligible = card.when.requiresChars.every((id) => solo.state.chars.some((c) => c.id === id && c.alive));
    assert.equal(eligible, false, '大柯不在队时门版卡不得出现');
  });

  test('裂缝卡全部通过内容校验且 once 标记', () => {
    const cracks = PACK.cards.filter((c) => c.title?.startsWith('裂缝'));
    assert.equal(cracks.length, 9);
    for (const c of cracks) {
      assert.ok(c.when.once, `${c.id} 必须 once`);
      assert.ok(c.text.length > 30, `${c.id} 的裂缝要有戏`);
    }
  });
});
