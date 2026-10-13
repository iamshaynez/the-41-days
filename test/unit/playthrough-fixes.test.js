// 一周目实测问题的修复验收（2026-10-13 全流程试玩报告 · 第六节 A/B/C 级全项）。
// 每个测试对应报告里的一条问题，命名即问题编号。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newRun, skipDayAtHome, ch, PACK } from '../helpers.js';
import {
  normalizeProposal, planDay, planDusk, dawnProblems, suggests, tradeDeals,
  buildEnding, rejectText, REJECT_TEXT, drawMorningEvents, fold,
  memoirLint, biographyLint
} from '../../packages/core/index.js';
import { markerSyntaxErrors } from '../../packages/core/src/markers.js';
import { anchorPool } from '../../packages/core/src/ge.js';
import { Ctx } from '../../packages/core/index.js';
import { createGeDirector, itemLegend } from '../../packages/server/ge.js';
import { humanFacts, narrationLint } from '../../packages/server/narrate.js';
import { tickMood } from '../../packages/core/src/vitals.js';
import { Rng } from '../../packages/core/src/rng.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');

describe('A-1 命运导演不再零产出', () => {
  test('normalizeProposal：中文名物品键就地归一为 id，未知键原样保留待拒', () => {
    const p = {
      title: '半块姜', text: 'x'.repeat(30), theme: '稀缺',
      anchors: ['第3天', '天气:clear'],
      options: [
        { label: '熬汤', item_cost: { 水: 1, 薪柴: 1 }, items_gain: { 草药: 2 } },
        { label: '由它去' }
      ]
    };
    const n = normalizeProposal(PACK, p);
    assert.deepEqual(n.options[0].item_cost, { water: 1, firewood: 1 });
    assert.deepEqual(n.options[0].items_gain, { herb: 2 });
    const bad = normalizeProposal(PACK, { ...p, options: [{ label: 'a', item_cost: { 不存在的东西: 1 } }, { label: 'b' }] });
    assert.equal(bad.options[0].item_cost['不存在的东西'], 1, '未知键原样保留（由验证器拒绝）');
    assert.equal(p.options[0].item_cost.水, 1, '入参不被改写（纯函数）');
  });

  test('itemLegend：物品 id 清单覆盖全部物品（id+中文名成对）', () => {
    const legend = itemLegend(PACK);
    for (const it of PACK.items) assert.ok(legend.includes(`${it.id}(${it.name})`), `缺 ${it.id}`);
  });

  test('锚池的设施锚用中文名（stove 不再裸奔进卡面）', () => {
    const { state } = newRun({ seed: 3, roster: ['anton', 'marta', 'bron'] });
    state.facilities.stove = 1;
    const pool = anchorPool(PACK, state);
    assert.ok(pool.includes('设施:炉灶'), '设施锚应是中文名');
    assert.ok(!pool.some((a) => a.startsWith('设施:') && /[a-z]/.test(a)), `仍有裸 id 设施锚：${pool.filter((a) => a.startsWith('设施:'))}`);
  });

  test('playwright 提示词带 {{items}} 注入位（内容包完整性）', () => {
    const md = readFileSync(join(ROOT, 'content/base/prompts/playwright.md'), 'utf8');
    assert.ok(md.includes('{{items}}'));
  });

  test('注入时机：白天预取的卡跨黄昏保留，次日白天注入（不再被黄昏边界丢掉）', async () => {
    let s = newRun({ seed: 5, roster: ['anton', 'marta', 'bron'] }).state;
    s.firedOnce = { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 }; // 预算开够（与既有 GE 测试同法）
    let dayNow = 1;
    const provider = { call: async () => ({ text: JSON.stringify({
      title: `半块麦饼·第${dayNow}日`, theme: PACK.ge.themeWheel[dayNow % PACK.ge.themeWheel.length],
      anchors: [`第${dayNow}天`, '天气:clear'],
      text: '对门的老者把半块麦饼放在门槛上，没留话。文简捡起来时饼还是热的，说明对门家里今天有火。',
      options: [{ label: '收进来，分了', items_gain: { 糙米: 1 } }, { label: '放回去' }]
    }) }) };
    const dir = createGeDirector({ pack: PACK, prompts: { playwright: '锚 {{anchors}} 主题 {{theme}} 物品 {{items}}' }, getProvider: () => provider });
    await dir.onTurn('r1', s);           // 白天：预取开始
    assert.ok(!s.activeEvent, '首个边界只预取不注入');
    s.phase = 'dusk';                    // 玩家输入收卷入黄昏（一周目的常态路径）
    await dir.onTurn('r1', s);           // 黄昏边界：相位不符——保留
    assert.ok(!s.activeEvent, '黄昏不注白天的卡');
    s.day = 2; s.phase = 'day'; dayNow = 2;
    await dir.onTurn('r1', s);           // 次日白天：注入
    assert.ok(s.activeEvent?.generated, '次日白天注入预取卡');
    assert.equal(Object.keys(s.geCards).length, 1);
  });

  test('注入配额：同一天答完一张生成卡，后续输入边界不再注入（验证局实测连环 286 张的回归）', async () => {
    let s = newRun({ seed: 9, roster: ['anton', 'marta', 'bron'] }).state;
    s.firedOnce = { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 };
    let n = 0;
    const provider = { call: async () => ({ text: JSON.stringify({
      title: `连续的第${++n}张`, theme: '失物',
      anchors: [`第${s.day}天`, '天气:clear'], // 锚随生成日走（真实编剧从当局锚池挑）
      text: '文简又在门槛捡到一样小东西，拿在手里，还是热的。',
      options: [{ label: '收进来', items_gain: { 杂件: 1 } }, { label: '放回去' }]
    }) }) };
    const dir = createGeDirector({ pack: PACK, prompts: { playwright: '{{anchors}}' }, getProvider: () => provider });
    await dir.onTurn('r3', s);
    s.phase = 'dusk'; await dir.onTurn('r3', s); // 卡落在黄昏边界，保留
    s.day = 2; s.phase = 'day'; await dir.onTurn('r3', s); // D2 注入第一张
    assert.ok(s.activeEvent?.generated);
    assert.equal(s.geShown, 1);
    s.activeEvent = null; // 玩家答完卡
    await dir.onTurn('r3', s); // 同一天下一个输入边界
    assert.ok(!s.activeEvent, '同一天不得注入第二张');
    assert.equal(s.geShown, 1, 'geShown 不因重试连环膨胀');
    s.day = 3; s.phase = 'day'; await dir.onTurn('r3', s); // 次日照常
    assert.equal(s.geShown, 2, '次日恢复注入');
  });

  test('慢编剧不拖玩家输入：在途预取超时即让路，卡留到下一边界', async () => {
    let s = newRun({ seed: 7, roster: ['anton', 'marta', 'bron'] }).state;
    s.firedOnce = { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 };
    const provider = { call: async () => {
      await new Promise((r) => setTimeout(r, 2100));
      return { text: JSON.stringify({ title: '慢来的卡', theme: '稀缺', anchors: ['第1天', '天气:clear'], text: '文简在门槛上捡到半块饼，还是热的。' + 'x'.repeat(10), options: [{ label: '收', items_gain: { 糙米: 1 } }, { label: '不收' }] }) };
    } };
    const dir = createGeDirector({ pack: PACK, prompts: { playwright: '{{anchors}}' }, getProvider: () => provider });
    await dir.onTurn('r2', s); // 发起预取
    s.phase = 'dusk';
    const t0 = Date.now();
    await dir.onTurn('r2', s); // 在途：1.5s 上限内必须返回（不阻塞输入）
    assert.ok(Date.now() - t0 < 1900, 'onTurn 不等慢编剧');
    s.day = 2; s.phase = 'day';
    await dir.onTurn('r2', s); // 慢卡这时已落地：注入
    assert.ok(s.activeEvent?.generated, '慢卡在下一边界注入');
  });
});

