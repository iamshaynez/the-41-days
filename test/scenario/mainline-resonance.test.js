// 史实共振（内容包 0.34.0）：主线步不再只写字——落步即起涟漪（心情/物价/袭击），
// 日常事件卡能感知主线（afterStep/beforeStep 门控），闲笔伏笔在锚落之日兑现回响，
// 史卷每天有只有它有的信息（军心刻度、幕结行）。玩家与正史同呼吸。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, PACK } from '../helpers.js';
import { createRun, beginRun, buildChronicle, stepGateOk, priceMulOf, raidAddOf, fold } from '../../packages/core/index.js';

const stepById = (id) => PACK.mainline.steps.find((s) => s.id === id);

describe('涟漪 · 步落旗标与涟漪入账', () => {
  test('锚步落地那晨，全城都能读到：eventFlags 记下 ml_<stepId> = 落步日', () => {
    const { state } = newRun({ seed: 51 }); // D1 无序章开局即落 m1_flag
    assert.equal(state.eventFlags.ml_m1_flag, 1, 'D1 易帜应立旗 ml_m1_flag=1');
  });

  test('带 ripples.moodAll 的步落下，全家心情同起同落', () => {
    const want = stepById('m1_flag').ripples?.moodAll;
    assert.ok(Number.isInteger(want), 'm1_flag 应带 moodAll 涟漪（内容契约）');
    const state = createRun(PACK, { seed: 51, roster: ['anton', 'marta', 'bron'] });
    const before = state.chars.map((c) => c.moodPts);
    beginRun(state, PACK, {}); // D1 落 m1_flag，moodAll 即时起波
    assert.deepEqual(state.chars.map((c) => c.moodPts), before.map((v) => v + want), `开局心情应整体位移 ${want}`);
  });

  test('物价与袭击涟漪入账 s.ripples，纯函数读数、到期自然失效', () => {
    const { state } = newRun({ seed: 51 });
    assert.ok(state.ripples && state.ripples.m1_flag, 'm1 落步应入 ripples 账');
    assert.equal(typeof priceMulOf(state, 'any'), 'number');
    assert.equal(raidAddOf(state) >= 0, true);
    // 到期失效：把时钟拨过涟漪寿命
    state.ripples.m1_flag.until = state.day - 1;
    assert.equal(priceMulOf(state, 'x'), 1, '过期涟漪不再影响物价');
    assert.equal(raidAddOf(state), 0, '过期涟漪不再影响袭击');
  });

  test('涟漪账走 FLAG 镜像，fold 回放不丢', () => {
    const { state, events } = newRun({ seed: 51 });
    const s2 = fold(events);
    assert.deepEqual(s2.ripples, state.ripples, 'fold 重建的涟漪账应与原局一致');
    assert.equal(s2.eventFlags.ml_m1_flag, 1);
  });
});

describe('涟漪 · 内容契约（21 步的分配密度）', () => {
  test('至少十四步带涟漪——正史每天都要在这个家留下指纹', () => {
    const withR = PACK.mainline.steps.filter((s) => s.ripples);
    assert.ok(withR.length >= 14, `带涟漪的步只有 ${withR.length}`);
    for (const st of withR) {
      const r = st.ripples;
      const has = r.moodAll !== undefined || r.priceMul || r.raidAdd !== undefined;
      assert.ok(has, `步 ${st.id} 的 ripples 是空的`);
      if (r.priceMul) for (const [it, f] of Object.entries(r.priceMul)) {
        assert.ok(PACK.itemMap[it], `步 ${st.id} 涟漪物价引用了不存在的物品 ${it}`);
        assert.ok(f >= 0.7 && f <= 1.5, `步 ${st.id} 对 ${it} 的物价倍率 ${f} 越界（0.7~1.5）`);
      }
      if (r.raidAdd !== undefined) assert.ok(Math.abs(r.raidAdd) <= 0.06, `步 ${st.id} 袭击涟漪 ${r.raidAdd} 幅度过大`);
    }
  });
});

describe('门控 · 事件卡感知主线（afterStep/beforeStep）', () => {
  test('afterStep：旗立之后 N 日内放行，窗外拒之', () => {
    const s = { day: 4, eventFlags: { ml_m1_flag: 1 } };
    assert.equal(stepGateOk(s, PACK, { afterStep: { id: 'm1_flag', withinDays: 3 } }), true, 'D4 距落步 3 日，在窗内');
    s.day = 5;
    assert.equal(stepGateOk(s, PACK, { afterStep: { id: 'm1_flag', withinDays: 3 } }), false, 'D4 距落步 4 日，出窗');
    assert.equal(stepGateOk(s, PACK, { afterStep: { id: 'm4_yujin', withinDays: 3 } }), false, '旗未立不放行');
  });

  test('beforeStep：锚落之前的期待窗——近了才放行，落了即关', () => {
    const s = { day: 8, eventFlags: {} };
    assert.equal(stepGateOk(s, PACK, { beforeStep: { id: 'm5_cannon', withinDays: 3 } }), true, 'D8 距 D10 还有 2 日，窗内');
    s.day = 6;
    assert.equal(stepGateOk(s, PACK, { beforeStep: { id: 'm5_cannon', withinDays: 3 } }), false, 'D6 距 D10 还有 4 日，窗外');
    s.day = 10; s.eventFlags.ml_m5_cannon = 10;
    assert.equal(stepGateOk(s, PACK, { beforeStep: { id: 'm5_cannon', withinDays: 3 } }), false, '锚已落地，期待窗关闭');
  });

  test('余波卡内容契约：afterStep/beforeStep 引用的步都在册', () => {
    const afters = PACK.cards.filter((c) => c.when?.afterStep || c.when?.beforeStep);
    assert.ok(afters.length >= 5, `余波卡只有 ${afters.length} 张——A1/A5 批次至少 5 张`);
    for (const c of afters) {
      const g = c.when.afterStep || c.when.beforeStep;
      assert.ok(stepById(g.id), `卡 ${c.id} 引用了不存在的锚步 ${g.id}`);
      assert.ok(g.withinDays >= 1 && g.withinDays <= 6, `卡 ${c.id} 的窗口 ${g.withinDays} 越界（1~6）`);
    }
  });
});

