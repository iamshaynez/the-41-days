// 小说层（回响节拍器 + 四道反转 + 感知设计）：
// 线不住在散文里——母题句按节拍轻触（晨报/捎话），线索物化成物品，状态行常驻晨报；
// 暗面三拍链（同屋的暗面）、善的代价、D40 围门、纸的用途四道反转各有种/触/翻/收。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK } from '../helpers.js';
import { Ctx, buildEnding } from '../../packages/core/index.js';
import { tickThreads, threadsStateLines } from '../../packages/core/src/threads.js';
import { dawnProblems } from '../../packages/core/src/delegate.js';

const dawn = (seed, mutate) => {
  const { state } = newRun({ seed });
  mutate?.(state);
  const ctx = new Ctx(state, PACK, [], []);
  tickThreads(ctx);
  return { state, ctx };
};

describe('内容契约：线、幕问、契约', () => {
  test('四条线在包：母题/轻触/翻转卡/token 皆在册；五幕问；开卷契约', () => {
    const th = PACK.threads;
    assert.ok(th, 'threads.json 装包');
    assert.equal(th.threads.length, 4);
    for (const t of th.threads) {
      assert.ok(t.motif, `${t.id} 要有母题句`);
      for (const tc of t.touches || []) assert.ok(['morning', 'franko'].includes(tc.via), `${t.id} 轻触渠道合法`);
      if (t.token) assert.ok(PACK.itemMap[t.token.item], `${t.id} 的 token 在册`);
      if (t.turn) assert.ok(PACK.cardMap[t.turn.card], `${t.id} 的翻转卡在册`);
    }
    assert.equal(Object.keys(PACK.mainline.acts).length, 5, '五幕各有幕问');
    assert.match(PACK.threads.contract, /重复出现的话/);
  });
});

describe('收册的吏：贯穿人物的线', () => {
  test('D3 军簿答完 → 线激活：晨报常驻状态行 + 木牍入包', () => {
    const { state } = dawn(501, (s) => {
      s.day = 4;
      s.firedOnce['ask_m2_visit'] = true; // 军簿已答（贯穿线由此激活）
    });
    const lines = threadsStateLines(state, PACK);
    assert.ok(lines.some((l) => l.key === 'thread_clerk' && /收册/.test(l.text)), '状态行常驻晨报');
    const { state: s2, ctx } = dawn(502, (s) => { s.day = 4; s.firedOnce['ask_m2_visit'] = true; });
    assert.ok((s2.inventory.clerk_tablet || 0) >= 1, '木牍物化入包');
    assert.ok(ctx.facts.some((f) => f.k === 'token_found' && f.item === 'clerk_tablet'), '物化事实落账');
  });
  test('晨报轻触：D9 那句「升了」只来一次', () => {
    const { state, ctx } = dawn(503, (s) => { s.day = 9; s.firedOnce['ask_m2_visit'] = true; });
    assert.ok(ctx.facts.some((f) => f.k === 'thread_touch' && /升了/.test(f.line)), 'D9 轻触落账');
    const ctx2 = new Ctx(state, PACK, [], []);
    tickThreads(ctx2); // 同日再跑：不重
    assert.equal(ctx2.facts.filter((f) => f.k === 'thread_touch').length, 0, '同线同触不重发');
  });
});

describe('纸的用途：种—触—翻—收', () => {
  test('D8 烧焦纸角入包；D32-34 翻转卡落晨', () => {
    const { state } = dawn(510, (s) => { s.day = 8; });
    assert.ok((state.inventory.scorched_paper || 0) >= 1, '纸角 token');
    const { state: s2 } = dawn(511, (s) => { s.day = 33; s.firedOnce['ask_m2_visit'] = true; });
    assert.ok(s2.activeEvent?.cardId === 'x_paper_burn', `D33 应落翻转卡（实际 ${s2.activeEvent?.cardId}）`);
  });
  test('留在墙里 → 终局卷有尾句', () => {
    const { state } = newRun({ seed: 512 });
    state.eventFlags = { ...state.eventFlags, archive_walled: true };
    const ending = buildEnding(state, PACK);
    assert.ok(ending.storyline.codex.lines.some((l) => /墙不会忘|城会忘/.test(l)), '尾句入卷');
  });
});

