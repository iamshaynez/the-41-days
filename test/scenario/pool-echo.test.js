// 池回声（城市扩展后续）：上一世没走完的路，这一世牵引复玩。
// 局终记下「没去成」（未入池 or 入池未访）→ 新局池选择偏向补缺 → 第 1 天以回声风闻上图。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, skipDayAtHome, PACK } from '../helpers.js';
import { createRun, mapView, missedPoolLocs, pickLocPools } from '../../packages/core/index.js';

/** 一局走完后的等价态：locPool 是本局浮出的两池 */
function endedState({ locPool, visits = [] }) {
  const st = newRun({ seed: 7 }).state;
  st.locPool = locPool;
  st.locState = {};
  for (const v of visits) st.locState[v] = { searched: {}, npcState: {}, scriptsFired: {}, firstVisit: false };
  return st;
}

describe('池回声 · 局终记账（没去成的才记）', () => {
  test('未入池的记为错过；入池却没去过的也记；去过的两种都不记', () => {
    // 南池开渔村（dockyard 落选）、北池开古冢（jiying 落选）；渔村去了、古冢没去
    const st = endedState({ locPool: { south: 'fishing', ruins: 'baling' }, visits: ['fishing'] });
    const missed = missedPoolLocs(st, PACK);
    assert.ok(missed.includes('dockyard'), '南池落选的军市记上');
    assert.ok(missed.includes('jiying'), '北池落选的故郢记上');
    assert.ok(missed.includes('baling'), '开了门却没去的古冢也记上');
    assert.ok(!missed.includes('fishing'), '去过的渔村不记');
    // 落选的排在前（那是连机会都没有的），开了门没去的排后
    assert.ok(missed.indexOf('dockyard') < missed.indexOf('baling'), '落选之憾重于失约');
  });

  test('旧档无池字段（0.29 存档）不炸、不算错过', () => {
    const st = endedState({ locPool: undefined, visits: [] });
    delete st.locPool;
    assert.deepEqual(missedPoolLocs(st, PACK), []);
  });
});

describe('池回声 · 新局偏置（缘分回来）', () => {
  test('上一世错过的，这一世池子确定性补上——换什么种子都补', () => {
    const echoes = { missedLocs: ['baling', 'dockyard'] };
    for (const seed of [3, 17, 41, 2026]) {
      const st = createRun(PACK, { seed, roster: ['anton', 'marta', 'bron'], echoes });
      assert.equal(st.locPool.ruins, 'baling', `种子 ${seed}：古冢回来了`);
      assert.equal(st.locPool.south, 'dockyard', `种子 ${seed}：军市回来了`);
    }
  });

  test('首局无回声：偏置不参与，同种子同池（旧行为原样）', () => {
    for (const seed of [3, 41]) {
      assert.deepEqual(pickLocPools(seed, PACK.manifest, null), pickLocPools(seed, PACK.manifest));
      const a = createRun(PACK, { seed, roster: ['anton', 'marta', 'bron'] });
      const b = createRun(PACK, { seed, roster: ['anton', 'marta', 'bron'] });
      assert.deepEqual(a.locPool, b.locPool);
    }
  });

  test('回声只认池内成员：脏数据（旧地点/不存在的地方）不掰池', () => {
    const st = createRun(PACK, { seed: 41, roster: ['anton', 'marta', 'bron'], echoes: { missedLocs: ['market', 'nonsense'] } });
    assert.equal(st.locPool.ruins, pickLocPools(41, PACK.manifest).ruins, '非池成员不参与偏置');
  });
});

describe('池回声 · 图上牵引（第 1 天就看得见）', () => {
  test('错过的古冢第 1 天以风闻上图，带旧梦提示；锁链照旧要走', () => {
    const st = createRun(PACK, { seed: 9, roster: ['anton', 'marta', 'bron'], echoes: { missedLocs: ['baling'] } });
    assert.equal(st.locPool.ruins, 'baling');
    const p = mapView(st, PACK).places.find((x) => x.id === 'baling');
    assert.equal(p.state, 'heard', '开局的古冢是风闻');
    assert.ok(p.hint && p.hint.length >= 8, '提示语在场（旧梦牵引）');
    assert.ok(!st.knownLocs.includes('baling'), '风闻≠能去');
    // 藏宝图链照旧：#064 + D18 晨间解锁
    st.day = 20; st.docsSeen.push('#064');
    let s = skipDayAtHome(st);
    s = step(s, [{ type: 'advance' }]).state;
    assert.ok(s.knownLocs.includes('baling'), '图到手，门照旧开');
  });

  test('没进池的回声不上图：错过且这一世仍无缘的，只在兰台里躺着', () => {
    const st = createRun(PACK, { seed: 9, roster: ['anton', 'marta', 'bron'], echoes: { missedLocs: ['jiying'] } });
    // 偏置后 ruins 开的是 jiying——所以它该风闻；再造一个「错过且仍落选」：south 落选者
    const southMissedAndOut = ['fishing', 'dockyard'].filter((id) => st.locPool.south !== id)[0];
    st.echoes.missedLocs = ['baling', southMissedAndOut];
    const mv = mapView(st, PACK);
    assert.equal(mv.places.find((x) => x.id === southMissedAndOut).state, 'unknown', '池外之地连旧梦都不显');
  });
});
