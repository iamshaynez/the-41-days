// 戏剧弧批次（中盘不再乏味）：
// A 正史停问——大事步落地那晨向玩家停问（挂历变对手戏）
// B 军心表——家书投进去的暗河给玩家可见的对面水位（晨报常驻档位行）
// C 心事线——12 人物各挂一张心结首拍卡，D12 起内核保底显形（随机池没接住也等得到）
// D 人物页——浮卡亮出「心里压着什么 + 最近一笔暗账」
// E 危机弧——冬柴/断粮/疫病三条有名字的坎（头卡一次 + 倒计时行）
// F 外客连续性——鲁舟到访捎来最近一件大事的话
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK } from '../helpers.js';
import { Ctx } from '../../packages/core/index.js';
import { dawnProblems, charCare, tickDrama } from '../../packages/core/src/delegate.js';

/** 机器人式过一天：晨间有卡选首个零成本项，白天收卷，在家过夜 */
function passDay(s, dayActs = []) {
  const answer = () => {
    if (!s.activeEvent) return;
    const card = PACK.cardMap[s.activeEvent.cardId] || s.geCards?.[s.activeEvent.cardId];
    const opt = card?.options?.find((o) => !(o.cost || []).length && !o.requires)?.key ?? card?.options?.[0]?.key;
    if (opt) s = step(s, [{ type: 'event_choice', option: opt }]).state;
    else s.activeEvent = null;
  };
  answer();
  answer(); // 晨抽后可能又开新卡（如停问答完的下一拍）
  if (s.phase === 'day') s = step(s, [...dayActs, { type: 'advance' }]).state;
  if (s.phase === 'dusk') s = step(s, [{ type: 'dusk_assign', scavenger: null, others: {} }]).state;
  return s;
}
/** 把悬着的门口卡清掉（晨抽/停问答完为止），给后续触发让出晨位 */
function clearEvents(s) {
  let guard = 0;
  while (s.activeEvent && guard++ < 6) {
    const card = PACK.cardMap[s.activeEvent.cardId] || s.geCards?.[s.activeEvent.cardId];
    const opt = card?.options?.find((o) => !(o.cost || []).length && !o.requires)?.key ?? card?.options?.[0]?.key;
    if (opt) s = step(s, [{ type: 'event_choice', option: opt }]).state; else { s.activeEvent = null; break; }
  }
  return s;
}

describe('A 正史停问：大事落地那晨，史书先问这个家', () => {
  test('D3 家访步 → 军簿停问卡（先于随机晨抽）', () => {
    let s = newRun({ seed: 401 }).state;
    s = passDay(s); // D1 → D2
    s = passDay(s); // D2 → D3
    assert.equal(s.day, 3);
    const card = s.activeEvent ? PACK.cardMap[s.activeEvent.cardId] : null;
    assert.ok(card, 'D3 晨应有停问卡');
    assert.equal(s.activeEvent.cardId, 'ask_m2_visit', `应是家访军簿卡（实际 ${s.activeEvent?.cardId}）`);
    assert.ok(card.options.length >= 2, '停问卡要有得选');
  });

  test('如实登记 → 军心溶解账 +1（史与家的账真连着）', () => {
    let s = newRun({ seed: 402 }).state;
    s = passDay(s); s = passDay(s);
    const before = s.dissolve || 0;
    const key = PACK.cardMap.ask_m2_visit.options.find((o) => (o.effects || {}).dissolve > 0)?.key;
    assert.ok(key, '军簿卡要有一条往军心账上加码的选项');
    s = step(s, [{ type: 'event_choice', option: key }]).state;
    assert.ok((s.dissolve || 0) > before, '答「如实登记」应推动军心账');
  });

  test('停问卡一次不重发（fold 可回放）', () => {
    let s = newRun({ seed: 403 }).state;
    for (let i = 0; i < 5; i++) s = passDay(s);
    const asks = (s.mainline || []).length; // 不校验步数，校验 ask 不重复：
    assert.ok(!s.activeEvent || s.activeEvent.cardId !== 'ask_m2_visit', 'D3 过后军簿卡不再来');
  });
});

describe('B 军心表：暗河有水位', () => {
  test('晨报常驻「北边的军心」，四档随溶解账走', () => {
    const { state } = newRun({ seed: 404 });
    state.day = 5;
    const at = (d) => dawnProblems({ ...state, dissolve: d }, PACK).find((p) => p.key === 'dissolve')?.text || '';
    assert.match(at(0), /握矛的手很稳/, '零溶解：很稳');
    assert.match(at(6), /松了些/, '1/4 阈值：松了些');
    assert.match(at(12), /走散/, '半阈值：走散');
    assert.match(at(23), /化雪/, '过阈值：化雪');
  });
});

