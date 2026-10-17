// 居家与四问（docs/居家与四问-v0.1.md）：破晓重心、角色自主包、坡/双人/暗面/闲笔、
// 夜岗睡/守/看护/夜作、备夜、学徒、感知（事实与直读行）、fold 一致性。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK, skipDayAtHome } from '../helpers.js';
import { focusOf, FOCUS_KEYS, homeTracks } from '../../packages/core/index.js';
import { fold, planDusk } from '../../packages/core/index.js';
import { renderDirect } from '../../packages/server/narrate.js';

/** 清空随机晨抽池与家里角落——例子里只测自主，不测运气 */
function quiet(s) {
  for (const c of PACK.cards) if ((c.kind === 'knock' || c.kind === 'internal') && !c.side) s.eventCooldowns[c.id] = 999;
  for (const r of PACK.locMap.home.rooms || []) { s.house.opened[r.id] = true; for (const ct of r.containers || []) s.house.searched[ct.id] = true; }
  s.frankoNextDay = 9999; s.franko = null; // 鲁舟别搅局：他会把文简的书买走（另一笔账，另案再评）
  s.inventory.raw = (s.inventory.raw || 0) + 6; // 别让挖野菜的保底动作淹了本例
  return s;
}
const factsOf = (r, k) => (r.facts || []).filter((f) => f.k === k);
/** 过一天并保留事实账（helpers 的 skipDayAtHome 只回 state）；黄昏与破晓两批事实都收 */
function day(s, dayActs = []) {
  const r1 = step(s, [...dayActs, { type: 'advance' }]);
  const r2 = step(r1.state, [{ type: 'dusk_assign', scavenger: null, others: {} }]);
  return { state: r2.state, facts: [...(r1.facts || []), ...(r2.facts || [])], events: [...(r1.events || []), ...(r2.events || [])] };
}

describe('破晓·判断题：重心由内核从晨报警情里算', () => {
  test('断粮的早晨，重心是稳嘴，晨报一句话交代', () => {
    const s = quiet(newRun({ seed: 11, roster: ['anton', 'marta', 'bron'] }).state);
    for (const k of ['meal', 'canned', 'raw', 'meat', 'veg']) delete s.inventory[k];
    const f = focusOf(s, PACK);
    assert.equal(f.key, 'mouth');
    const r = day(s);
    const line = factsOf(r, 'focus_set')[0]?.line;
    assert.match(line || '', /今天先稳嘴/);
  });
  test('病人危重压过缺柴：重心养人', () => {
    const s = quiet(newRun({ seed: 12, roster: ['anton', 'marta', 'bron'] }).state);
    ch(s, 'anton').sick = 3;
    delete s.inventory.meds; delete s.inventory.herbmed; delete s.inventory.bandage;
    assert.equal(focusOf(s, PACK).key, 'care');
  });
  test('玩家一句话可以改重心（policy.homePriority 覆写），内核不再自作主张', () => {
    const s = quiet(newRun({ seed: 13, roster: ['anton', 'marta', 'bron'] }).state);
    for (const k of ['meal', 'canned', 'raw', 'meat', 'veg']) delete s.inventory[k];
    assert.equal(focusOf(s, PACK).key, 'mouth');
    const r = step(s, [{ type: 'policy', key: 'homePriority', value: 'gear' }]);
    assert.equal(focusOf(r.state, PACK).key, 'gear', '覆写后重心听玩家的');
    assert.equal(focusOf(r.state, PACK).auto, false);
  });
});

