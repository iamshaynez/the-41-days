// 今日方略（闭合节奏）：白天选项 = 多人意图束 + 自动收卷（auto_day 殿后）。
// 点一个 ◇ 方略 = 这一天安排完并进入黄昏——不再一个一个选。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack, createRun, beginRun, fold } from '../../packages/core/index.js';
import { validateOptions } from '../../packages/server/options.js';

const PACK = loadPack();

function dayState() {
  const state = createRun(PACK, { seed: 51, roster: ['anton', 'marta', 'bron'] });
  beginRun(state, PACK, {});
  return state;
}

const RAW = {
  options: [
    { label: '文简守门，辛夷跟石大学认字', hint: '一天的门与一点指望',
      intents: [
        { type: 'act', actor: 'anton', action: 'guard' },
        { type: 'direction', subject: 'marta', text: '跟石大学认字' }
      ] },
    { label: '翻完家里，晚上交给自己', intents: [{ type: 'act', actor: 'bron', action: 'search_home' }, { type: 'auto_day' }] },
    { label: '全是不可行的', intents: [{ type: 'act', actor: 'nobody', action: 'guard' }] }
  ]
};

describe('今日方略（card=day 闭环）', () => {
  test('白天选项尾部自动补 auto_day 收卷；全不可行的走戏文轨不再被滤', () => {
    const out = validateOptions(PACK, dayState(), RAW, { card: 'day' });
    assert.equal(out.length, 3, '两个动作选项 + 一个戏文选项');
    for (const o of out.filter((x) => !x.stage)) {
      assert.equal(o.intents.at(-1).type, 'auto_day', `${o.label} 应以收卷结尾`);
      assert.equal(o.intents.filter((i) => i.type === 'auto_day').length, 1, '收卷不重复');
      assert.ok(o.hint.includes('入黄昏'), `hint 应交代收卷：${o.hint}`);
    }
    // 第二个：模型自带 auto_day 被收走重排，search_home 仍在最前
    assert.equal(out[1].intents[0].action, 'search_home');
    // 第三个：全不可行 → 戏文轨（scene 意图，不收卷）
    assert.ok(out[2].stage && out[2].intents[0].type === 'scene', '空壳动作的标签走戏文');
  });

  test('黄昏/夜间选项不收卷（世界的问题不越权）', () => {
    const out = validateOptions(PACK, dayState(), RAW, { card: 'dusk' });
    assert.ok(out.every((o) => o.intents.every((i) => i.type !== 'auto_day')));
    assert.ok(out.every((o) => !o.hint.includes('入黄昏')));
  });

});

import { resolveInput } from '../../packages/core/index.js';
import { newRun, step } from '../helpers.js';

describe('方略执行（内核侧）', () => {
  test('点方略 → 自动收卷 → 相位入夜线（dusk）', () => {
    const { state } = newRun({ seed: 52, roster: ['anton', 'marta', 'bron'] });
    const plan = [
      { type: 'act', actor: 'anton', action: 'guard' },
      { type: 'direction', subject: 'marta', text: '跟石大学认字' },
      { type: 'auto_day' }
    ];
    const r = resolveInput(state, PACK, plan);
    assert.equal(r.state.phase, 'dusk', `应收卷入黄昏（实际 ${r.state.phase}）`);
    assert.ok(r.facts.some((f) => f.k === 'direction_set'), '念头种下');
    assert.ok(r.facts.some((f) => f.k === 'phase_dusk'), '入黄昏');
  });
});

import { cardBrief, nightMenu } from '../../packages/server/options.js';
import { worldBrief } from '../../packages/server/narrate.js';
import { feasibleIntent } from '../../packages/core/index.js';

