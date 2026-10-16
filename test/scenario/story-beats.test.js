// 剧情节拍与关键抉择的分层（用户设计总纲）：
//   日常剧本（裂缝/揭示/心事/世情/市语）是背景流——随时间刷出来、告诉玩家，
//   不占行动位、不干扰生存；只有影响结局的关键选择才配一张卡，且选项里写明后果解释。
// 内容侧以 card.beat 标记节拍（内容即数据）；内核侧统一入口 fireEventCard：
//   节拍 → 自动落账（auto 选项），故事随 event/event_text/card_resolved 事实流入当日叙述；
//   决断卡 → 照旧挂 activeEvent 等玩家选。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK } from '../helpers.js';
import { fireEventCard, eventOptionsView } from '../../packages/core/src/events.js';
import { drawMorningEvents } from '../../packages/core/src/vitals.js';
import { Ctx } from '../../packages/core/index.js';

describe('节拍卡：故事流入叙述，不占行动位', () => {
  test('fireEventCard 节拍：裂缝卡自动落账——不挂 activeEvent、故事三段进事实', () => {
    const s = newRun({ seed: 830, roster: ['alexey', 'marta', 'bron'] }).state;
    s.firedOnce['i_alexey_leg'] = true; // 发火点的记账职责不变
    const facts = [];
    const ctx = new Ctx(s, PACK, [], facts);
    const before = ch(s, 'alexey').moodPts;
    const r = fireEventCard(ctx, 'i_alexey_leg');
    assert.ok(r.beat, '裂缝卡是节拍');
    assert.ok(!s.activeEvent, '不占行动位——玩家今天照常过日子');
    assert.equal(s.eventFlags.alexey_leg, true, 'auto 选项（递水）效果照落——线索链不断');
    assert.ok(ch(s, 'alexey').moodPts > before, '心情照涨');
    assert.ok(facts.some((f) => f.k === 'event' && f.title), '标题进事实');
    assert.ok(facts.some((f) => f.k === 'event_text' && f.text), '正文进事实（故事要讲给玩家）');
    assert.ok(facts.some((f) => f.k === 'card_resolved' && f.result), '结果句进事实');
  });

  test('fireEventCard 决断卡：终局卡照旧挂 activeEvent 等玩家', () => {
    const s = newRun({ seed: 831, roster: ['bron', 'marta', 'katya'] }).state;
    const ctx = new Ctx(s, PACK, [], []);
    const r = fireEventCard(ctx, 'alt_maicheng_drum');
    assert.ok(!r.beat, '交割前夜的鼓不是节拍');
    assert.equal(s.activeEvent?.cardId, 'alt_maicheng_drum', '关键抉择占一张卡');
  });

  test('晨抽管线走同一入口：心事保底的裂缝当日流为叙述，白天不被拦', () => {
    const s = newRun({ seed: 832, roster: ['anton', 'marta', 'bron'] }).state;
    s.day = 16; // D15+ 心事保底，避开时间轴密日
    const facts = [];
    const ctx = new Ctx(s, PACK, [], facts);
    drawMorningEvents(ctx);
    const knot = s.chars.map((c) => PACK.charMap[c.id]?.persona?.knotCard).find(Boolean);
    if (knot) { // 池子若接住了别的卡，至少不能拦在节拍上
      assert.ok(!s.activeEvent || !PACK.cardMap[s.activeEvent.cardId]?.beat, '节拍卡绝不挂 activeEvent');
    }
    assert.ok(facts.some((f) => f.k === 'event_text') || !facts.some((f) => f.k === 'event'), '有卡落就是叙述形态');
  });
});

describe('关键抉择卡：选项里写明后果解释（note）', () => {
  test('eventOptionsView 透传 note——玩家选之前看得见后果', () => {
    const s = newRun({ seed: 833, roster: ['bron', 'marta', 'katya'] }).state;
    s.activeEvent = { cardId: 'alt_maicheng_drum' };
    const view = eventOptionsView(s, PACK);
    assert.ok(view.length >= 2, '终局卡至少两个选项');
    assert.ok(view.every((o) => typeof o.note === 'string' && o.note.length >= 6), `每个选项都要有解释（${JSON.stringify(view.map((o) => o.note))}）`);
  });
});