describe('A-2 拒绝码说人话', () => {
  test('rejectText：全表人话且不含下划线大写码', () => {
    for (const [k, v] of Object.entries(REJECT_TEXT)) {
      assert.ok(!/[A-Z_]{3,}/.test(v), `${k} 的译文仍像内部码：${v}`);
    }
    assert.equal(rejectText('NO_ITEM'), '手头没有那个东西');
  });

  test('静态守门：core 里发明的每个 reason 码都已登记（新码漏登记即红）', () => {
    const dir = join(ROOT, 'packages/core/src');
    const found = new Set();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/reason: '([A-Z_]+)'/g)) found.add(m[1]);
    }
    const missing = [...found].filter((r) => !REJECT_TEXT[r]);
    assert.deepEqual(missing, [], `未登记的拒绝码：${missing.join('、')}`);
  });
});

describe('A-3 或然卡不重入随机池', () => {
  test('firedOnce 里的卡（不论路径）永不再入晨抽池', () => {
    let hits = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const { state } = newRun({ seed, roster: ['anton', 'marta', 'bron'] });
      state.day = 20;
      state.firedOnce['alt_jiangling'] = true; // 或然路径已烧掉
      const events = [];
      const ctx = new Ctx(state, PACK, events, []);
      drawMorningEvents(ctx);
      if (state.activeEvent?.cardId === 'alt_jiangling') hits++;
    }
    assert.equal(hits, 0, 'firedOnce 的卡仍被随机池抽中');
  });
});

