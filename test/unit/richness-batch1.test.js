// 丰满体验批次一（feat/richness-batch1）验收：宽心汤 · 商人全自动救命 · GE 命运弧扩充。
// 对应《一周目实录与体验报告》7.2 的 P1/P3 方案（商人方向按最新产品意见调整：零交互）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK } from '../helpers.js';
import { planDay, planDusk, suggests, tradeDeals, feasibleIntent } from '../../packages/core/index.js';
import { validateIntentShape } from '../../packages/core/index.js';
import { createGeDirector, currentArc } from '../../packages/server/ge.js';

describe('F1 宽心汤（崩溃链的主动干预面）', () => {
  test('懂医的人熬汤：草药+水换安抚+2 与心情+1，账面全记', () => {
    const { state } = newRun({ seed: 3, roster: ['marta', 'emil', 'pavel'] });
    const marta = ch(state, 'marta'); // healer
    const emil = ch(state, 'emil');
    emil.breakdown = { stage: 1 }; emil.soothed = 0; emil.moodPts = -15;
    state.inventory.herb = 1; state.inventory.water = 2;
    marta.ap = 3;
    const r = step(state, [{ type: 'act', actor: 'marta', action: 'comfort_soup', patient: 'emil' }]);
    assert.ok(r.rejects.length === 0, JSON.stringify(r.rejects));
    const e2 = ch(r.state, 'emil');
    assert.equal(e2.soothed, 2, '安抚 +2');
    assert.ok(e2.moodPts > -15, '心情回暖');
    assert.equal(r.state.inventory.herb || 0, 0, '草药耗掉');
    assert.equal(ch(r.state, 'marta').ap, 2, '耗 1 行动力');
    assert.ok(r.events.some((e) => e.t === 'CHAR_FLAG' && e.d.key === 'soothed'), '安抚走事件镜像（可回放）');
  });

  test('不懂医/没材料/没人需要——各有各的拒绝码', () => {
    const { state } = newRun({ seed: 3, roster: ['marta', 'emil', 'pavel'] });
    state.inventory.herb = 1; state.inventory.water = 1;
    let r = step(state, [{ type: 'act', actor: 'emil', action: 'comfort_soup' }]);
    assert.equal(r.rejects[0]?.reason, 'NEED_TRAIT');
    r = step(state, [{ type: 'act', actor: 'marta', action: 'comfort_soup' }]);
    assert.equal(r.rejects[0]?.reason, 'NO_PATIENT', '全员心态健康时不需要汤');
    ch(state, 'emil').moodPts = -12;
    state.inventory.herb = 0;
    r = step(state, [{ type: 'act', actor: 'marta', action: 'comfort_soup' }]);
    assert.equal(r.rejects[0]?.reason, 'NO_ITEM');
  });

  test('管家与建议行都会用上它', () => {
    const { state } = newRun({ seed: 3, roster: ['marta', 'emil', 'pavel'] });
    ch(state, 'emil').breakdown = { stage: 1 };
    state.inventory.herb = 1; state.inventory.water = 1;
    const intents = planDay(state, PACK);
    assert.ok(intents.some((i) => i.action === 'comfort_soup' && i.delegated), '管家计划里有宽心汤');
    const out = suggests(state, PACK);
    assert.ok(out.some((x) => x.label.includes('宽心汤')), '建议行有一键熬汤');
    const it = out.find((x) => x.label.includes('宽心汤')).intents[0];
    assert.ok(feasibleIntent(state, PACK, it), '建议的意图点得动');
  });
});

