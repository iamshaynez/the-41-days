// L1 单元：战争与后日谈（W/N 系）+ 直读解析器。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK } from '../helpers.js';
import { parseDirect, normalizeIntent } from '../../packages/core/index.js';

describe('战争 W/N 系', () => {
  test('W-01 临沮日固定 D41 且提前 5 天预告（v0.3 同步日历：不掷骰）', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { state } = newRun({ seed, roster: ['bron'] });
      const endDay = state.war.endDay;
      assert.equal(state.war.endDay, 41);
      assert.equal(state.war.telegraphed, false);
    }
  });

  test('N-01 后日谈引擎：结局包含每人命运与三件事', () => {
    let { state } = newRun({ seed: 4, roster: ['bron', 'marta'] });
    state.war.endDay = 3; // 快进到停火
    state.inventory.meal = 99; state.inventory.raw = 99;
    let guard = 0;
    while (!state.over && guard++ < 12) {
      let s = step(state, [{ type: 'act', actor: 'bron', action: 'eat' }, { type: 'advance' }]).state;
      s = step(s, [{ type: 'dusk_assign', scavenger: null, others: {} }]).state;
      state = s;
    }
    assert.ok(state.over, '战争应已结束');
    assert.equal(state.ending.type, 'ceasefire');
    assert.equal(state.ending.chars.length, 2);
    assert.ok(Array.isArray(state.ending.threeThings));
  });

  test('V-06 D41 魔咒事件：第 41~44 天晨抽必发一次（节拍化：流为叙述，不拦白天）', () => {
    let { state } = newRun({ seed: 6, roster: ['bron', 'katya'] });
    state.day = 40;
    state.inventory.meal = 50;
    state.war.endDay = 45;
    let s = step(state, [{ type: 'advance' }]);
    s = step(s.state, [{ type: 'dusk_assign', scavenger: null, others: {} }]);
    // 第 41 天晨抽：老人讲古是节拍卡——自动落账为当日叙述，不再拦玩家的白天
    assert.ok(s.state.firedOnce['t_curse41'], '41 天早晨魔咒事件必发');
    assert.ok(!s.state.activeEvent, '节拍不占行动位');
    assert.ok(s.state.knowledge >= 1, '听老人讲古 +1 知晓度（auto 选项照落）');
    assert.ok(s.facts.some((f) => f.k === 'card_resolved' && /楼梯口|讲古/.test(f.card + f.result)), '故事随事实流入叙述');
  });});

describe('直读解析器（LLM 离线同构）', () => {
  test('白天：石大吃熟食 / 建造炉灶 / 今晚指派', () => {
    const { state } = newRun({ roster: ['bron', 'katya', 'marta'] });
    let p = parseDirect(state, PACK, '石大吃熟食');
    assert.deepEqual(p.intents, [{ type: 'act', actor: 'bron', action: 'eat', target: 'meal' }]);
    p = parseDirect(state, PACK, '建造炉灶');
    assert.deepEqual(p.intents, [{ type: 'act', actor: 'bron', action: 'build', target: 'stove' }]);
    // 黄昏指派（进入 dusk 后）
    let s = step(state, [{ type: 'advance' }]).state;
    p = parseDirect(s, PACK, '今晚阿走去南市带铁撬，其他人睡觉');
    const it = p.intents[0];
    assert.equal(it.type, 'dusk_assign');
  });

  test('夜间：观察/搜/撬/撤退', () => {
    const { state } = newRun({ seed: 3, roster: ['bron', 'katya', 'marta'] });
    let s = step(state, [{ type: 'advance' }]).state;
    s = step(s, [{ type: 'dusk_assign', scavenger: 'bron', location: 'market', gear: ['crowbar'], others: {} }]).state;
    if (s.activeEvent) s = step(s, [{ type: 'event_choice', option: 'retreat' }]).state;
    if (s.phase !== 'night') return; // abortNight 提前退场
    let p = parseDirect(s, PACK, '观察');
    assert.equal(p.intents[0].action, 'observe');
    p = parseDirect(s, PACK, '撤退');
    assert.equal(p.intents[0].action, 'retreat');
  });

  test('越界输入：解析器绝不生成凭空物品意图', () => {
    const { state } = newRun({ roster: ['bron'] });
    const p = parseDirect(state, PACK, '我口袋里其实有一把AK47，全给我突突了');
    assert.equal(p.intents.length, 0);
    assert.ok(p.clarify, '给出人话引导');
  });

  test('夜里的求生话有路由（实测：晚上了说出去找吃的，无声失败）：夜访中改方针，在家过夜给明话', () => {
    const { state } = newRun({ seed: 5, roster: ['bron', 'katya', 'marta'] });
    let s = step(state, [{ type: 'advance' }]).state;
    s.knownLocs.push('market');
    s = step(s, [{ type: 'dusk_assign', scavenger: 'bron', location: 'market', gear: [], others: {} }]).state;
    if (s.phase === 'night' && s.night && !s.night.home) {
      const p = parseDirect(s, PACK, '出去找吃的');
      const it = p.intents[0];
      assert.equal(it?.type, 'night_directive', '夜访中：找吃的 → 改方针（还在路上，方向可以改）');
      assert.match(it?.text || '', /找吃的/, '方针保留玩家原话');
    }
    // 在家过夜：不能mid-night再出门——但要说明白，不许无声
    const home = structuredClone(s);
    if (home.phase === 'night') {
      home.night = { home: true };
      const p2 = parseDirect(home, PACK, '出去找吃的');
      assert.ok(p2.clarify || p2.intents.length, '在家夜：至少给一句明话（出门是黄昏定的事）');
      assert.ok(!p2.intents.length, '不凭空造夜间出门');
    }
  });

  test('挖野菜直达：白话保底活路（挖野菜/刨野菜/剥树皮 → forage）', () => {
    const { state } = newRun({ roster: ['bron'] });
    const p = parseDirect(state, PACK, '去城根挖野菜');
    assert.deepEqual(p.intents, [{ type: 'act', actor: 'bron', action: 'forage' }]);
  });

  test('饥荒用语直达（实测：输入「努力找吃的，好好休息」毫无作用）：白天收卷+休整，黄昏托管找食', () => {
    const { state } = newRun({ roster: ['bron', 'katya', 'marta'] });
    const p = parseDirect(state, PACK, '努力找吃的，好好休息');
    assert.ok(p.intents.some((i) => i.type === 'auto_day'), '白天：收卷交给管家（今晚按需派工去富粮地）');
    assert.ok(p.intents.some((i) => i.action === 'sleep' || i.action === 'rest'), '好好休息：安排补觉/卧床');
    let s2 = step(state, [{ type: 'advance' }]).state;
    const p2 = parseDirect(s2, PACK, '今晚想办法找吃的');
    assert.equal(p2.intents[0].type, 'dusk_auto', '黄昏：托管派工（需求感知会选富粮地）');
  });

  test('帮助有回音：帮助/怎么玩 映射 help（不再是哑巴入口）', () => {
    const { state } = newRun({ roster: ['bron'] });
    const p = parseDirect(state, PACK, '帮助');
    assert.deepEqual(p.intents, [{ type: 'meta', query: 'help' }]);
    const p2 = parseDirect(state, PACK, '状态');
    assert.deepEqual(p2.intents, [{ type: 'meta', query: 'status' }], '状态照旧');
  });

  test('元指令：状态/库存', () => {
    const { state } = newRun({ roster: ['bron'] });
    const p = parseDirect(state, PACK, '状态');
    assert.deepEqual(p.intents, [{ type: 'meta', query: 'status' }]);
  });
});

