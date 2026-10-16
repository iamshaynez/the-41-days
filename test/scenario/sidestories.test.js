// 别传场景测试（长线体验-v0.2 §3.4 CH-04/05 重构版）：
// 每日有卡（晨拍+暮拍）、选择咬合、结局如实（旗标/计数/生死/全灭）、别传专属场
// （地点白名单、船牙不来、家底从零）、池隔离、或然静默。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK, skipDayAtHome } from '../helpers.js';
import { eventOptionsView, pickSideEnding, buildEnding } from '../../packages/core/index.js';

/** 答掉当前所有待决卡：默认选第一个可行项，prefer[cardId] 指定键 */
function answerEvents(s, prefer = {}) {
  let guard = 0;
  while (s.activeEvent && guard++ < 6) {
    const card = PACK.cardMap[s.activeEvent.cardId];
    const view = eventOptionsView(s, PACK, card);
    const okOnes = view.filter((v) => v.ok);
    const want = prefer[card.id];
    const choice = want && okOnes.some((v) => v.key === want) ? want : (okOnes[0]?.key || view[0]?.key);
    const r = step(s, [{ type: 'event_choice', option: choice }]);
    if (!r.state || s === r.state) break;
    s = r.state;
  }
  return s;
}

/** 别传的一天：晨卡 → 收卷（暮卡在 toDusk 内发）→ 暮卡 → 在家过夜 */
function playSideDay(s, prefer = {}) {
  s = answerEvents(s, prefer);
  if (s.over) return s;
  s = step(s, [{ type: 'advance' }]).state;
  s = answerEvents(s, prefer);
  if (s.phase === 'dusk') s = step(s, [{ type: 'dusk_assign', scavenger: null, others: {} }]).state;
  return s;
}

/** 跑完一局别传（家底塞饱防饿死干扰断言），返回终局状态 */
function playSide(sidestory, prefer = {}, days) {
  let s = newRun({ seed: 77, sidestory }).state;
  const n = days ?? (PACK.sideMap[sidestory].days + 1);
  for (const c of s.chars) { c.hunger = 4; }
  s.inventory.canned = 30; s.inventory.raw = 30; s.inventory.water = 20;
  for (let i = 0; i < n + 2 && !s.over; i++) s = playSideDay(s, prefer);
  return s;
}

describe('别传开局：场是自己的（家底/地点/船牙）', () => {
  test('固定阵容、天数计时器、家底从零（不带江陵的撬棍）、只认自家地点、自带设施', () => {
    const s = newRun({ seed: 90, sidestory: 'luzhou' }).state;
    assert.equal(s.sidestory?.id, 'luzhou');
    assert.deepEqual(s.chars.map((c) => c.id), ['luzhou', 'alu'], '鲁舟和阿橹，一船两人');
    assert.equal(s.war.endDay, 6, '五天水程，第六天破晓收束');
    assert.equal(s.inventory.jewel, 1, '舱底有货');
    assert.equal(s.inventory.crowbar, undefined, '船上没有江陵的撬棍——家底从零起');
    assert.equal(s.inventory.book, undefined, '也没有橘里的简册');
    assert.deepEqual(s.knownLocs, ['lz_ferry', 'lz_manor', 'lz_reeds'], '只认自家地点，江陵的门不开');
    assert.ok(PACK.locMap.lz_ferry.side === 'luzhou' && PACK.locMap.lz_ferry.name === '津戍浮桥');
    assert.equal(s.facilities.stove, 1, '船尾有灶');
    assert.equal(s.house.opened.lz_cabin, true, '住的是自家屋（船舱），不是橘里九号');
  });

  test('船牙不来：鲁舟的船上不会有第二个鲁舟', () => {
    let s = newRun({ seed: 91, sidestory: 'luzhou' }).state;
    s.inventory.canned = 20; s.inventory.raw = 20;
    for (let i = 0; i < 6 && !s.over; i++) s = skipDayAtHome(s);
    assert.ok(!s.franko, '别传全程商人不上门');
    assert.equal(s.frankoNextDay, 9999, '排期钉死');
  });

  test('地点解锁扫描不把江陵漏进来：樊城役夫第二天不会「知道」南市', () => {
    let s = newRun({ seed: 92, sidestory: 'fancheng' }).state;
    s.inventory.canned = 40; s.inventory.raw = 40;
    s = skipDayAtHome(s);
    for (const id of s.knownLocs) {
      const loc = PACK.locMap[id];
      assert.ok(loc?.side === 'fancheng', `已知地点 ${id} 必须是樊城自家的`);
    }
    assert.ok(!s.knownLocs.includes('market') && !s.knownLocs.includes('post'));
  });
});