describe('善的代价 + 第四十夜围门', () => {
  test('给过粥 + 溶解过阈：D27 那碗粥来叩门，D40 围门，开门入终局', () => {
    const { state } = dawn(520, (s) => {
      s.day = 27; s.eventFlags = { ...s.eventFlags, mercy_meal: true };
    });
    assert.equal(state.activeEvent?.cardId, 'c_debt_of_mercy', 'D27 债卡');
    const { state: s2 } = dawn(521, (s) => {
      s.day = 40; s.dissolve = 30; // 大军已散
    });
    assert.equal(s2.activeEvent?.cardId, 'x_final_siege', 'D40 围门卡');
    // 开门 → 尾句
    const { state: s3 } = newRun({ seed: 522 });
    s3.eventFlags = { ...s3.eventFlags, mercy_meal: true, final_door_open: true };
    const ending = buildEnding(s3, PACK);
    assert.ok(ending.storyline.codex.lines.some((l) => /门是开着的/.test(l)), '开门尾句');
  });
  test('没给过粥：D27 无债卡（善未种，代价不来）', () => {
    const { state } = dawn(523, (s) => { s.day = 27; });
    assert.notEqual(state.activeEvent?.cardId, 'c_debt_of_mercy');
  });
});

describe('同屋的暗面：三拍链', () => {
  test('心结首拍已显形的人，D20-26 被指认（卡带 actor，占位符有人填）', () => {
    const { state, ctx } = dawn(530, (s) => {
      s.day = 22;
      s.firedOnce['i_bron_locks'] = true; // 石大的心结已显形
    });
    assert.equal(state.activeEvent?.cardId, 'x_shadow_reveal', '指认卡落晨');
    assert.equal(state.activeEvent.actorId, 'bron', '指认的是心结已显形的人');
    const card = PACK.cardMap.x_shadow_reveal;
    assert.match(card.title, /\{\{name\}\}/, '占位符在册（server 侧按 actor 现填）');
  });
  test('无人显形过心结：指认不来（三拍链要第一拍）', () => {
    const { state } = dawn(531, (s) => { s.day = 22; });
    assert.notEqual(state.activeEvent?.cardId, 'x_shadow_reveal');
  });
});

describe('幕问与幕结：宏观抓手', () => {
  test('D9 落第二幕问；D8 落第一幕三行收拢（你/城/悬而未决）', () => {
    const { ctx } = dawn(540, (s) => { s.day = 8; s.firedOnce['ask_m2_visit'] = true; });
    const wrap = ctx.facts.find((f) => f.k === 'act_wrap' && f.act === 'A1');
    assert.ok(wrap, 'A1 幕结在 D8（幕区间住内容包 acts.days）');
    assert.ok(wrap.open.includes('收册'), `悬而未决要点名线（实际：${wrap.open}）`);
    const { ctx: ctx2 } = dawn(541, (s) => { s.day = 9; });
    const q = ctx2.facts.find((f) => f.k === 'act_question' && f.act === 'A2');
    assert.ok(q, 'A2 幕问在 D9');
    assert.match(q.q, /散/);
  });
});

describe('线不打扰概述与一晨一卡', () => {
  test('晨位被占时翻转卡顺延（不抢随机晨抽的位）', () => {
    const { state } = dawn(550, (s) => {
      s.day = 33; s.activeEvent = { cardId: 'n_looters' };
    });
    assert.equal(state.activeEvent.cardId, 'n_looters', '线让路');
    assert.ok(!state.firedOnce['x_paper_burn'], '翻转未消耗，等下一晨');
  });
  test('线状态行 sev0：不拦平淡日概述', () => {
    const { state } = dawn(551, (s) => { s.day = 10; s.firedOnce['ask_m2_visit'] = true; });
    const line = dawnProblems(state, PACK).find((p) => p.key === 'thread_clerk');
    assert.ok(line && line.sev === 0, 'sev0 状态行经 dawnProblems 进晨报');
  });
});
