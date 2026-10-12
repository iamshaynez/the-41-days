// 因果引擎单元测试（因果引擎-v0.1：CY-01~CY-43）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK, skipDayAtHome } from '../helpers.js';
import { fold } from '../../packages/core/index.js';
import { denyFoodCount, slumberGuard, charArc } from '../../packages/core/src/causality.js';

const entries = (s, verb) => s.causality.entries.filter((e) => e.verb === verb);

describe('因果条目（CY-01~CY-06）', () => {
  test('进食记 feed，饥饿且有粮记 deny_food（选择而非命运）', () => {
    const { state } = newRun({ seed: 5 });
    let s = state;
    s.inventory.canned = 3;
    s = step(s, [{ type: 'act', actor: 'anton', action: 'eat', target: 'canned' }]).state;
    assert.equal(entries(s, 'feed').length, 1);
    assert.equal(entries(s, 'feed')[0].target, 'anton');
    s = skipDayAtHome(s);
    s = skipDayAtHome(s);
    const denies = entries(s, 'deny_food');
    assert.ok(denies.length >= 1, '应有 deny_food 记录');
    assert.ok(denyFoodCount(s, denies[0].target, 5) >= 1);
  });

  test('烧简：文简读数是别人三倍（persona.sensitive），且触发抗议（P-03）', () => {
    const { state } = newRun({ seed: 7 });
    let s = state;
    s.facilities.stove = 1;
    s.inventory.raw = 1; s.inventory.book = 1;
    delete s.inventory.firewood; delete s.inventory.wood;
    const r = step(s, [{ type: 'act', actor: 'bron', action: 'cook' }]);
    s = r.state;
    assert.equal(entries(s, 'burn_book').length, 1);
    const protest = r.facts.find((f) => f.k === 'protest' && f.char === 'anton');
    assert.ok(protest, '文简必须抗议');
    assert.match(protest.line, /写过字的时间/);
    const anton = charArc(s, 'anton');
    const bron = charArc(s, 'bron');
    assert.ok(anton.neg > bron.neg * 2, `文简应远比旁人刺痛（${anton.neg} vs ${bron.neg}）`);
  });

  test('医治构筑角色间信任弧（heal → pairArc marta|anton）', () => {
    const { state } = newRun({ seed: 9 });
    let s = state;
    ch(s, 'anton').wound = 2;
    s.inventory.bandage = 1;
    s = step(s, [{ type: 'act', actor: 'marta', action: 'treat', target: 'bandage', patient: 'anton' }]).state;
    const arc = s.causality.pairArcs['marta|anton'];
    assert.ok(arc && arc.pos > 0, '文简对辛夷应有信任入账');
  });

  test('击杀平民：账记玩家，见证者只有执行者本人（CY-06）', () => {
    const { state } = newRun({ seed: 11 });
    let s = state;
    s = step(s, [{ type: 'advance' }]).state;
    s.inventory.knife = 1;
    s = step(s, [{ type: 'dusk_assign', scavenger: 'bron', location: 'church', gear: ['knife'], others: {} }]).state;
    if (s.activeEvent) s = step(s, [{ type: 'event_choice', option: 'thanks' }]).state;
    s = step(s, [{ type: 'night', action: 'backstab', target: 'priest' }]).state;
    const kills = entries(s, 'kill_civ');
    assert.equal(kills.length, 1);
    assert.equal(kills[0].actor, 'player', '账记玩家头上');
    assert.equal(kills[0].via, 'bron', '执行者留名');
    assert.deepEqual(kills[0].witnesses, ['bron'], '夜里的事只有夜里的人知道');
    assert.ok(charArc(s, 'bron').neg > 0, '布罗对玩家的敬重受损');
    assert.equal(charArc(s, 'anton').neg, 0, '文简不在场，读数为零');
  });
});

