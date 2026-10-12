// 锚池扩建（命运导演 P0a）：这一局的历史也是锚——事迹/声望/时局/真相/念头/话语。
// 锚池是 LLM 编剧唯一合法的素材来源（GE-04），历史进锚池 = 选项随进展而不同。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack, createRun, beginRun } from '../../packages/core/index.js';
import { anchorPool } from '../../packages/core/src/ge.js';

const PACK = loadPack();

function freshState(extra = {}) {
  const state = createRun(PACK, { seed: 7, roster: ['anton', 'marta', 'bron'] });
  beginRun(state, PACK, {});
  return Object.assign(state, extra);
}

describe('锚池：随游戏进展长出新的锚', () => {
  test('基础锚（天气/日期/角色/地点/设施）仍在', () => {
    const pool = anchorPool(PACK, freshState());
    assert.ok(pool.includes('天气:clear'));
    assert.ok(pool.includes('第1天'));
    assert.ok(pool.some((a) => a.startsWith('角色:')));
    assert.ok(pool.some((a) => a.startsWith('地点:')));
  });

  test('因果账里七天内的事迹成为锚', () => {
    const s = freshState({
      causality: {
        entries: [
          { i: 0, day: 1, verb: 'help', witnesses: [], weight: 2 },
          { i: 1, day: 1, verb: 'burn_book', witnesses: [], weight: 1 }
        ],
        pairArcs: {}, charArcs: {}
      }
    });
    const pool = anchorPool(PACK, s);
    assert.ok(pool.includes('事迹:帮过人'), `应含帮过人锚：${pool.join(' ')}`);
    assert.ok(pool.includes('事迹:烧过书'));
  });

  test('七天前的旧事不再当锚（旧事进回忆录，不进选题）', () => {
    const s = freshState({
      causality: { entries: [{ i: 0, day: 1, verb: 'help', witnesses: [], weight: 2 }], pairArcs: {}, charArcs: {} }
    });
    s.day = 12;
    const pool = anchorPool(PACK, s);
    assert.ok(!pool.includes('事迹:帮过人'));
  });

  test('声望到档成为锚（邻里念你们的好 / 记着你们的账）', () => {
    const s = freshState();
    s.reputation.church = 2;
    s.reputation.market = -2;
    s.reputation.neighbor = 1; // 不到档
    const pool = anchorPool(PACK, s);
    assert.ok(pool.includes('声望:里社念你们的好'));
    assert.ok(pool.includes('声望:南市记着你们的账'));
    assert.ok(!pool.some((a) => a.startsWith('声望:邻里')));
  });

  test('战争态势与已显形真相成为锚（措辞避开禁词）', () => {
    const s = freshState();
    s.war.telegraphed = true;
    s.seals = ['s1', 's2'];
    const pool = anchorPool(PACK, s);
    assert.ok(pool.includes('时局:炮声稀了'));
    assert.ok(pool.includes('真相:已显形2层'));
    for (const a of pool) for (const b of PACK.ge.bannedTerms) assert.ok(!a.includes(b), `锚 ${a} 含禁词 ${b}`);
  });

  test('活着的念头与玩家的话语成为锚', () => {
    const s = freshState();
    s.directions = { d1: { id: 'd1', subject: 'marta', text: '教她认字', day: 2, lastDay: 2, alive: true } };
    s.whispers = [{ day: 3, text: '我在渡口看见龙了' }];
    const pool = anchorPool(PACK, s);
    assert.ok(pool.includes('念头:辛夷·教她认字'));
    assert.ok(pool.includes('话语:我在渡口看见龙了'));
  });

  test('枯萎的念头不当锚', () => {
    const s = freshState();
    s.directions = { d1: { id: 'd1', subject: 'marta', text: '教她认字', day: 1, lastDay: 1, alive: false } };
    const pool = anchorPool(PACK, s);
    assert.ok(!pool.some((a) => a.startsWith('念头:')));
  });
});