describe('A-4 回放一致性（自伤收场镜像）', () => {
  test('tickMood 自伤分支发 BREAKDOWN_CALM，fold 能还原', () => {
    let done = null;
    for (let seed = 1; seed <= 120 && !done; seed++) {
      const { state } = newRun({ seed, roster: ['anton', 'marta'] });
      const c = ch(state, 'anton');
      c.breakdown = { stage: 2 }; c.soothed = 0; c.moodPts = -15; c.wound = 0;
      const base = structuredClone(state); // fold 打底：自伤前的完整态（含崩溃 stage 2）
      const events = [];
      const ctx = new Ctx(state, PACK, events, []);
      tickMood(ctx);
      if (!c.alive) continue;          // 离队分支（CHAR_DIED 有镜像）
      if (c.breakdown !== null) continue; // 理论不至（stage=2），保险
      const calm = events.find((e) => e.t === 'BREAKDOWN_CALM');
      if (calm) done = { base, events };
    }
    assert.ok(done, '种子扫描应命中自伤收场分支');
    const rebuilt = fold([{ i: 0, day: 1, t: 'RUN_STARTED', d: { state: done.base } }, ...done.events]);
    const a = rebuilt.chars.find((x) => x.id === 'anton');
    assert.equal(a.breakdown, null, 'fold 后崩溃态为 null（与实况一致）');
    assert.equal(a.soothed, 0);
  });
});

describe('B-1 管家看材料账', () => {
  test('没板材就不提捕鼠笼（不再天天撞 NO_ITEM）', () => {
    const { state } = newRun({ seed: 3, roster: ['marta', 'emil', 'pavel'] });
    state.facilities.stove = 1; state.doorLevel = 1;
    state.inventory.wood = 0; state.inventory.parts = 10; state.inventory.comp = 5;
    const intents = planDay(state, PACK);
    assert.ok(!intents.some((i) => i.type === 'act' && i.action === 'build' && i.target === 'trap'), '缺板材仍提议捕鼠笼');
    state.inventory.wood = 3;
    const intents2 = planDay(state, PACK);
    assert.ok(intents2.some((i) => i.type === 'act' && i.action === 'build' && i.target === 'trap'), '材料齐了提议捕鼠笼');
  });

  test('tradeDeals：无斧之家缺板材时，建议单里有木板', () => {
    const { state } = newRun({ seed: 3, roster: ['marta', 'emil', 'pavel'] });
    state.franko = { merchant: 'franko', stock: [{ item: 'wood', n: 4, buy: 3 }, { item: 'canned', n: 2, buy: 5 }] };
    state.inventory.wood = 0; state.inventory.parts = 6; state.inventory.jewel = 2;
    const deals = tradeDeals(state, PACK);
    assert.ok(deals.some((d) => d.get.wood), '缺板材的建议单应含木板');
  });
});

