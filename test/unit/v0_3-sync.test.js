// v0.3 同步日历验收：D1=交割次晨，D41=临沮；军心溶解账与三刀铰链；擦痕与题卷。
// 对应正典圣经 v0.3 §1（41 日新义：同一场雪，落在两处）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK } from '../helpers.js';
import { Ctx, chooseEventOption } from '../../packages/core/index.js';
import * as VITALS from '../../packages/core/src/vitals.js';

describe('v0.3 同步日历', () => {
  test('交割日固定 D41（不掷骰），forceEnd 41', () => {
    for (const seed of [1, 7, 42, 999, 640710127]) {
      const { state } = newRun({ seed });
      assert.equal(state.war.endDay, 41, `seed ${seed}`);
    }
    assert.equal(PACK.manifest.war.forceEndDay, 41);
  });

  test('序章以「白衣」收拍：翻完落地 D1 白天（交割后第一天）', () => {
    const { state } = newRun({ seed: 5, prologue: true });
    let s = state;
    // 把序章一路翻完（文本 advance / 卡选第一项）
    for (let i = 0; i < 40 && s.phase === 'prologue'; i++) {
      if (s.activeEvent) {
        const card = PACK.cardMap[s.activeEvent.cardId];
        const opt = card?.options?.find((o) => o.key !== 'begin') || card?.options?.[0];
        const r = step(s, [{ type: 'event_choice', option: opt?.key || 'begin' }]);
        s = r.state;
      } else {
        s = step(s, [{ type: 'advance' }]).state;
      }
    }
    assert.equal(s.phase, 'day');
    assert.equal(s.day, 1);
    assert.ok(s.eventFlags.handover_seen, '白衣卡落旗');
  });

  test('内容完整性：双轨步、结局线、新卡窗口', () => {
    const steps = PACK.mainline.steps;
    for (const st of steps) {
      assert.ok(st.day <= 41, `${st.id} 超出 D41`);
      assert.ok(['city', 'gen'].includes(st.track), `${st.id} 无轨标记`);
    }
    assert.ok(steps.some((x) => x.id === 'm21_linju' && x.day === 41 && x.track === 'gen'), 'D41 临沮步');
    for (const [k, lines] of Object.entries(PACK.mainline.endings)) {
      assert.ok(lines.length >= 2, `${k} 结局线过短`);
      assert.ok(lines.some((l) => l.includes('第四十一天')), `${k} 结局未扣题`);
    }
    assert.ok(PACK.mainline.endings.ceasefire.some((l) => l.includes('关羽传')), '正史引文缺失');
    const curse = PACK.cardMap.t_curse41;
    assert.ok(curse.when.dayWindow[1] <= 41, '讲古日窗口越界');
    for (const id of ['o_visit1', 'o_letter1', 'o_visit2', 'o_deserter2', 'o_letter2', 'o_yujin']) {
      assert.ok(PACK.cardMap[id], `缺 ${id}`);
    }
    assert.ok(PACK.cardMap.o_visit1.options.some((o) => (o.effects || {}).dissolve > 0), '家访卡无溶解效果');
  });
});

describe('军心溶解账', () => {
  test('家访/家书效果通道：dissolve 正负入账、FLAG 镜像、fact 落页', () => {
    const { state } = newRun({ seed: 3 });
    state.activeEvent = { cardId: 'o_visit1' };
    const events = [];
    const ctx = new Ctx(state, PACK, events, []);
    const r = chooseEventOption(ctx, 'accept');
    assert.ok(r.ok);
    assert.equal(state.dissolve, 3);
    assert.ok(events.some((e) => e.t === 'FLAG' && e.d.key === 'dissolve'), 'FLAG 镜像');
    assert.ok(events.some((e) => e.t === 'EVENT_FIRED' || e.t === 'EVENT_CHOSEN'));
    state.activeEvent = { cardId: 'o_letter1' };
    chooseEventOption(new Ctx(state, PACK, events, []), 'hard');
    assert.equal(state.dissolve, 1, '如实家书 -2');
  });

  test('环境账：家中存粮充足的日子，军心每天松半分', () => {
    const { state } = newRun({ seed: 3 });
    state.day = 10;
    state.inventory.raw = 8; // 存粮充足
    const events = [];
    const ctx = new Ctx(state, PACK, events, []);
    const before = state.dissolve || 0;
    VITALS.tickWar(ctx);
    assert.equal(state.dissolve - before, 0.5);
    for (const k of ['meal', 'canned', 'raw', 'meat', 'veg']) state.inventory[k] = 0;
    state.inventory.veg = 2; // 拮据
    VITALS.tickWar(new Ctx(state, PACK, [], []));
    assert.equal(state.dissolve - before, 0.5, '拮据的日子不松');
  });
});