describe('夜访可行域（夜间选项没词的根因修复）', () => {
  test('夜访卡面语境给出当前房间的容器/房间/NPC id', () => {
    const state = createRun(PACK, { seed: 61, roster: ['anton', 'marta', 'bron'] });
    beginRun(state, PACK, {});
    // 直接进夜访：villas 第一房
    state.phase = 'night';
    state.night = { locId: 'villas', room: 'v_house1', slots: 8, noise: 0, gear: [], pack: [], unlocked: {}, cleared: {}, sawed: {}, packSlots: 0, lowSlotsAck: false, observed: {} };
    const brief = cardBrief(state, PACK, 'night');
    assert.ok(brief.includes('整夜方针'), '应带方针口径');
    assert.ok(brief.includes(nightMenu(state, PACK).slice(0, 6)) || /可搜容器|可去房间|无目标/.test(brief), '应带现场信息');
    const menu = nightMenu(state, PACK);
    assert.ok(/search@id/.test(menu) || /可去房间/.test(menu), `菜单应给可搜容器或可去房间：${menu}`);
    assert.ok(/observe|retreat/.test(menu), '无目标动作要列出');
  });

  test('build 满级被滤（床满 4 张不再出「再建床」——内核会拒 MAX）', () => {
    const state = createRun(PACK, { seed: 62, roster: ['anton', 'marta', 'bron'] });
    beginRun(state, PACK, {});
    state.inventory.wood = 20; state.inventory.parts = 20;
    state.facilities.bed = 4; // 已满
    assert.ok(!feasibleIntent(state, PACK, { type: 'act', actor: 'anton', action: 'build', target: 'bed' }), '满级不可建');
    state.facilities.bed = 2;
    assert.ok(feasibleIntent(state, PACK, { type: 'act', actor: 'anton', action: 'build', target: 'bed' }));
  });
});

import { normalizeIntent, applySceneEffects } from '../../packages/core/index.js';

describe('宽进严出：意图归一化', () => {
  test('中文角色/地点/物品翻成 id，已是 id 的不动', () => {
    const { state } = newRun({ seed: 71, roster: ['anton', 'marta', 'bron'] });
    state.phase = 'dusk';
    const it = normalizeIntent(state, PACK, { type: 'dusk_assign', scavenger: '文简', location: '南市', gear: ['铁撬'], others: { 辛夷: 'sleep' } });
    assert.equal(it.scavenger, 'anton');
    assert.equal(it.location, 'market');
    assert.deepEqual(it.gear, ['crowbar']);
    assert.deepEqual(it.others, { marta: 'sleep' });
    const it2 = normalizeIntent(state, PACK, { type: 'dusk_assign', scavenger: 'anton', location: 'market', gear: [], others: {} });
    assert.equal(it2.scavenger, 'anton');
  });
});

describe('戏文轨（scene 意图 + 微效果）', () => {
  test('scene 意图：零机械变化、落 fact、fold 一致', () => {
    const { state, events } = newRun({ seed: 72, roster: ['anton', 'marta', 'bron'] });
    const r = resolveInput(state, PACK, [{ type: 'scene', text: '给文简留半盏灯' }]);
    assert.ok(r.facts.some((f) => f.k === 'scene_request' && f.text === '给文简留半盏灯'));
    const rebuilt = fold([...events, ...r.events]);
    assert.equal(rebuilt.day, r.state.day, '零机械变化，回放一致');
  });

  test('微效果白名单：合法落地，越带整份拒', () => {
    const { state } = newRun({ seed: 73, roster: ['anton', 'marta', 'bron'] });
    const ok = applySceneEffects(state, PACK, { mood_char: { name: '文简', n: -1 }, seed: { subject: null, text: '把灯留在窗台上' } });
    assert.ok(ok.ok, JSON.stringify(ok.reasons));
    assert.equal(state.chars.find((c) => c.id === 'anton').moodPts, 1); // 2 - 1
    assert.ok(Object.values(state.directions)[0]?.text.includes('灯'));
    const bad = applySceneEffects(state, PACK, { mood_all: 3 });
    assert.ok(!bad.ok);
    const bad2 = applySceneEffects(state, PACK, { reputation: { key: 'emperor', n: 1 } });
    assert.ok(!bad2.ok);
  });

  test('validateOptions 戏文逃生门：全不可行的选项不再被滤，标 stage', async () => {
    const { validateOptions } = await import('../../packages/server/options.js');
    const { state } = newRun({ seed: 74, roster: ['anton', 'marta', 'bron'] });
    const out = validateOptions(PACK, state, { options: [
      { label: '在门楣上刻一道痕', hint: '给数日子的人', intents: [] },
      { label: '让文简守夜', intents: [{ type: 'act', actor: 'anton', action: 'guard' }] }
    ] }, { card: 'day' });
    const stage = out.find((o) => o.stage);
    assert.ok(stage, '空意图选项应走戏文轨');
    assert.deepEqual(stage.intents, [{ type: 'scene', text: '在门楣上刻一道痕——给数日子的人' }]);
    assert.ok(!stage.hint.includes('入黄昏'), '戏文不收卷');
    const act = out.find((o) => !o.stage);
    assert.ok(act.intents.at(-1).type === 'auto_day', '动作选项照常收卷');
  });
});