describe('日更双拍：晨决断 + 暮余波', () => {
  test('鲁舟全链：泊位选择改写第二日的题，收纸改写结局，阿橹的问题接尾句', () => {
    let s = newRun({ seed: 93, sidestory: 'luzhou' }).state;
    s.inventory.canned = 20; s.inventory.raw = 20;
    // D1 装船（卖军需曹）→ 暮：泊浮桥
    s = playSideDay(s, { lz_d1: 'army', lz_d1_dusk: 'ferry' });
    assert.ok(s.eventFlags.lz_moor_ferry, '暮卡发过');
    // D2 应为「津戍开箱」变体（他看过你的水线）
    assert.equal(s.activeEvent?.cardId, 'lz_d2a', '泊浮桥 → 第二日开箱变体');
    s = playSideDay(s, { lz_d2a: 'pass' });
    // D3 收纸：照单收 → 暮：阿橹的问题，照实说
    assert.equal(s.activeEvent?.cardId, 'lz_d3');
    s = playSideDay(s, { lz_d3: 'take', lz_d3_dusk: 'truth' });
    // D4 未拒单 → 江上的影子
    assert.equal(s.activeEvent?.cardId, 'lz_d4b', '没拒单就没有查船——是影子船');
    s = playSideDay(s, { lz_d4b: 'hide' });
    // D5 回程 → D6 收束
    s = playSideDay(s, {});
    s = playSideDay(s, {});
    assert.ok(s.over, '到点收束');
    assert.equal(s.ending.type, 'sidestory');
    assert.match(s.ending.title, /鲁舟的一趟船 · 点头/, '变体标题上屏（不再是 undefined）');
    assert.match(s.ending.storyline.annals[0].text, /券局的人点了头/);
    assert.match(s.ending.storyline.annals[0].text, /阿橹后来接了你的船/, '尾句（照实说过）拼在变体后');
    assert.doesNotMatch(s.ending.title, /undefined/);
  });

  test('泊芦苇荡则第二日是寻常津戍（他没见过你的水线）', () => {
    let s = newRun({ seed: 94, sidestory: 'luzhou' }).state;
    s.inventory.canned = 20; s.inventory.raw = 20;
    s = playSideDay(s, { lz_d1: 'market', lz_d1_dusk: 'reeds' });
    assert.equal(s.activeEvent?.cardId, 'lz_d2b');
  });

  test('晨卡拖到黄昏才答：暮卡补发，不因拖延而丢', () => {
    let s = newRun({ seed: 95, sidestory: 'luzhou' }).state;
    s.inventory.canned = 20; s.inventory.raw = 20;
    // 白天不答晨卡，直接收卷
    s = step(s, [{ type: 'advance' }]).state;
    assert.equal(s.phase, 'dusk');
    assert.equal(s.activeEvent?.cardId, 'lz_d1', '晨卡还在门口');
    assert.equal(s.duskDrawnDay, undefined, '晨卡占位：直发没发生，账不动——答完才许补发');
    const r = step(s, [{ type: 'dusk_assign', scavenger: null, others: {} }]);
    assert.equal(r.rejects?.[0]?.reason, 'EVENT_PENDING', '别传：眼前的卡先答再出门');
    s = step(s, [{ type: 'event_choice', option: 'army' }]).state;
    assert.equal(s.activeEvent?.cardId, 'lz_d1_dusk', '答完晨卡，当日暮卡补发');
    assert.equal(s.duskDrawnDay, 1, '补发记账，同日不再发第二张');
  });

  test('素伯：拒卖之后第三夜是「查台」而不是替别人顶罪', () => {
    let s = newRun({ seed: 96, sidestory: 'subo' }).state;
    s.inventory.canned = 20; s.inventory.raw = 20;
    s = playSideDay(s, { sb_d1: 'refuse', sb_d1_dusk: 'deflect' });
    s = playSideDay(s, { sb_d2: 'keep' });
    assert.equal(s.activeEvent?.cardId, 'sb_d3c', '拒卖分支：军正查台，鼓谱成题');
    s = playSideDay(s, { sb_d3c: 'hide' });
    assert.ok(s.over);
    // riskCheck 有两枝：过关是「真正的巡哨」族，败是「没了」族——两者必居其一
    assert.ok(s.eventFlags.sb_score_safe || s.eventFlags.sb_score_lost);
    assert.match(s.ending.storyline.annals[0].text, /谱/);
  });

  test('陈六不在了：他的路就没了（option requires.char）', () => {
    const s = newRun({ seed: 97, sidestory: 'subo' }).state;
    ch(s, 'chenliu').alive = false;
    const card = PACK.cardMap.sb_d2;
    const view = eventOptionsView(s, PACK, card);
    const teach = view.find((v) => v.key === 'teach');
    assert.equal(teach.ok, false, '教给陈六——陈六得活着');
    assert.match(teach.why, /陈六不在了/);
  });
});

