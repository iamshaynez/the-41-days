// 二周目实测反馈批次二验收（报告：out/中立向完整实录与体验报告-2026-10-13.md）
// 每条断言对应报告里一个可复现的问题——测试用游戏业务语言命名。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRun, resolveInput, planDusk, planDay, dawnProblems, suggests, buildEnding, fold, loadPack } from '../../packages/core/index.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { narrationLint, humanFacts } from '../../packages/server/narrate.js';

const pack = loadPack(join(dirname(fileURLToPath(import.meta.url)), '../../content/base'));

function newRun(over = {}) {
  return createRun(pack, { seed: 20261013, prologue: false, roster: ['bron', 'zofia', 'vera'], ...over });
}
const food0 = (s) => { for (const k of ['meal', 'canned', 'raw', 'meat', 'veg']) delete s.inventory[k]; };

/* ════════ A-2 回放一致性：WAR_ENDED 须带军心铰链，fold 可还原 ════════ */
test('A-2 终局铰链入事件流：fold 重放后 armyHeld/leverHad 与实况一致', () => {
  let s = newRun();
  s.day = 41; s.dissolve = 3; // 军心未散
  s.eventFlags.alt_plea = true;
  s.phase = 'night'; s.night = { home: true };
  const r = resolveInput(s, pack, [{ type: 'advance' }]);
  assert.equal(r.state.war.ended, true);
  assert.equal(r.state.war.endingType, 'hostage');
  assert.equal(r.state.war.armyHeld, true, '军心未散应记入 war');
  const warEv = r.events.find((e) => e.t === 'WAR_ENDED');
  assert.ok(warEv && warEv.d.armyHeld === true && warEv.d.leverHad === false, 'WAR_ENDED 事件须携带铰链读数');
  const rebuilt = fold(r.events);
  assert.equal(rebuilt.war.armyHeld, r.state.war.armyHeld);
  assert.equal(rebuilt.war.leverHad, r.state.war.leverHad);
});

/* ════════ A-3 协防承诺：选了协防，当晚出不了门 ════════ */
test('A-3 协防之夜：黄昏方案不再给出门选项', () => {
  const s = newRun();
  s.assistTonight = true;
  const view = planDusk(s, pack);
  assert.ok(view.plans.length, '至少有守家方案');
  assert.ok(view.plans.every((p) => p.key === 'stay'), '协防夜只能守家');
  assert.match(view.plans[0].hint, /邻居/, 'hint 要说清原因');
});
test('A-3 协防之夜：硬闯出门会被降级为在家过夜，不卡阶段', async () => {
  let s = newRun();
  s.phase = 'dusk';
  s.assistTonight = true;
  const r = resolveInput(s, pack, [{ type: 'dusk_assign', scavenger: 'bron', location: 'market', gear: [], others: { bron: 'sleep', zofia: 'sleep', vera: 'guard' } }]);
  assert.ok(!r.rejects.some((x) => x.reason === 'ASSIST_NIGHT'), '不靠拒绝实现——降级无声发生');
  assert.ok(r.state.night?.home, '夜在家开始（答应了替邻居守门）');
  assert.ok(r.facts.some((f) => f.k === 'assist_night'), '落一条事实供叙事承接');
});

/* ════════ A-1 夜访事实带人名：叙事者不再拿商人顶包 ════════ */
test('A-1 夜访收工事实带夜访者：night_end 必须点名谁走的这一夜', () => {
  let s = newRun();
  s.phase = 'dusk';
  const r1 = resolveInput(s, pack, [{ type: 'dusk_assign', scavenger: 'zofia', location: 'market', gear: [], others: { bron: 'sleep', zofia: 'sleep', vera: 'guard' } }]);
  const r2 = resolveInput(r1.state, pack, [{ type: 'night_directive', stance: 'normal', text: '照常走一遭，够用就回' }]);
  const facts = r2.facts.filter((f) => f.k === 'night_end');
  assert.ok(facts.length, '有收工事实');
  assert.equal(facts[0].char, 'zofia', '收工事实点名夜访者（humanFacts 会转成素徽）');
});

/* ════════ B-1 辛夷硬编码：通用卡结果文本走 {{names}} ════════ */
test('B-1 说书人卡结果不再出现不在队的名字', () => {
  const card = pack.cardMap.n_storyteller;
  assert.ok(!JSON.stringify(card).includes('辛夷'), '通用卡不得写死任何角色名');
  assert.ok(JSON.stringify(card).includes('{{names}}'), '应用名单占位符');
});
test('B-1 事件结果文本的 {{names}} 在结算时被替换', () => {
  let s = newRun();
  s.phase = 'day';
  s.activeEvent = { cardId: 'n_storyteller' };
  const r = resolveInput(s, pack, [{ type: 'event_choice', option: 'listen' }]);
  const t = r.facts.filter((f) => f.k === 'event_text').map((f) => f.text).join('');
  assert.ok(!t.includes('{{'), '占位符要被真实名单替换');
});