describe('夜访语境的真话：只说今晚在外的人', () => {
  test('夜间 id 对照只列外出者 + 本地 NPC；卡面明说队友不在', () => {
    const state = createRun(PACK, { seed: 81, roster: ['anton', 'marta', 'bron'] });
    beginRun(state, PACK, {});
    state.phase = 'night';
    state.night = { locId: 'market', room: 'front', charId: 'anton', slots: 8, noise: 0, gear: [], pack: [], unlocked: {}, cleared: {}, sawed: {}, packSlots: 0, lowSlotsAck: false, observed: {} };
    const brief = cardBrief(state, PACK, 'night');
    assert.ok(brief.includes('今晚在外的只有 文简（anton）一人'), '应明说独行');
    assert.ok(brief.includes('不许出现在选项里'), '应禁止队友出场');
    // id 对照的角色段只含 anton，不含队友
    const roleLine = brief.split('\n').find((l) => l.startsWith('角色：'));
    assert.ok(roleLine.includes('anton') && !roleLine.includes('marta') && !roleLine.includes('bron'), `角色段应只有外出者：${roleLine}`);
    // 世界简报也带独行者的名字
    assert.ok(worldBrief(state, PACK).includes('文简独行'), '简报应写明谁在夜路上');
  });
});

describe('夜间方针（宏观模式：一次决策，整夜自走）', () => {
  test('谨慎方针：走完整夜回到天亮，岔路自动决策且确定性', () => {
    const { state } = newRun({ seed: 91, roster: ['anton', 'marta', 'bron'] });
    let s = state;
    s = step(s, [{ type: 'advance' }]).state;
    s = step(s, [{ type: 'dusk_assign', scavenger: 'anton', location: 'market', gear: ['crowbar'], others: {} }]).state;
    assert.equal(s.phase, 'night');
    const r = step(s, [{ type: 'night_directive', stance: 'cautious', text: '不出声，见人就绕' }]);
    const st = r.state;
    assert.ok(st.day === 2 || st.phase === 'day' || st.phase === 'dawn', `整夜应走完（实际 第${st.day}天 ${st.phase}）`);
    assert.ok(r.facts.some((f) => f.k === 'night_directive_set'), '落方针 fact');
    assert.ok(r.facts.some((f) => f.k === 'night_choice'), '岔路按方针自动决策');
    assert.ok(!st.night || st.night.home || st.phase === 'day', '夜里的事了结干净');
    // 确定性：同种子重跑逐字节一致
    const r2 = step(step(step(state, [{ type: 'advance' }]).state, [{ type: 'dusk_assign', scavenger: 'anton', location: 'market', gear: ['crowbar'], others: {} }]).state, [{ type: 'night_directive', stance: 'cautious', text: '不出声，见人就绕' }]);
    assert.equal(JSON.stringify(r2.state.night), JSON.stringify(st.night));
  });

  test('截断收尾：长标签在标点处断，不出残句', async () => {
    const { validateOptions } = await import('../../packages/server/options.js');
    const { state } = newRun({ seed: 92, roster: ['anton', 'marta', 'bron'] });
    const out = validateOptions(PACK, state, { options: [
      { label: '派一个腿脚利索的人整夜盯着渡口来的生人，看清他跟谁接头、货往哪里去，天亮前回来报个准信', hint: '费一晚的脚力，但能换来一句准话', intents: [] },
      { label: '让文简守夜', intents: [{ type: 'act', actor: 'anton', action: 'guard' }] }
    ] }, { card: 'day' });
    const stage = out.find((o) => o.stage);
    assert.ok(stage.label.length <= 41);
    assert.ok(!/[，、]$/.test(stage.label) || stage.label.endsWith('……'), `标签不该以残逗号结尾：${stage.label}`);
    assert.ok(stage.label.endsWith('。') || stage.label.endsWith('……'), `应在句点或省略号收尾：${stage.label}`);
  });
});