describe('D41 三刀铰链', () => {
  const atD41 = (over = {}) => {
    const { state } = newRun({ seed: 3 });
    Object.assign(state, over);
    state.day = 41;
    return state;
  };
  const runHinge = (state) => {
    const events = [];
    const ctx = new Ctx(state, PACK, events, []);
    const { tickWar } = VITALS;
    tickWar(ctx);
    return state;
  };

  test('刀落（正史默认）：军心散尽，无杠杆', () => {
    const s = runHinge(atD41({ dissolve: 30 }));
    assert.ok(s.war.ended);
    assert.equal(s.war.endingType, 'ceasefire');
    assert.equal(s.war.armyHeld, false);
    assert.equal(s.war.leverHad, false);
  });

  test('刀偏：军心未散 + 麦城杠杆 → 得脱', () => {
    const s = runHinge(atD41({ dissolve: 10, eventFlags: { alt_maicheng: true } }));
    assert.equal(s.war.endingType, 'maicheng');
    assert.equal(s.war.armyHeld, true);
  });

  test('刀偏：军心未散 + 机关杠杆 → 惨胜（不再 +6 日）', () => {
    const s = runHinge(atD41({ dissolve: 0, eventFlags: { alt_jiangling: true } }));
    assert.equal(s.war.endingType, 'pyrrhic');
    assert.equal(s.war.endDay, 41, '交割日不再推迟');
  });

  test('刀仍落（最狠的正史变体）：有杠杆而军心已散', () => {
    const s = runHinge(atD41({ dissolve: 40, eventFlags: { alt_jiangling: true } }));
    assert.equal(s.war.endingType, 'ceasefire');
    assert.equal(s.war.leverHad, true, '野史批注应记「机关拆了，家书没拦住」');
  });

  test('野史批注：三变体文案随铰链注记分家', async () => {
    const { buildEnding } = await import('../../packages/core/index.js');
    const mk = (over) => {
      const s = atD41(over); // 不预置 ended——让 D41 铰链自己落 type 与注记
      VITALS.tickWar(new Ctx(s, PACK, [], []));
      assert.equal(s.war.endingType, 'ceasefire');
      return s;
    };
    const e1 = buildEnding(mk({ dissolve: 30 }), PACK);
    assert.match(e1.storyline.annals[0].note, /谁也没有做错什么/);
    const e2 = buildEnding(mk({ dissolve: 5 }), PACK);
    assert.match(e2.storyline.annals[0].note, /你拦过那些家书/);
    const e3 = buildEnding(mk({ dissolve: 40, eventFlags: { alt_jiangling: true } }), PACK);
    assert.match(e3.storyline.annals[0].note, /机关拆了/);
  });
});

describe('结局屏数据（codex 与擦痕）', () => {
  test('codex：落幕线、双轨、题卷行齐备', async () => {
    const { buildEnding } = await import('../../packages/core/index.js');
    const { state } = newRun({ seed: 3 });
    state.day = 41; state.war.ended = true; state.war.endingType = 'ceasefire';
    state.dissolve = 30;
    state.mainline = [
      { day: 3, stepId: 'm2_visit', pens: [] },
      { day: 12, stepId: 'm6_envoy', pens: [] },
      { day: 41, stepId: 'm21_linju', pens: [] }
    ];
    const e = buildEnding(state, PACK);
    const c = e.storyline.codex;
    assert.ok(c.lines.length >= 3, '落幕线');
    assert.ok(c.lines.some((l) => l.includes('兰台把这卷书合上')), '题卷行');
    assert.ok(c.tracks.city.some((b) => b.title === '家访'), '城轨');
    assert.ok(c.tracks.gen.some((b) => b.title === '第四十一天'), '将军轨');
  });

  test('擦痕：同日的史步与因果账配对成「史×你」', async () => {
    const { buildEnding } = await import('../../packages/core/index.js');
    const { state } = newRun({ seed: 3 });
    state.day = 41; state.war.ended = true; state.war.endingType = 'ceasefire';
    state.mainline = [{ day: 3, stepId: 'm2_visit', pens: [] }];
    state.causality = { entries: [
      { i: 0, day: 3, verb: 'help', actor: 'player', via: 'marta', target: null, weight: 2, witnesses: [] }
    ], charArcs: {}, pairArcs: {} };
    const e = buildEnding(state, PACK);
    assert.equal(e.storyline.echoes.length, 1);
    assert.equal(e.storyline.echoes[0].hist, '家访');
    assert.ok(e.storyline.echoes[0].deed.includes('帮过人'));
  });

  test('死亡日入命运句：D37 走的人不再记成 D41', async () => {
    const { buildEnding } = await import('../../packages/core/index.js');
    const { state } = newRun({ seed: 3 });
    state.day = 41; state.war.ended = true; state.war.endingType = 'ceasefire';
    state.deathDays = { marta: 37 };
    ch(state, 'marta').alive = false;
    const e = buildEnding(state, PACK);
    const fate = e.chars.find((c) => c.id === 'marta').fate;
    assert.match(fate, /第 37 天/);
  });
});