describe('F2 商人全自动救命（零交互）', () => {
  test('断粮时成交单第一笔是食物', () => {
    const { state } = newRun({ seed: 3, roster: ['marta', 'emil', 'pavel'] });
    state.franko = { merchant: 'franko', stock: [
      { item: 'wood', n: 4, buy: 3 }, { item: 'canned', n: 3, buy: 5 }, { item: 'bandage', n: 1, buy: 6 }
    ] };
    // 断粮 + 无伤病：食物必须排第一
    for (const k of ['meal', 'canned', 'raw', 'meat']) state.inventory[k] = 0;
    state.inventory.jewel = 4; state.inventory.parts = 8;
    const deals = tradeDeals(state, PACK);
    assert.ok(deals.length, '断粮必有成交单');
    assert.ok(deals[0].get.canned || deals[0].get.raw, `第一笔应是食物（实际 ${JSON.stringify(deals[0].get)}）`);
  });

  test('planDay：鲁舟在门口必自动成交一笔（玩家零决策）', () => {
    const { state } = newRun({ seed: 3, roster: ['marta', 'emil', 'pavel'] });
    state.franko = { merchant: 'franko', stock: [{ item: 'canned', n: 2, buy: 5 }] };
    for (const k of ['meal', 'canned', 'raw', 'meat']) state.inventory[k] = 0;
    state.inventory.jewel = 3;
    const intents = planDay(state, PACK);
    const trade = intents.find((i) => i.type === 'trade_op' && i.delegated);
    assert.ok(trade, '到访自动成交');
    assert.ok(trade.get.canned, '断粮时成交的是食物');
  });

  test('商人交互意图已退役：merchant_chat 不再是合法意图', () => {
    assert.equal(validateIntentShape({ type: 'merchant_chat', text: '行情' }), false);
  });
});

describe('F3 命运弧扩充（素徽琴线 / 烽火线）', () => {
  test('内容包：两条新弧在册，旗标已注册', () => {
    const arcs = Object.fromEntries((PACK.ge?.arcs || []).map((a) => [a.id, a]));
    assert.ok(arcs.zofia_string, '素徽琴线弧');
    assert.ok(arcs.beacon_smoke, '烽火线弧');
    for (const a of [arcs.zofia_string, arcs.beacon_smoke]) {
      for (const k of a.flags || []) assert.ok((PACK.ge.flagKeys || []).includes(k), `旗标 ${k} 未注册`);
      assert.ok(a.brief.length >= 60, '弧 brief 要有血肉');
    }
  });

  test('currentArc：窗口内按档位取弧，窗口外不取', () => {
    const { state } = newRun({ seed: 3, roster: ['zofia', 'alexey', 'marta'] });
    state.day = 30;
    const arc = currentArc(PACK, state);
    assert.ok(arc, 'D30 应有弧可用');
    state.day = 5;
    const early = currentArc(PACK, state);
    assert.equal(early, null, '窗口未开无弧');
  });

  test('弧能走完 生成→验证→注入 全链（编剧桩）', async () => {
    let s = newRun({ seed: 5, roster: ['zofia', 'alexey', 'marta'] }).state;
    s.firedOnce = { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 };
    s.day = 20; s.phase = 'day';
    const arc = currentArc(PACK, s);
    assert.ok(arc, 'D20 有弧');
    const provider = { call: async () => ({ text: JSON.stringify({
      title: '断弦与旧谱', theme: arc.theme, arc: arc.id,
      anchors: ['第20天', '角色:素徽'],
      text: '素徽认得那张谱。她把它按在琴上，指腹压着断弦，很久没抬手。屋里没人催她。',
      options: [
        { label: '当着全家的面弹完这一段', mood_all: 1, flag: { fate_string_played: true } },
        { label: '把谱折好，收进她的箱底', mood_char: { name: '素徽', n: -1 }, flag: { fate_kept_silent: true } },
        { label: '谁也不提这件事' }
      ]
    }) }) };
    const dir = createGeDirector({ pack: PACK, prompts: { playwright: '{{anchors}} {{arc}}' }, getProvider: () => provider });
    await dir.onTurn('r', s);
    s.phase = 'dusk'; await dir.onTurn('r', s);
    assert.ok(!s.activeEvent, 'day 弧不在黄昏注入');
    s.day = 21; s.phase = 'day'; await dir.onTurn('r', s);
    assert.ok(s.activeEvent?.generated, '次日白天注入弧卡');
    assert.ok(s.geArcsFired?.[arc.id], '弧注入即烧（每局一次）');
  });
});