describe('结局如实：旗标/计数/生死/全灭', () => {
  test('杜仲：弯三次写「弯」，弯一两次写「弯过」，一次没弯才是「规矩没有弯过」', () => {
    const mk = (bents) => {
      const s = newRun({ seed: 98, sidestory: 'duzhong' }).state;
      for (const f of bents) s.eventFlags[f] = true;
      return pickSideEnding(PACK.sideMap.duzhong, s);
    };
    assert.match(mk(['dz_bent_1', 'dz_bent_2', 'dz_bent_3']).title, /弯$/);
    assert.match(mk(['dz_bent_2']).title, /弯过/);
    assert.equal(mk([]), null, '零弯走默认（封棚）或分棚变体');
  });

  test('杜仲：弯过还全弯不了「没有弯过」——旧版 16 路径 15 错的坑封死', () => {
    const s = newRun({ seed: 99, sidestory: 'duzhong' }).state;
    s.eventFlags.dz_fair_1 = true; s.eventFlags.dz_bent_2 = true; s.eventFlags.dz_bent_3 = true;
    const v = pickSideEnding(PACK.sideMap.duzhong, s);
    assert.ok(v && v.title !== '封棚' && !/没有弯过/.test(v.text), '弯了两次的局不许领「没有弯过」');
  });

  test('廖母死在半路：结局是「差一天」，不再「在你背上睡着了」', () => {
    const s = newRun({ seed: 100, sidestory: 'liaohua' }).state;
    ch(s, 'laomu').alive = false;
    const v = pickSideEnding(PACK.sideMap.liaohua, s);
    assert.match(v.title, /差一天/);
    assert.match(v.text, /坟头朝东/);
  });

  test('全灭写全灭的页：樊城三人都没了，是「板不数人」', () => {
    const s = newRun({ seed: 101, sidestory: 'fancheng' }).state;
    for (const c of s.chars) c.alive = false;
    const v = pickSideEnding(PACK.sideMap.fancheng, s);
    assert.match(v.title, /板不数人/);
  });

  test('落款用自己的话：别传死人不上橘里的墙', () => {
    const s = newRun({ seed: 102, sidestory: 'liaohua' }).state;
    ch(s, 'laomu').alive = false; s.deathDays = { laomu: 7 };
    s.eventFlags.lh_listened = true;
    s.over = true; s.war.ended = true;
    const ending = buildEnding(s, PACK);
    const laomu = ending.chars.find((c) => c.id === 'laomu');
    assert.match(laomu.fate, /留在了路上/);
    assert.doesNotMatch(laomu.fate, /橘里/);
    const alive = ending.chars.find((c) => c.id === 'liaohua');
    assert.match(alive.fate, /他自己记得/);
  });

  test('尾句按旗标拼装：教过陈六，那半口气就有人接', () => {
    const s = playSide('subo', { sb_d1: 'sold', sb_d1_dusk: 'tell', sb_d2: 'teach', sb_d3a: 'bear' }, 4);
    assert.ok(s.over);
    assert.match(s.ending.storyline.annals[0].text, /陈六接过了那半口气/);
    assert.match(s.ending.title, /阵殁/);
  });
});

describe('别传与主线的边界', () => {
  test('池隔离：主线卡不进别传，别传卡不进主线', () => {
    const sideTimeline = PACK.cards.filter((c) => c.kind === 'timeline' && c.side === 'subo');
    const mainTimeline = PACK.cards.filter((c) => c.kind === 'timeline' && !c.side);
    assert.ok(sideTimeline.length >= 3 && sideTimeline.every((c) => c.id.startsWith('sb_')), '素伯线晨卡');
    assert.ok(mainTimeline.every((c) => !c.id.startsWith('sb_')), '主线时间轴无别传卡');
    const main = newRun({ seed: 103, roster: ['anton', 'marta', 'bron'] }).state;
    assert.ok(!main.sidestory);
    assert.ok(!main.activeEvent || !PACK.cardMap[main.activeEvent.cardId]?.side, '主线首晨无别传卡');
  });

  test('别传不发交割前兆、不注入主线或然（守卫不回退）', () => {
    let s = newRun({ seed: 104, sidestory: 'fancheng' }).state;
    s.inventory.canned = 40; s.inventory.raw = 40;
    s.docsSeen = ['#058', '#063']; s.reputation.church = 1; s.eventFlags.fire_witness = true;
    for (let i = 0; i < 13 && !s.over; i++) s = playSideDay(s, { fc_d8: 'hand', fc_d10: 'carve' });
    assert.ok(s.over, '数板十天收束');
    assert.equal(s.ending.type, 'sidestory');
    assert.ok(!s.eventFlags.war_telegraphed, '无交割前兆');
    assert.ok(s.activeEvent?.cardId !== 'alt_jiangling', '别传局不注入主线或然');
    assert.match(s.ending.storyline.annals[0].text, /水退了一寸/);
  });

  test('历史别传每天有戏：廖化十天里至少十张卡上门', () => {
    const s = playSide('liaohua', { lh_d1: 'grave', lh_d3: 'rest' });
    assert.ok(s.over);
    const fired = Object.keys(s.firedOnce).filter((id) => id.startsWith('lh_'));
    assert.ok(fired.length >= 10, `十天至少十拍（实测 ${fired.length}）`);
    assert.match(s.ending.storyline.annals[0].text, /母亲在你背上睡着了|化儿|往西/);
  });

  test('长坂：intro 埋的鞋有人接——认鞋走「针脚」，拆琴走「琴板」', () => {
    const shoe = playSide('changban', { cb_d4: 'shoe', cb_d5: 'bury' });
    assert.match(shoe.ending.title, /针脚/);
    const qin = playSide('changban', { cb_d4: 'take', cb_d5: 'bury' });
    assert.match(qin.ending.title, /琴板/);
  });
});