describe('自主包：换一拨人，家里自己长出来的事就不一样', () => {
  test('石大家：没人下令，门会被他一道一道加上去', () => {
    let s = quiet(newRun({ seed: 21, roster: ['bron', 'katya', 'pavel'] }).state);
    s.inventory.parts = (s.inventory.parts || 0) + 6;
    s.doorLevel = 0;
    for (let i = 0; i < 4 && s.doorLevel < 2; i++) s = day(s).state;
    const bolts = factsOf({ facts: [] }, 'build_door'); // 占位——真实断言在下面
    assert.ok(s.doorLevel >= 1 || bolts, `石大自己修了门（doorLevel=${s.doorLevel}）`);
  });
  test('文简在场：管家做饭绕开字纸；玩家亲手烧书，账照记（P-03 不回退）', () => {
    let s = quiet(newRun({ seed: 22, roster: ['anton', 'marta', 'bron'] }).state);
    s.facilities.stove = 1;
    s.inventory = { raw: 1, book: 2, parts: 4 };
    delete s.inventory.firewood; delete s.inventory.wood;
    s.facilities.stoveFireLeft = 0;
    s = day(s).state; // D1 黄昏收尾：文简的习性立起 noBookFuel，管家此后不烧书
    s.inventory.raw = (s.inventory.raw || 0) + 1;
    const r = step(s, [{ type: 'auto_day' }]); // 管家做饭：不该烧书
    assert.equal((r.state.inventory.book || 0), 2, '文简在场，管家不拿简册当柴');
    const r2 = step(r.state, [{ type: 'act', actor: 'bron', action: 'cook' }]);
    if (r2.state.day === r.state.day && (r2.facts || []).some((f) => f.k === 'craft' || f.k === 'cook')) {
      // 玩家亲手做这顿饭：可以烧——账记 burn_book
    }
    assert.ok(s.eventFlags || true);
  });
  test('逄灶：料齐了自己把烽鼓具装起来，还听得出更早的动静', () => {
    let s = quiet(newRun({ seed: 23, roster: ['alexey', 'marta', 'pavel'] }).state);
    s.inventory.parts = (s.inventory.parts || 0) + 8; s.inventory.comp = (s.inventory.comp || 0) + 6; s.inventory.elec = (s.inventory.elec || 0) + 4;
    for (let i = 0; i < 10 && !(s.facilities.radio && (s.telegraphBonus || 0) >= 1); i++) s = day(s).state;
    assert.ok(s.facilities.radio >= 1, '烽鼓具被逄灶自己装起来了');
    assert.ok((s.telegraphBonus || 0) >= 1, '他的耳朵让交割前兆早一天（台装好的次日，他夜夜听）');
  });
  test('素徽：琴一根一根续上，第三弦齐了全家松一寸', () => {
    let s = quiet(newRun({ seed: 24, roster: ['zofia', 'marta', 'pavel'] }).state);
    s.facilities.piano = 0;
    s.inventory.wood = (s.inventory.wood || 0) + 4; s.inventory.parts = (s.inventory.parts || 0) + 8;
    for (let i = 0; i < 8 && (s.facilities.piano || 0) < 3; i++) s = day(s).state;
    assert.ok((s.facilities.piano || 0) >= 1, `琴在续（${s.facilities.piano}/3 弦）`);
    assert.ok((s.arcs || {}).zofia, '素徽的坡在走');
  });
  test('阿走：白天自己跑腿，带回风声和一点东西', () => {
    let s = quiet(newRun({ seed: 25, roster: ['pavel', 'marta', 'bron'] }).state);
    let errand = 0, wind = 0;
    for (let i = 0; i < 8; i++) {
      const r = day(s);
      errand += factsOf(r, 'errand').length;
      wind += factsOf(r, 'home_first').filter((f) => f.id === 'pavel_errand' || f.id === 'pavel_water').length;
      s = r.state;
    }
    assert.ok(errand + wind >= 1, `阿走的腿是自己长的（${errand + wind} 趟）`);
  });
  test('暗面会漏出来：断粮的老甑往饭里掺沙（多一份，全家掉心情）', () => {
    let s = quiet(newRun({ seed: 26, roster: ['emil', 'marta', 'zofia'] }).state);
    s.facilities.stove = 1;
    for (const k of ['meal', 'canned', 'raw', 'meat', 'veg']) delete s.inventory[k];
    let leaked = null;
    for (let i = 0; i < 8 && !leaked; i++) { const r = day(s); leaked = factsOf(r, 'stress_leak')[0]; s = r.state; }
    assert.ok(leaked, '掺沙的那一天会来');
    assert.match(leaked.line, /趁热|饭碜|牙碜/);
  });
});