describe('伏笔回响 · 闲笔在锚落之日兑现', () => {
  test('figure.payoff 链接成链：指向的步存在，且闲笔出现得比锚早', () => {
    const linked = (PACK.historia?.figures || []).filter((f) => f.payoff);
    assert.ok(linked.length >= 8, `挂了 payoff 的闲笔人物只有 ${linked.length}`);
    for (const f of linked) {
      const st = stepById(f.payoff);
      assert.ok(st, `闲笔 ${f.id} 的 payoff 指向不存在的步 ${f.payoff}`);
      assert.ok((f.minDay || 1) <= (st.day ?? st.dayWindow?.[1] ?? 99), `闲笔 ${f.id}（minDay ${f.minDay}）不可能早于锚 ${st.id}（D${st.day}）出现——链断了`);
      assert.ok(f.payoffLine, `闲笔 ${f.id} 缺 payoffLine（兑现日的回响文案）`);
    }
  });

  test('史卷条目带出回响行：读过他磨墨的人，在锚落之日认出这一笔', () => {
    const { state } = newRun({ seed: 51 });
    state.day = 10;
    state.mainline = [
      { day: 7, stepId: null, pens: ['manchong'], mirrors: [] }, // D7 读过满宠沉白马
      { day: 10, stepId: 'm5_cannon', pens: [], mirrors: [] }
    ];
    state.mainlinePens = ['manchong'];
    const ch = buildChronicle(state, PACK);
    const e = ch.entries.find((x) => x.day === 10);
    assert.ok(e.payoffs?.length, 'm5 条目应带满宠的回响');
    assert.ok(/满宠/.test(e.payoffs[0].line), '回响行要指名道姓');
  });
});

describe('军心刻度 · 史卷每天有只有它有的信息', () => {
  test('卷首军心：dissolve 档位词进史卷视图，别传局不刻', () => {
    const { state } = newRun({ seed: 51 });
    let ch = buildChronicle(state, PACK);
    assert.ok(ch.morale && ch.morale.tier, '史卷应带军心刻度');
    assert.equal(ch.morale.tier, '握矛的手很稳', '开局军心应是最高档');
    state.dissolve = 22;
    ch = buildChronicle(state, PACK);
    assert.equal(ch.morale.tier, '大军像化雪，一夜瘦一圈');
    state.sidestory = { id: 'x' };
    ch = buildChronicle(state, PACK);
    assert.equal(ch.morale, null, '别传局无军心可刻');
  });
});

describe('幕结行 · 一幕收束时，城事与家事对表', () => {
  test('过幕之后史卷长出幕结行：这一幕城里的大事 × 这个家做过的事', () => {
    const { state } = newRun({ seed: 51 });
    state.day = 9; // A1（D1-8）已收
    state.mainline = [
      { day: 1, stepId: 'm1_flag', pens: [], mirrors: [] },
      { day: 3, stepId: 'm2_visit', pens: [], mirrors: [] }
    ];
    state.causality.entries.push({ day: 4, verb: 'help', target: 'widow', weight: 2, actor: 'player' });
    const ch = buildChronicle(state, PACK);
    const wrap = (ch.actWraps || []).find((w) => w.act === 'A1');
    assert.ok(wrap, 'A1 幕结行应在卷');
    assert.ok(/易帜/.test(wrap.city), '幕结的城事要列本幕锚步');
    assert.ok(/帮过人/.test(wrap.you), '幕结的家事要点出最重的一笔');
  });

  test('没做任何事的幕，家事写「日子照常过」——账不粉饰', () => {
    const { state } = newRun({ seed: 51 });
    state.day = 9;
    state.mainline = [{ day: 1, stepId: 'm1_flag', pens: [], mirrors: [] }];
    const ch = buildChronicle(state, PACK);
    const wrap = ch.actWraps.find((w) => w.act === 'A1');
    assert.equal(wrap.you, '日子照常过');
  });
});

describe('史注升格 · 引文可展卷（文白对照）', () => {
  test('带史注的步配白话 gloss——玩家读得懂《三国志》', () => {
    const cited = PACK.mainline.steps.filter((s) => s.cite);
    const glossed = cited.filter((s) => s.cite.gloss && s.cite.gloss.length >= 6);
    assert.ok(glossed.length >= cited.length - 2, `${glossed.length}/${cited.length} 条史注配了白话——至多两条可缺`);
  });
});