/* ════════ B-2 守门扩容：时代词/繁体/半角标点 ════════ */
test('B-2 叙事守门拦现代器物与文字规范问题', () => {
  assert.ok(narrationLint('他打开手电，光柱扫过米缸。', pack).length, '拦手电');
  assert.ok(narrationLint('电报线在远处断了又接。', pack).length, '拦电报');
  assert.ok(narrationLint('远处开枪的声音。', pack).length, '拦开枪');
  assert.ok(narrationLint('她盯着門缝里的雨。', pack).length, '拦繁体');
  assert.ok(narrationLint('他吃完了,又喝了一口水。', pack).length, '拦半角逗号');
  assert.equal(narrationLint('他把碗底刮干净了，没有说话。', pack).length, 0, '正常文本不误伤');
});

/* ════════ B-3 选择→回应断链：卡面结算事实带上下文 ════════ */
test('B-3 选项结算落 card_resolved 事实：卡题、选项、结果文本三件套', () => {
  let s = newRun();
  s.phase = 'day';
  s.activeEvent = { cardId: 'v_deserter' };
  const r = resolveInput(s, pack, [{ type: 'event_choice', option: 'refuse' }]);
  const f = r.facts.find((x) => x.k === 'card_resolved');
  assert.ok(f, '结算事实存在');
  assert.equal(f.card, '奇访：逃兵');
  assert.equal(f.option, '让他去别处');
  assert.ok(f.result && f.result.length > 4, '结果文本随行——叙事者有料可接');
});

/* ════════ B-4 管家无米开炊 ════════ */
test('B-4 无粮之日管家不排炊事：没得做就不安排', () => {
  const s = newRun();
  food0(s);
  const planned = planDay(s, pack);
  assert.ok(!planned.some((i) => i.action === 'cook'), '无米不排做饭');
  assert.ok(!planned.some((i) => i.action === 'eat'), '无米不排吃饭');
});
test('B-4 生食被直吃后，规划器不再安排第二锅空灶', () => {
  const s = newRun();
  food0(s);
  s.inventory.raw = 1; // 只剩一份生粮
  s.chars.forEach((c) => { c.hunger = 1; }); // 人人真饿（省粮口径下会直吃）
  const planned = planDay(s, pack);
  const eats = planned.filter((i) => i.action === 'eat');
  const cooks = planned.filter((i) => i.action === 'cook');
  assert.ok(eats.length >= 1, '饿人先吃');
  assert.equal(cooks.length, 0, '那份生粮已经进了嘴，不该再有一锅空灶');
});

/* ════════ C-3/C-5 晨报：代词、存粮口径、复读衰减 ════════ */
test('C-3 晨报用名字不用代词', () => {
  const s = newRun();
  s.chars.find((c) => c.id === 'vera').moodPts = -10; // 薄姑抑郁（depressed 档 ≤ -9）
  const problems = dawnProblems(s, pack);
  const p = problems.find((x) => x.text.includes('情绪很低落'));
  assert.ok(p, '有情绪预警');
  assert.ok(!/陪他|陪她/.test(p.text), '不用代词');
  assert.ok(p.text.includes('薄姑'), '点名到人');
});
test('C-3 慢性问题连日报时会衰减换措辞，不无限复读同一句', () => {
  const s = newRun();
  s.facilities.stove = 1; // 走 chronic 路径（无灶提示是另一条硬警讯，不衰减）
  food0(s); s.inventory.raw = 1; // 存粮只够一两顿
  const first = dawnProblems(s, pack).find((x) => x.text.includes('存粮'));
  assert.ok(first, '第一天照报');
  // 模拟连报四天后的状态
  s.problemStreak = { 'food_low': 4 };
  const later = dawnProblems(s, pack).filter((x) => x.text.includes('存粮'));
  assert.ok(later.length === 0 || later.every((x) => x.text !== first.text), '连报多日后不再原句复读');
});
test('C-5 存粮条目报具体份数与嘴数', () => {
  const s = newRun();
  food0(s); s.inventory.meal = 2;
  const p = dawnProblems(s, pack).find((x) => x.text.includes('存粮'));
  assert.ok(p && /2\s*份/.test(p.text), '带上具体份数');
});