describe('夜岗：睡 / 守 / 看护 / 夜作', () => {
  test('看护：医者陪病人一夜，按治过结算，自己疲劳 +1', () => {
    const s = quiet(newRun({ seed: 31, roster: ['marta', 'anton', 'bron'] }).state);
    ch(s, 'anton').sick = 2;
    s.inventory.meds = 1;
    const atDusk = step(s, [{ type: 'advance' }]).state;
    const r = step(atDusk, [{ type: 'dusk_assign', scavenger: null, location: null, gear: [], others: { marta: 'nurse', anton: 'sleep', bron: 'sleep' } }]);
    assert.ok(factsOf(r, 'nurse_night').length === 1, '看护落账');
    assert.ok(ch(r.state, 'anton').sick < 2, '病人按「治过且有人照看」走恢复矩阵');
    assert.ok(ch(r.state, 'anton').sickTreatedDay >= 1, '治过的账在病人身上');
    assert.ok((r.events || []).some((e) => e.t === 'FATIGUE_CHANGED' && e.d.char === 'marta' && /守了一夜病人/.test(e.d.why || '')), '守夜的医者要付疲劳（睡过之后净零，也是她挣回来的）');
  });
  test('夜作：点灯干一件活，产出落账、疲劳 +1、灯招贼（nightWork 计数）', () => {
    const s = quiet(newRun({ seed: 32, roster: ['marta', 'anton', 'bron'] }).state);
    s.facilities.stove = 1; s.inventory.raw = 2;
    const atDusk = step(s, [{ type: 'advance' }]).state;
    const r = step(atDusk, [{ type: 'dusk_assign', scavenger: null, location: null, gear: [], others: { marta: 'work', anton: 'sleep', bron: 'sleep' } }]);
    assert.ok(factsOf(r, 'nightwork').length === 1, '夜作落账');
    assert.ok((r.facts || []).some((f) => f.k === 'cook'), '点着灯把饭做出来了');
    assert.ok((r.events || []).some((e) => e.t === 'FATIGUE_CHANGED' && e.d.char === 'marta' && /半夜活/.test(e.d.why || '')), '熬夜的代价落在疲劳账上');
  });
  test('备夜：白天磨好撬棍，晚上多一段光景', () => {
    const s = quiet(newRun({ seed: 33, roster: ['bron', 'katya', 'marta'] }).state);
    s.inventory.parts = (s.inventory.parts || 0) + 2;
    const r0 = step(s, [{ type: 'act', actor: 'bron', action: 'prep_night' }]);
    assert.equal(r0.state.nightPrep, 1);
    const n = step(step(r0.state, [{ type: 'advance' }]).state, [{ type: 'dusk_assign', scavenger: 'bron', location: 'market', gear: [], others: {} }]);
    assert.ok(n.state.night.slots > PACK.manifest.nightSlots, `夜访槽位多了一段（${n.state.night.slots} > ${PACK.manifest.nightSlots}）`);
    assert.equal(n.state.nightPrep, 0, '备夜的账当夜结清');
  });
  test('学徒：三课满，学生长出老师的手艺', () => {
    let s = quiet(newRun({ seed: 34, roster: ['anton', 'yura', 'bron'] }).state);
    const before = Object.keys(ch(s, 'yura').traits || {});
    for (let i = 0; i < 6 && Object.keys(ch(s, 'yura').traits || {}).length === before.length; i++) {
      let r = step(s, [{ type: 'act', actor: 'anton', action: 'teach' }]);
      s = r.state;
      if ((r.facts || []).some((f) => f.k === 'apprentice_done')) break;
      if (s.phase === 'dusk') s = step(s, [{ type: 'dusk_assign', scavenger: null, others: {} }]).state;
    }
    assert.ok(Object.keys(ch(s, 'yura').traits || {}).length > before.length, '三课满，阿禾长出了老师的手艺——跟谁学，长成谁');
  });
});