describe('B-2 黄昏方案看心情', () => {
  test('原排序在前的抑郁者让位给心态可出门的人', () => {
    const { state } = newRun({ seed: 3, roster: ['marta', 'emil', 'pavel'] });
    state.knownLocs = [...state.knownLocs, 'market', 'villas'];
    ch(state, 'marta').moodPts = -15; // 原排序第一、背包并列最大——没有本修复时必中
    const { plans } = planDusk(state, PACK);
    const scav = plans.find((p) => p.key === 'a').intent.scavenger;
    assert.notEqual(scav, 'marta', '抑郁者不再优先出门');
    assert.ok(ch(state, scav).moodPts > -9, `被选者心态应可出门（${scav}）`);
    // 反证：不抑郁时 marta 凭原序当选（同一状态只改心情）
    ch(state, 'marta').moodPts = 0;
    assert.equal(planDusk(state, PACK).plans.find((p) => p.key === 'a').intent.scavenger, 'marta');
  });

  test('全员抑郁时方案保留，hint 明示"可能不肯出门"', () => {
    const { state } = newRun({ seed: 3, roster: ['marta', 'emil', 'pavel'] });
    state.knownLocs = [...state.knownLocs, 'market'];
    for (const c of state.chars) c.moodPts = -15;
    const a = planDusk(state, PACK).plans.find((p) => p.key === 'a');
    assert.ok(a, '抑郁不等于没有方案');
    assert.match(a.hint, /可能不肯出门/);
  });
});

describe('B-3 和平局的三件事不再空白', () => {
  test('零击杀局：因果账里的施舍/守夜/送别进三件事，文案是人话', () => {
    const { state } = newRun({ seed: 3, roster: ['marta', 'emil', 'pavel'] });
    state.day = 45;
    state.war.ended = true;
    state.causality = {
      entries: [
        { i: 0, day: 5, verb: 'help', actor: 'player', via: 'marta', target: null, weight: 2, witnesses: [] },
        { i: 1, day: 12, verb: 'refuse_help', actor: 'player', via: null, target: null, weight: 1.5, witnesses: [] },
        { i: 2, day: 30, verb: 'guard_night', actor: 'player', via: 'pavel', target: 'home', weight: 0.5, witnesses: [] },
        { i: 3, day: 44, verb: 'witness_death', actor: 'world', via: null, target: 'emil', weight: 5, witnesses: [] },
        { i: 4, day: 9, verb: 'listen_radio', actor: 'pavel', weight: 0.2, witnesses: [] }
      ],
      charArcs: {}, pairArcs: {}
    };
    ch(state, 'emil').alive = false;
    const ending = buildEnding(state, PACK);
    assert.equal(ending.threeThings.length, 3, '和平局三件事应非空');
    const joined = ending.threeThings.map((t) => t.text).join('；');
    assert.ok(joined.includes('帮过人'), `文案应含人话动词：${joined}`);
    assert.ok(joined.includes('送走过人'), '重事（送别）应上榜');
    assert.ok(!joined.includes('listen_radio'), '琐事不上榜');
    assert.ok(!joined.includes(' · '), `文案不得是裸 id 拼接：${joined}`);
  });
});

describe('B-4 叙事不认生名（id 守门）', () => {
  test('humanFacts：fact 值里的 id 就地换成中文名', () => {
    const { state } = newRun({ seed: 3, roster: ['marta', 'emil', 'pavel'] });
    const h = humanFacts(state, PACK, [
      { k: 'franko_left', char: 'franko' },
      { k: 'eat', char: 'emil', item: 'raw' },
      { k: 'death', char: 'emil', cause: '崩溃离队' }
    ]);
    assert.equal(h[0].char, '鲁舟');
    assert.equal(h[1].char, '老甑');
    assert.equal(h[1].item, '糙米');
    assert.equal(h[2].char, '老甑');
  });

  test('narrationLint：西文串、音译名与野标记都拦，合规放行', () => {
    assert.ok(narrationLint('夜里没有人来敲门。Franko走了。', PACK).includes('西文串泄漏'));
    assert.ok(narrationLint('这样的安静 sometimes 更冷。', PACK).includes('西文串泄漏'));
    assert.ok(narrationLint('渡口的弗兰科要来了，船牙的货正靠岸。', PACK).includes('内部代号音译'), '纯中文音译也拦（二验证局实测漏网）');
    assert.ok(narrationLint('埃米尔是傍晚走的，没有告别。', PACK).includes('内部代号音译'));
    assert.ok(narrationLint('鲁舟的船靠在渡口边。', PACK).length === 0, '正名放行');
    assert.ok(narrationLint('[[江陵|江陵]]仓曹易人，墨迹新。', PACK).length > 0, '野标记应被拦');
    assert.deepEqual(narrationLint('[[地|江陵]]的米价又涨了。', PACK), [], '合规标记放行');
    assert.deepEqual(narrationLint('他把碗底最后一口咽了。', PACK), []);
  });

  test('memoirLint/biographyLint 拒收西文串', () => {
    const story = { days: 45, epilogues: [
      { id: 'marta', name: '辛夷', timeline: [{ day: 3 }] },
      { id: 'pavel', name: '阿走', timeline: [{ day: 4 }] }
    ] };
    assert.equal(memoirLint('Franko 走了之后，辛夷与阿走把第 3 天的日子翻来覆去地讲，讲成了一段谁也不肯先放下的账。'.repeat(2), story, PACK), false);
    assert.equal(biographyLint('辛夷的第 3 天：Franko 的船走了，她还在排队，队伍排到坊门，她把每个名字都记下。'.repeat(2), story.epilogues[0], story), false);
  });
});