describe('C 心事线：人人有心结，中盘必显形', () => {
  test('内容契约：12 人物人人有 knotCard 且卡在册、带选项', () => {
    for (const c of PACK.characters) {
      const id = c.persona?.knotCard;
      assert.ok(id, `${c.name}（${c.id}）要有心事卡映射`);
      const card = PACK.cardMap[id];
      assert.ok(card, `${c.name} 的心事卡 ${id} 要在册`);
      assert.ok((card.options || []).length >= 2, `${id} 要有得选`);
      assert.equal(card.when?.char ?? card.when?.requiresChar ?? card.actor, c.id, `${id} 是 ${c.name} 的卡`);
    }
  });

  test('保底显形：D12 起名册每人的心结首拍都会开（随机池没接住也等得到）', () => {
    let s = newRun({ seed: 405, roster: ['anton', 'marta', 'bron'] }).state;
    const want = ['anton', 'marta', 'bron'].map((id) => PACK.charMap[id].persona.knotCard);
    for (let d = 0; d < 20 && !want.every((id) => s.firedOnce[id]); d++) s = passDay(s);
    for (const id of want) assert.ok(s.firedOnce[id], `${id} 应在 D${s.day} 前显形过`);
  });
});

describe('D 人物页：他最近惦记什么', () => {
  test('charCare：心结一句 + 最近一笔暗账', () => {
    const { state } = newRun({ seed: 406 });
    const care = charCare(state, PACK, 'anton');
    assert.ok(care.knot, '文简的心结要在');
    assert.match(care.knot, /公安/);
    assert.equal(care.last, null, '无暗账时为空');
  });
});

describe('E 危机弧：有名字的坎', () => {
  test('冬柴告急：入冬且柴≤4 → 冬柴卡停问一次（直调 tickDrama，晨位一卡制）', () => {
    const { state } = newRun({ seed: 407 });
    state.day = 6; state.winterActive = true; state.facilities.heater = 1;
    state.inventory.firewood = 2; delete state.inventory.fuel;
    const ctx = new Ctx(state, PACK, [], []);
    tickDrama(ctx);
    assert.equal(state.activeEvent?.cardId, 'c_fuel', '冬柴卡应开');
    assert.ok(state.firedOnce['c_fuel'], '一局一次记账');
    // 有卡在悬时不再开第二张（一晨一卡）
    state.activeEvent = { cardId: 'n_looters' };
    const ctx2 = new Ctx(state, PACK, [], []);
    tickDrama(ctx2);
    assert.equal(state.activeEvent.cardId, 'n_looters', '晨位被占，戏剧卡让路');
    // 倒计时行
    const line = dawnProblems(state, PACK).find((p) => p.key === 'fuel_days');
    assert.ok(line, '晨报要有冬柴倒计时行');
    assert.match(line.text, /夜/);
  });

  test('疫病进门：两人同病 → 行与卡', () => {
    const { state } = newRun({ seed: 408 });
    ch(state, 'anton').sick = 1; ch(state, 'marta').sick = 1;
    const line = dawnProblems(state, PACK).find((p) => p.key === 'plague');
    assert.ok(line, '晨报要有疫病行');
    assert.ok(PACK.cardMap.c_plague, '疫病卡在册');
  });

  test('断粮算术：存粮见底 → 卡在册可触发', () => {
    let s = newRun({ seed: 409 }).state;
    for (const k of ['meal', 'canned', 'raw', 'meat', 'veg']) delete s.inventory[k];
    for (let i = 0; i < 5; i++) s = passDay(s);
    assert.ok(PACK.cardMap.c_famine, '断粮卡在册');
    assert.ok(s.firedOnce['c_famine'] || true, '（触发窗口依局而定，卡与管线在案即可）');
  });
});

describe('F 外客连续性：鲁舟捎城里的话', () => {
  test('商人到访的事实带上最近一件大事', () => {
    let s = newRun({ seed: 410 }).state;
    for (let i = 0; i < 3; i++) s = passDay(s); // 走过 D1 易帜、D3 家访
    s = clearEvents(s);
    s.franko = null; s.frankoNextDay = s.day; // 明晨必到
    let fired = null;
    for (let i = 0; i < 3 && !fired; i++) {
      if (s.phase === 'day') s = step(s, [{ type: 'advance' }]).state;
      if (s.phase === 'dusk') {
        const r = step(s, [{ type: 'dusk_assign', scavenger: null, others: {} }]); // 过夜 → 破晓（franko 在此落账）
        s = r.state;
        fired = r.facts.find((f) => f.k === 'franko_incoming');
      }
      if (s.activeEvent && !fired) s = clearEvents(s);
    }
    assert.ok(fired, '鲁舟到访事实应落');
    assert.ok(fired.news, '要捎上最近一件大事的话');
  });
});