/* ════════ 体验6：开饭一键 ════════ */
test('体验6 有饿者有粮时，建议行给出「开饭」一键（喂饱+收卷）', () => {
  const s = newRun();
  food0(s); s.inventory.meal = 3;
  s.chars.forEach((c) => { c.hunger = 1; });
  const sugg = suggests(s, pack);
  const meal = sugg.find((x) => x.label.startsWith('让挨饿的'));
  assert.ok(meal, '有开饭建议');
  assert.ok(meal.intents.some((i) => i.action === 'eat'), '含吃饭意图');
  assert.ok(meal.intents.some((i) => i.type === 'auto_day'), '饭后收卷这一天');
});

/* ════════ C-2 卡池降重 ════════ */
test('C-2 同一张敲门卡一局至多出场两次，出场过的卡权重打折', async () => {
  const { cardAllowedInPool } = await import('../../packages/core/src/vitals.js');
  const s = newRun();
  s.cardCount = { n_thugs: 2 };
  assert.equal(cardAllowedInPool(s, pack.cardMap.n_thugs), false, '来过两回的卡不再入池');
  s.cardCount = { n_thugs: 1 };
  assert.equal(cardAllowedInPool(s, pack.cardMap.n_thugs), true, '来过一回还能再来');
});

/* ════════ C-6 ending.title ════════ */
test('C-6 终局对象带 title 字段（API 语义自足）', () => {
  let s = newRun();
  s.day = 41; s.dissolve = 30;
  s.phase = 'night'; s.night = { home: true };
  const r = resolveInput(s, pack, [{ type: 'advance' }]);
  assert.ok(r.state.over);
  assert.equal(r.state.ending.title, '第四十一天');
});

/* ════════ ME-1 军心溶解账扩容（内容断言） ════════ */
test('ME-1 收留逃兵/协防邻里接进军心账（dissolve 数值在卡上）', () => {
  const v = pack.cardMap.v_deserter;
  const shelter = v.options.find((o) => o.key === 'shelter');
  assert.ok(shelter.effects.dissolve > 0, '收留逃兵会溶解军心——没有干净的手');
  const n = pack.cardMap.n_thugs;
  const help = n.options.find((o) => o.key === 'help');
  assert.ok(help.effects.dissolve > 0, '替邻里守夜也在替新政权安民');
});

/* ════════ ME-2 大事步个性化回声 ════════ */
test('ME-2 回师那天，拒过逃兵的家会听到点名自己的回声', () => {
  let s = newRun();
  // 前序步已烧（一日一步；直接把 m1~m6 记为已发生，让 D14 轮到回师步）
  for (const id of ['m1_flag', 'm2_visit', 'm3_fire', 'm4_yujin', 'm5_cannon', 'm6_envoy']) s.firedOnce['ml_' + id] = true;
  s.day = 13; s.phase = 'dusk';
  s.activeEvent = { cardId: 'v_deserter' };
  const r1 = resolveInput(s, pack, [{ type: 'event_choice', option: 'refuse' }]);
  s = r1.state;
  s.day = 13; s.phase = 'night'; s.night = { home: true }; // 破晓后即 D14——回师步的窗口日
  const r2 = resolveInput(s, pack, [{ type: 'advance' }]);
  const step = r2.events.find((e) => e.t === 'MAINLINE_STEP' && e.d.stepId);
  assert.ok(step, 'D14 有大事步');
  assert.equal(step.d.stepId, 'm7_return', '轮到回师步');
  assert.ok(step.d.echo && step.d.echo.length > 6, '回师步带个性化回声');
  assert.ok(r2.facts.some((f) => f.k === 'mainline_echo'), '回声作为事实进叙事轨');
});

/* ════════ C-1 堂屋收束拍窗口扩到三场 ════════ */
test('C-1 结局拍近三场不重样（内容池足够时）', async () => {
  const beats = pack.ensembleTemplates.beats.comment;
  assert.ok(beats.length >= 6, '评史拍池子扩容到 6+');
});

/* ════════ 体验9 知晓度里程碑 ════════ */
test('体验9 知晓度到 4 时晨报低声提一句（一次性）', () => {
  const s = newRun();
  s.knowledge = 4;
  const p1 = dawnProblems(s, pack).find((x) => x.text.includes('读得懂'));
  assert.ok(p1, '达标提示出现');
  s.knowledgeShown = [4];
  const p2 = dawnProblems(s, pack).find((x) => x.text.includes('读得懂'));
  assert.equal(p2, undefined, '同档只提一次');
});

/* ════════ B-2 fact 代号说明（叙事层） ════════ */
test('B-2 humanFacts 附注解释 telegraph 代号，禁止直译成器物', () => {
  const s = newRun();
  const out = humanFacts(s, pack, [{ k: 'war_telegraph', day: 1 }]);
  const note = out.find((f) => f.k === 'note');
  assert.ok(note && note.text.includes('telegraph'), '代号对照里有 telegraph 条目');
  assert.ok(note.text.includes('器物') || note.text.includes('动静'), '明确禁止具象化');
});