describe('C-2 堂屋结局拍不连场重样', () => {
  test('全链路跑 10 天：连续同类场的结局拍不同', () => {
    let cur = newRun({ seed: 11, roster: ['marta', 'emil', 'pavel'] }).state;
    for (let d = 0; d < 10; d++) cur = skipDayAtHome(cur);
    const scenes = cur.ensemble?.scenes || [];
    assert.ok(scenes.length >= 3, `应有足量堂屋场（实际 ${scenes.length}）`);
    const pools = PACK.ensembleTemplates?.beats || {};
    for (let i = 1; i < scenes.length; i++) {
      const a = scenes[i - 1], b = scenes[i];
      if (a.kind === b.kind && (pools[a.kind]?.length || 0) > 1) {
        assert.notEqual(a.outcome.beat, b.outcome.beat, `第${a.day}天与第${b.day}天的 ${a.kind} 场结局拍重复`);
      }
    }
  });
});

describe('C-3 敲门卡池加厚', () => {
  test('新卡在牌堆里且要素齐全（内容包完整性）', () => {
    for (const id of ['n_washer', 'n_herbal', 'n_storyteller']) {
      const card = PACK.cardMap[id];
      assert.ok(card, `缺卡 ${id}`);
      assert.equal(card.kind, 'knock');
      assert.ok((card.options || []).length >= 2);
      assert.ok(card.text.length >= 40, '正文要有血肉');
      assert.ok(card.when.cooldown >= 10, '新卡冷却不过密');
    }
    const knocks = PACK.cards.filter((c) => c.kind === 'knock');
    assert.ok(knocks.length >= 9, '敲门池应显著加厚');
  });
});

describe('C-4 野标记语法守门', () => {
  test('markerSyntaxErrors：[[名|名]] 式野标记被抓，七类标记放行', () => {
    assert.deepEqual(markerSyntaxErrors('[[江陵|江陵]]仓曹易人'), ['[[江陵|江陵]]']);
    assert.deepEqual(markerSyntaxErrors('[[地|江陵]]的露布'), []);
    assert.deepEqual(markerSyntaxErrors('[[要|这份账要有人付]]'), []);
    assert.deepEqual(markerSyntaxErrors('[[府库|府库]]门闭'), ['[[府库|府库]]']);
    assert.deepEqual(markerSyntaxErrors('没有标记的正文'), []);
  });
});

describe('增强：抑郁可感、商人可见', () => {
  test('dawnProblems：抑郁档（未崩溃）也有晨报警讯', () => {
    const { state } = newRun({ seed: 3, roster: ['marta', 'emil', 'pavel'] });
    ch(state, 'marta').moodPts = -12;
    const probs = dawnProblems(state, PACK);
    assert.ok(probs.some((p) => p.text.includes('辛夷') && p.text.includes('陪')), '抑郁应有"多陪说话"警讯');
  });

  test('suggests：鲁舟靠岸且有建议成交时，白天建议行出现换货入口', () => {
    const { state } = newRun({ seed: 3, roster: ['marta', 'emil', 'pavel'] });
    state.franko = { merchant: 'franko', stock: [{ item: 'canned', n: 2, buy: 5 }] };
    state.inventory.jewel = 2; state.inventory.canned = 0; state.inventory.raw = 0; state.inventory.meal = 0;
    assert.ok(suggests(state, PACK).some((s) => s.label.startsWith('跟鲁舟换')), '建议行应有换货入口');
  });
});
