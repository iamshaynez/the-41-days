// 变奏系统（周目不重样）：「晨位」固定，「谁上晨位」每局由种子重抽。
// 槽位制（asks 池 + 种子选角）、线池（paper 60% 开、名册线随名册）、
// 触句变体（lines 池）、幕问变体（questions 池）——选角全是 hash(seed+slot)
// 纯函数，不存状态，fold 天然可回放。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK } from '../helpers.js';
import { Ctx, hashStr } from '../../packages/core/index.js';
import { tickThreads, threadsStateLines, threadsFrankoPick, rosterThreadsOf } from '../../packages/core/src/threads.js';
import { mainlineAskTick } from '../../packages/core/src/mainline.js';

describe('内容契约：池子与变体', () => {
  test('晨位各成池（≥2 变体），卡全在册；幕问各有 ≥2 问', () => {
    const steps = PACK.mainline.steps.filter((s) => s.ask || s.asks);
    assert.ok(steps.length >= 6, '至少六处晨位');
    for (const st of steps) {
      const pool = st.asks || [st.ask];
      assert.ok(pool.length >= 2, `${st.id} 池子要有变体（实际 ${pool.length}）`);
      for (const e of pool) {
        const id = typeof e === 'string' ? e : e.card;
        assert.ok(PACK.cardMap[id], `${st.id} 池里的 ${id} 在册`);
      }
    }
    for (const a of PACK.mainline.acts) {
      assert.ok((a.questions || []).length >= 2, `${a.id} 幕问要有变体`);
    }
  });
  test('纸线带开线概率；轻触带句池（lines）', () => {
    const paper = PACK.threads.threads.find((t) => t.id === 'paper');
    assert.ok(paper.active.chance, '纸线要有种子概率（不是局局开）');
    assert.ok(paper.touches.some((tc) => Array.isArray(tc.lines) && tc.lines.length >= 2), '轻触要有句池');
  });
});

describe('槽位选角：同晨位，不同周目不同卡', () => {
  test('扫 40 个种子：D3 晨位至少两种不同的卡；同种子必复现', () => {
    const seen = new Set();
    let first = null;
    for (let seed = 1; seed <= 40; seed++) {
      const { state } = newRun({ seed });
      state.day = 3; state.phase = 'day';
      const ctx = new Ctx(state, PACK, [], []);
      mainlineAskTick(ctx);
      const got = state.activeEvent?.cardId || null;
      assert.ok(got, `种子 ${seed}：D3 晨位应有卡`);
      seen.add(got);
      if (seed === 1) first = got;
    }
    assert.ok(seen.size >= 2, `40 个种子应至少两种局相（实际 ${[...seen].join(',')}）`);
    // 同种子确定性
    const { state: again } = newRun({ seed: 1 });
    again.day = 3; again.phase = 'day';
    const ctx2 = new Ctx(again, PACK, [], []);
    mainlineAskTick(ctx2);
    assert.equal(again.activeEvent?.cardId, first, '同种子同选角（fold 可回放的前提）');
  });

  test('带条件的变体：收册吏版过境卡只在持有木牍时可入选', () => {
    const st = PACK.mainline.steps.find((s) => s.id === 'm13_stragglers');
    const pool = st.asks || [st.ask];
    const gated = pool.find((e) => typeof e !== 'string' && e.needItem);
    assert.ok(gated, '过境池要有一条 needItem 门变体（吏版）');
    let clerkEligible = 0, plainEligible = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const { state } = newRun({ seed });
      state.day = 29; state.phase = 'day';
      state.inventory.clerk_tablet = 1; // 持牍
      const ctx = new Ctx(state, PACK, [], []);
      mainlineAskTick(ctx);
      if (state.activeEvent?.cardId === 'ask_m13_clerk') clerkEligible++;
      const { state: s2 } = newRun({ seed });
      s2.day = 29; s2.phase = 'day';
      delete s2.inventory.clerk_tablet; // 无牍：吏版不可选
      const ctx2 = new Ctx(s2, PACK, [], []);
      mainlineAskTick(ctx2);
      if (s2.activeEvent?.cardId === 'ask_m13_clerk') plainEligible++;
    }
    assert.equal(plainEligible, 0, '无木牍时吏版绝不入选');
    assert.ok(clerkEligible > 0, `持牍时吏版可入选（30 种子里 ${clerkEligible} 次）`);
  });
});

describe('线池：开线概率与名册线', () => {
  test('纸线按种子开（40 种子里 30%~90%）', () => {
    let open = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { state } = newRun({ seed });
      state.day = 10;
      const lines = threadsStateLines(state, PACK).map((l) => l.key);
      if (lines.includes('thread_paper')) open++;
    }
    assert.ok(open >= 12 && open <= 36, `40 种子开线 ${open} 次，应落在 30%~90%`);
  });

  test('名册线：随名册而来——鲁舟会提在册者的心事，缺席者不提', () => {
    const { state } = newRun({ seed: 61, roster: ['yura', 'zofia', 'grigory'] });
    const days = rosterThreadsOf(state, PACK).map((t) => t.touches[0].from);
    let line = null;
    for (const d of days) {
      const { state: sd } = newRun({ seed: 61, roster: ['yura', 'zofia', 'grigory'] });
      sd.day = d;
      const ctx = new Ctx(sd, PACK, [], []);
      const got = threadsFrankoPick(ctx);
      if (got) { line = got; break; }
    }
    assert.ok(line, '捎话轨要能提名册里的人的心事');
    const names = state.chars.filter((c) => c.alive).map((c) => c.name);
    assert.ok(names.some((n) => line.includes(n)), `捎话要点名在册者（${line}）`);
    const absent = ['文简', '白简', '薄姑'];
    assert.ok(!absent.some((n) => line.includes(n)), '缺席者不被提');
  });
});

describe('触句变体与幕问变体：同线不同相', () => {
  test('纸线同一触点，不同种子出不同句', () => {
    const lines = new Set();
    for (let seed = 1; seed <= 30; seed++) {
      const { state } = newRun({ seed });
      state.day = 8; state.phase = 'day';
      const ctx = new Ctx(state, PACK, [], []);
      tickThreads(ctx); // 走晨轨不需要；直接验 token 日不触——改验 franko 轨
      const s2state = newRun({ seed }).state;
      s2state.day = 8;
      s2state.franko = { merchant: 'franko', stock: [] };
      const ctx2 = new Ctx(s2state, PACK, [], []);
      const line = threadsFrankoPick(ctx2);
      if (line) lines.add(line);
    }
    assert.ok(lines.size >= 2, `同一触点 30 种子应至少两种句（实际 ${lines.size}）`);
  });

  test('幕问按种子选：不同种子不同问', () => {
    const qs = new Set();
    for (let seed = 1; seed <= 30; seed++) {
      const { state } = newRun({ seed });
      state.day = 9; state.phase = 'day';
      const ctx = new Ctx(state, PACK, [], []);
      tickThreads(ctx);
      const q = ctx.facts.find((f) => f.k === 'act_question' && f.act === 'A2');
      if (q) qs.add(q.q);
    }
    assert.ok(qs.size >= 2, `A2 幕问 30 种子应至少两问（实际 ${qs.size}）`);
  });
});