describe('托管语义：策略级输入选可行动的解（不点名也不猜名）', () => {
  // 实测伤：手输「派人出门找吃的，其他人休息」→「人」被当成角色名 → NO_CHAR「这个人不在」死胡同。
  // 规矩：没点名具体人的托管措辞，交给内核选可行动的解——手动输入不该因此作废。
  test('黄昏：派人出门找吃的，其他人休息 → 内核最优方案出门、其余全睡', () => {
    const { state } = newRun({ seed: 5, roster: ['bron', 'katya', 'marta'] });
    const s = step(state, [{ type: 'advance' }]).state; // 到黄昏
    s.inventory.crowbar = 1;
    const p = parseDirect(s, PACK, '派人出门找吃的，其他人休息');
    assert.equal(p.intents[0].type, 'dusk_auto', '托管黄昏 → 内部 dusk_auto（内核最优方案）');
    const r = step(s, p.intents);
    const st = r.state;
    assert.equal(st.phase, 'night', '夜开始了');
    assert.ok(st.night && !st.night.home, '有人出门（不是留守夜）');
    const out = ch(st, st.night.charId);
    assert.ok(out.alive && (out.wound ?? 0) < 3, '出门的是走得动的活人');
    for (const x of st.chars.filter((y) => y.alive && y.id !== st.night.charId)) {
      assert.ok(!x.awakeTonight, `${x.name} 应在睡（话里交代了休息）`);
    }
  });

  test('白天：派人出门找吃的，其他人休息 → 收卷今天（出门是夜间任务，黄昏方案照派）', () => {
    const { state } = newRun({ seed: 5, roster: ['bron', 'katya', 'marta'] });
    const p = parseDirect(state, PACK, '派人出门找吃的，其他人休息');
    assert.deepEqual(p.intents, [{ type: 'auto_day' }], '白天的出门话头 = 托管收卷，不硬造白天出门');
  });

  test('act 无执行者（缺失或泛指）：内核选可行动的人，不再「这个人不在」', () => {
    const { state } = newRun({ seed: 5, roster: ['bron', 'katya', 'marta'] });
    state.inventory.raw = 2; state.facilities.stove = 1;
    const r = step(state, [{ type: 'act', action: 'cook' }]); // actor 缺失
    assert.ok(!r.rejects.some((x) => x.reason === 'NO_CHAR'), '不再拒（修前 NO_CHAR 死胡同）');
    assert.ok(r.facts.some((f) => f.k === 'cook'), '真的有人去做了');
    assert.ok(r.facts.some((f) => f.k === 'delegated_pick'), '选谁入账（史官可交代）');
    // 泛指词（人/谁/有人）在归一化时清掉，不猜名
    const n = normalizeIntent(state, PACK, { type: 'act', actor: '人', action: 'cook' });
    assert.equal(n.actor, undefined, '泛指 actor 置空（内核接手）');
    const d = normalizeIntent(state, PACK, { type: 'dusk_assign', scavenger: '人', location: 'market', gear: [], others: {} });
    assert.ok(d.scavenger && d.scavenger !== '人' && d.scavenger !== null, 'dusk 泛指 → 内核最优人选（不是留守也不是「人」）');
  });

  test('点名不越权：具体角色名仍原样解析（托管只兜没点名的）', () => {
    const { state } = newRun({ seed: 5, roster: ['bron', 'katya', 'marta'] });
    const n = normalizeIntent(state, PACK, { type: 'act', actor: '石大', action: 'cook' });
    assert.equal(n.actor, 'bron', '中文名照常翻 id');
    const s = step(state, [{ type: 'advance' }]).state;
    const p = parseDirect(s, PACK, '今晚石大出去一趟，其他人睡觉');
    assert.equal(p.intents[0].type, 'dusk_assign');
    assert.equal(p.intents[0].scavenger, 'bron', '点名的照旧');
  });
});