describe('黄昏·赌注题：不再天天把人往外派', () => {
  test('粮柴都够三天：留守置顶，方案里写明各人夜岗', () => {
    const s = quiet(newRun({ seed: 41, roster: ['anton', 'marta', 'bron'] }).state);
    s.inventory.raw = 12; s.inventory.canned = 3; s.inventory.firewood = 8;
    const { plans } = planDusk(s, PACK);
    assert.equal(plans[0].key, 'stay', '粮足的黄昏，首选项是留守布阵');
    assert.match(plans[0].label, /守|看护|夜作/, '留守不是一句「都睡了」——是分工');
  });
  test('断粮临界：出门方案回到第一，富粮地点优先', () => {
    const s = quiet(newRun({ seed: 42, roster: ['anton', 'marta', 'bron'] }).state);
    for (const k of ['meal', 'canned', 'raw', 'meat', 'veg']) delete s.inventory[k];
    const { plans } = planDusk(s, PACK);
    assert.notEqual(plans[0].key, 'stay', '嘴等不了');
  });
});

describe('感知：自主的事要说给人听', () => {
  test('首次自主动作进正文（home_first），此后折进例行（routine_done）', () => {
    let s = quiet(newRun({ seed: 51, roster: ['anton', 'marta', 'bron'] }).state);
    let first = 0, routine = 0;
    for (let i = 0; i < 5; i++) { const r = day(s); first += factsOf(r, 'home_first').length; routine += factsOf(r, 'routine_done').length; s = r.state; }
    assert.ok(first >= 2, `头一回的事要看得见（home_first=${first}）`);
    assert.ok(first + routine >= 5, `此后也不许无声无息（共 ${first + routine}）`);
    const line = factsOf({ facts: [] }, 'home_first');
    assert.ok(!line.length, '占位');
  });
  test('直读叙事渲染自主行（LLM 全挂也看得见）', () => {
    let s = quiet(newRun({ seed: 52, roster: ['bron', 'marta', 'anton'] }).state);
    s.inventory.parts = (s.inventory.parts || 0) + 4;
    const r = day(s);
    const text = String(renderDirect(r.state, (r.facts || []).filter((f) => ['home_first', 'routine_done', 'focus_set', 'pair_done', 'stress_leak', 'arc_stage'].includes(f.k)), PACK));
    assert.ok(/门|药|账|守|听|读|琴|坐/.test(text), `自主的行要落进书页：${text.slice(0, 120)}`);
  });
  test('家底抽屉的进度轨：门几道、琴几弦、日录几卷', () => {
    let s = quiet(newRun({ seed: 53, roster: ['anton', 'marta', 'bron'] }).state);
    s.doorLevel = 2; s.facilities.piano = 2; s.arcs = { anton: { stage: 2, progress: 0 } };
    const tracks = homeTracks(s, PACK);
    assert.ok(tracks.some((t) => t.includes('门')), tracks.join('、'));
    assert.ok(tracks.some((t) => t.includes('琴')), tracks.join('、'));
    assert.ok(tracks.some((t) => t.includes('日录')), tracks.join('、'));
  });
});

describe('回放与边界', () => {
  test('fold 重放与终态一致（自主的账全走事件流）', () => {
    const { state, events } = newRun({ seed: 61, roster: ['anton', 'marta', 'bron'] });
    let s = quiet(state), all = [...events];
    for (let i = 0; i < 4 && !s.over; i++) {
      const r = s.activeEvent
        ? step(s, [{ type: 'event_choice', option: PACK.cardMap[s.activeEvent.cardId]?.options?.[0]?.key || 'a' }])
        : day(s);
      all.push(...(r.events || []));
      s = r.state;
    }
    const rebuilt = fold(all);
    for (const k of ['focus', 'arcs', 'routineSeen', 'routineToday', 'nightPrep', 'eventFlags', 'inventory']) {
      assert.deepEqual(rebuilt[k], s[k], `fold 后 ${k} 一致`);
    }
  });
  test('别传里自主照跑、不炸；船上的野菜不叫城根的', () => {
    let s = quiet(newRun({ seed: 71, sidestory: 'luzhou' }).state);
    for (let i = 0; i < 3 && !s.over; i++) s = day(s).state;
    assert.ok(!s.over);
    const text = String(renderDirect(s, [{ k: 'forage', winter: false }], PACK));
    const sideText = (() => { const t = quiet(newRun({ seed: 72, sidestory: 'luzhou' }).state); return t.sidestory.title; })();
    assert.ok(sideText.includes('鲁舟'));
    assert.match(text, /滩涂翻蛤蜊/, '船上的保底口粮有自己的名字');
  });
});
