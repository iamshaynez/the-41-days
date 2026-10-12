// 命运弧（P2b）：弧选择 → 弧提案 → 黄昏驻场注入 → 玩家应答/路过 → 旗标入账全链。
// 铁律回归：LLM 只写皮肤，弧的包络（何时、何旗标、落何处）全在 ge.json 数据里。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGeDirector, currentArc } from '../../packages/server/ge.js';
import { loadPack, createRun, beginRun, resolveInput, fold } from '../../packages/core/index.js';

const PACK = loadPack();
const ARC = PACK.ge.arcs.find((a) => a.id === 'late_paper');
const DAY = 36; // late_paper 窗口 [34,42]

function runAt(day) {
  const state = createRun(PACK, { seed: 9, roster: ['anton', 'marta', 'bron'] });
  beginRun(state, PACK, {});
  state.day = day;
  state.war.telegraphed = true;
  return state;
}

/** 弧提案桩：正文动态引用锚池里的真实角色（锚引用断言），旗标走弧白名单 */
const arcStub = (state) => ({
  call: async ({ system }) => {
    const m = system.match(/# 当局锚池（只能从这里挑）\n(.+)/);
    const pool = (m?.[1] || '').split('、').filter(Boolean);
    const who = (pool.find((a) => a.startsWith('角色:')) || '').slice(3) || '有人';
    return {
      text: JSON.stringify({
        title: '一页写着你家名字的纸',
        theme: ARC.theme,
        arc: ARC.id,
        anchors: pool.slice(0, 2),
        text: `${who}在门缝里看见对面当铺的伙计把一页纸收进匣子。那页纸上有你们家的名字。`,
        options: [
          { label: '今晚摸黑去取回来', risk: true, flag: { fate_paper_chased: true } },
          { label: '用两份糙米赎回来', item_cost: { raw: 2 } },
          { label: '由它去', flag: { fate_paper_ignored: true } }
        ]
      })
    };
  }
});

const PROMPTS = { playwright: '# 当局锚池（只能从这里挑）\n{{anchors}}\n# 今日主题\n{{theme}}\n{{arc}}\n{{world}}' };

describe('弧选择（ge.json 数据驱动）', () => {
  test('第 36 天 → late_paper（高档位优先）；第 20 天 → two_children', () => {
    assert.equal(currentArc(PACK, runAt(DAY)).id, 'late_paper');
    assert.equal(currentArc(PACK, runAt(20)).id, 'two_children');
    assert.equal(currentArc(PACK, runAt(5)), null, '第 5 天无弧（微光卡照常）');
  });

  test('每局一次：烧掉后不再来（别的弧不受影响）', () => {
    const s = runAt(DAY);
    s.geArcsFired = { late_paper: 36 };
    assert.notEqual(currentArc(PACK, s)?.id, 'late_paper', '唯一黄昏弧已烧，不再指派');
  });
});

describe('黄昏驻场注入与路过', () => {
  test('白天预取 → 黄昏注入 duskFate；每局一次记账', async () => {
    const s = runAt(DAY);
    s.firedOnce = { a: 1, b: 1, c: 1, d: 1 }; // 开够全局占比预算
    const d = createGeDirector({ pack: PACK, prompts: PROMPTS, getProvider: () => arcStub(s) });
    await d.onTurn('r1', s); // 白天：预取
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!s.activeEvent, '白天不注入黄昏弧');
    s.phase = 'dusk'; // 玩家过了黄昏线
    await d.onTurn('r1', s);
    assert.ok(s.activeEvent?.cardId?.startsWith('ge_'), '黄昏注入');
    assert.equal(s.activeEvent.duskFate, true);
    assert.equal(s.geArcsFired[ARC.id], DAY, '注入即烧弧');
    d.drop('r1');
  });

  test('应答：选一 → 旗标入 eventFlags；路过：直接出门 → fate_passed，事件落幕', async () => {
    // 应答
    const s1 = runAt(DAY);
    s1.firedOnce = { a: 1, b: 1, c: 1, d: 1 };
    const d1 = createGeDirector({ pack: PACK, prompts: PROMPTS, getProvider: () => arcStub(s1) });
    await d1.onTurn('r2', s1);
    await new Promise((r) => setTimeout(r, 20));
    s1.phase = 'dusk';
    await d1.onTurn('r2', s1);
    const r = resolveInput(s1, PACK, [{ type: 'event_choice', option: 'g0' }]);
    assert.equal(r.state.eventFlags.fate_paper_chased, true, '旗标入账');
    assert.ok(!r.state.activeEvent);
    d1.drop('r2');

    // 路过：黄昏方案照常出门，命运不等人
    const s2 = runAt(DAY);
    s2.firedOnce = { a: 1, b: 1, c: 1, d: 1 };
    const d2 = createGeDirector({ pack: PACK, prompts: PROMPTS, getProvider: () => arcStub(s2) });
    await d2.onTurn('r3', s2);
    await new Promise((res) => setTimeout(res, 20));
    s2.phase = 'dusk';
    await d2.onTurn('r3', s2);
    const r2 = resolveInput(s2, PACK, [{ type: 'dusk_assign', scavenger: null, location: null, gear: [], others: {} }]);
    assert.ok(r2.facts.some((f) => f.k === 'fate_passed'), '路过也有 fact');
    assert.ok(!r2.state.activeEvent, '事件落幕');
    assert.equal(r2.state.eventFlags.fate_paper_chased, undefined, '路过的命运不落旗标');
    assert.equal(r2.state.day, DAY + 1, '夜照常过去（在家过夜即破晓）');
    // fold 镜像：EVENT_CHOSEN 落幕后回放一致
    const rebuilt = fold([...r2.events]);
    assert.ok(!rebuilt.activeEvent);
    d2.drop('r3');
  });
});