describe('自主行为（CY-23）', () => {
  test('玛尔塔：你拒绝求助的第二天，她眼下多一层青黑', () => {
    const { state } = newRun({ seed: 13 });
    let s = state;
    s.activeEvent = { cardId: 'n_meds' };
    s = step(s, [{ type: 'event_choice', option: 'refuse' }]).state;
    assert.equal(entries(s, 'refuse_help').length, 1);
    const before = ch(s, 'marta').fatigue;
    s = skipDayAtHome(s);
    assert.equal(ch(s, 'marta').fatigue, before + 1, '玛尔塔夜里自己起来了');
  });

  test('文简：烧简累计过线 → 生日账划名（永久标记）', () => {
    const { state } = newRun({ seed: 14 });
    let s = state;
    s.facilities.stove = 1;
    for (let i = 0; i < 2 && !ch(s, 'anton').antonStruck; i++) {
      s.inventory.raw = (s.inventory.raw || 0) + 1;
      s.inventory.book = (s.inventory.book || 0) + 1;
      delete s.inventory.firewood; delete s.inventory.wood;
      s.facilities.stoveFireLeft = 0; // 余火免柴——清零才烧书
      ch(s, 'bron').ap = 3;
      s = step(s, [{ type: 'act', actor: 'bron', action: 'cook' }]).state;
      s = skipDayAtHome(s);
    }
    assert.ok(ch(s, 'anton').antonStruck, '两册书之后，文简把你划掉了');
  });

  test('薄姑：卖文档给鲁舟 → 私人簿记入账', () => {
    const { state } = newRun({ seed: 15, roster: ['vera', 'marta', 'bron'] });
    let s = state;
    s.inventory.doc = 1;
    s.franko = { merchant: 'franko', stock: [{ item: 'canned', n: 5, buy: 7 }] };
    s = step(s, [{ type: 'trade_op', give: { doc: 1 }, get: { canned: 1 } }]).state;
    assert.equal(entries(s, 'trade_evidence').length, 1, '卖纸即卖坐标');
    s = skipDayAtHome(s);
    const arc = charArc(s, 'vera');
    assert.ok((arc.privateLedger || []).length >= 1, '薄姑的私人簿记记下了这笔');
  });
});

describe('危机兑现（CY-32）', () => {
  test('睡岗判定：饿到极点且被长期克扣的守卫会"没听见"', () => {
    const { state } = newRun({ seed: 17 });
    const s = state;
    const bron = ch(s, 'bron');
    bron.hunger = 1;
    for (let d = 1; d <= 3; d++) {
      s.causality.entries.push({ i: s.causality.entries.length, day: s.day - d, verb: 'deny_food', actor: 'player', target: 'bron', witnesses: ['anton'], weight: 1, tags: [], note: null });
    }
    const ctx = { s, rng: { chance: () => true } };
    const g = slumberGuard(ctx, [bron, ch(s, 'anton')]);
    assert.equal(g?.id, 'bron', '石大会睡着，吃饱的文简不会');
  });

  test('安抚系数：信任弧越高，崩溃链安抚越强', () => {
    const { state } = newRun({ seed: 18 });
    let s = state;
    const anton = ch(s, 'anton');
    anton.moodPts = -15; anton.breakdown = { stage: 1 }; anton.soothed = 0;
    s.causality.pairArcs['marta|anton'] = { pos: 20, neg: 0 }; // 托付档
    s = step(s, [{ type: 'act', actor: 'marta', action: 'talk', target: 'anton' }]).state;
    assert.ok(ch(s, 'anton').soothed >= 3, `过命的人一句话顶陌生人几句（soothed=${ch(s, 'anton').soothed}）`);
  });
});

describe('fold 镜像（事件溯源守恒）', () => {
  test('含 CAUSAL 事件的对局可完整重放', () => {
    const { state, events } = newRun({ seed: 19 });
    let s = state;
    const all = [...events];
    const doStep = (intents) => { const r = step(s, intents); all.push(...r.events); s = r.state; return r; };
    s.facilities.stove = 1;
    s.inventory.raw = 2; s.inventory.book = 2;
    delete s.inventory.firewood; delete s.inventory.wood;
    doStep([{ type: 'act', actor: 'bron', action: 'cook' }]);
    doStep([{ type: 'advance' }]);
    doStep([{ type: 'dusk_assign', scavenger: null, others: {} }]);
    const rebuilt = fold(all);
    assert.deepEqual(rebuilt.causality, s.causality, 'fold 后因果账完全一致');
  });
});
