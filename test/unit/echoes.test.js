// 跨周目回响单元测试（长线体验-v0.2 EC-01~03 + 史册格）：echoes.js 纯函数路径
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../packages/server/db.js';
import { applyMigrations } from '../../packages/server/migrate.js';
import { collectEchoes, archiveOutcome, closureStatus, composeMemoirBook } from '../../packages/server/echoes.js';
import { loadPack } from '../../packages/core/index.js';

let db, dir;
const UID = 1;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'twom-echoes-'));
  applyMigrations(join(dir, 'game.db'));
  db = new Db(join(dir, 'game.db'));
});
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function endedState({ type = 'ceasefire', annals = [], fallen = [], wishFulfilled = false } = {}) {
  return {
    day: 45,
    chars: [
      { id: 'anton', name: '文简', alive: true },
      { id: 'marta', name: '辛夷', alive: false },
      ...fallen
    ].filter((c, i, a) => a.findIndex((x) => x.id === c.id) === i),
    docsSeen: ['#014'], knowledge: 5,
    eventFlags: wishFulfilled ? { wish_fulfilled: true } : {},
    ending: { type, threeThings: [], storyline: { annals, title: '开城' }, memoir: null }
  };
}

describe('史册格与回响入档（archiveOutcome）', () => {
  test('野史页入馆：annal 以结局类型为键', () => {
    archiveOutcome(db, UID, 'run_a1', endedState({ type: 'maicheng', annals: [{ ending: 'maicheng', text: '羽自麦城走房陵。', note: '批注' }] }));
    const a = db.archiveAll(UID).find((e) => e.kind === 'annal');
    assert.ok(a, '野史入档');
    assert.equal(a.key, 'maicheng');
    assert.match(a.data.text, /走房陵/);
  });

  test('出江陵记 → 商路回响入档，新局装配出 dark 第一眼', () => {
    archiveOutcome(db, UID, 'run_a2', endedState({ type: 'join_table' }));
    const echoes = collectEchoes(db, UID);
    assert.ok(echoes.joinTableDark, '鲁舟认出你');
    assert.ok(echoes.wish, '上一局死了辛夷 → 遗愿在办');
  });

  test('遗愿递减：三局未清偿 → 入档未完成', () => {
    collectEchoes(db, UID); // 剩 2
    collectEchoes(db, UID); // 剩 1
    collectEchoes(db, UID); // 剩 0
    collectEchoes(db, UID); // 过期
    const w = db.archiveAll(UID).find((e) => e.kind === 'wish');
    assert.equal(w.data.status, 'expired');
    assert.ok(!collectEchoes(db, UID)?.wish, '过期后不再装配');
  });

  test('遗愿兑现优先于生成；同局死亡+兑现不新开卡', () => {
    db.archivePut(UID, 'wish', 'old@run_x', { charId: 'marta', charName: '辛夷', text: '旧信', status: 'active', runsLeft: 2 }, 'run_x');
    archiveOutcome(db, UID, 'run_a3', endedState({ type: 'ceasefire', wishFulfilled: true, fallen: [{ id: 'bron', name: '石大', alive: false }] }));
    const wishes = db.archiveAll(UID).filter((e) => e.kind === 'wish');
    assert.ok(wishes.some((w) => w.data.status === 'fulfilled'), '旧卡兑现');
    // 兑现后这一局的新死亡开新卡（同时至多一张在办：兑现的那张已不在办）
    const active = wishes.filter((w) => w.data.status === 'active');
    assert.equal(active.length, 1, '新遗愿在办且仅一张');
    assert.equal(active[0].data.charId, 'marta'); // fallen[0] 是夹具里先倒下的辛夷
  });

  test('时间胶囊随装配进新局，全灭局不产生遗愿', () => {
    db.archivePut(UID, 'capsule', 'cap_t1', { item: 'wood', message: '给后来的人', itemName: '板材' }, 'run_a1');
    const echoes = collectEchoes(db, UID);
    assert.ok(echoes.capsules?.some((c) => c.key === 'cap_t1'), '胶囊进新局');
    const before = db.archiveAll(UID).filter((e) => e.kind === 'wish').length;
    archiveOutcome(db, UID, 'run_a4', endedState({ type: 'wiped', fallen: [{ id: 'bron', name: '石大', alive: false }] }));
    const after = db.archiveAll(UID).filter((e) => e.kind === 'wish').length;
    assert.equal(after, before, '全灭不新增遗愿');
  });
});

describe('合上兰台与回忆录成册（长线体验-v0.2 §3.6 / EX-01）', () => {
  const PACK = loadPack();
  const mkArch = (docsN) => {
    const es = [];
    for (let i = 0; i < docsN; i++) es.push({ kind: 'doc', key: `#t${i}`, data: {} });
    for (let i = 0; i < 10; i++) es.push({ kind: 'run_memory', key: `r${i}`, data: { ending: 'ceasefire', memoir: '第几天。' } });
    return es;
  };
  test('条件不齐不合：文档未满 / 缺还师 / 缺出江陵 / 回忆录不足', () => {
    const arch = mkArch(PACK.docs.length);
    assert.ok(!closureStatus(arch, PACK).available, '缺两个战争级结局不合');
    let seen = 0;
    const withEnds = arch.map((e) => {
      if (e.kind !== 'run_memory') return e;
      seen += 1;
      if (seen === 1) return { ...e, data: { ...e.data, ending: 'lighthouse' } };
      if (seen === 2) return { ...e, data: { ...e.data, ending: 'join_table' } };
      return e;
    });
    assert.ok(closureStatus(withEnds, PACK).available, '齐了才合');
    const thin = mkArch(PACK.docs.length - 1);
    assert.ok(!closureStatus(thin, PACK).available, '文档缺一份不合');
  });
  test('合上后存档留痕，装配出守望档', () => {
    db.archivePut(UID, 'closure', 'closed', { at: 't' }, null);
    assert.ok(closureStatus(db.archiveAll(UID), PACK).done);
    assert.ok(collectEchoes(db, UID)?.closureClosed, '守望档进新局');
  });
  test('成册：按时间装订，扉页有玩家名', () => {
    const book = composeMemoirBook([
      { kind: 'run_memory', at: '2026-10-02', data: { day: 45, memoir: '第二章的内容。' } },
      { kind: 'run_memory', at: '2026-10-01', data: { day: 30, memoir: '第一章的内容。' } },
      { kind: 'doc', key: '#014', data: {} }
    ], '测试者');
    assert.match(book, /《我的江陵》/);
    assert.match(book, /测试者/);
    assert.ok(book.indexOf('第一章') < book.indexOf('第二章'), '按时间排序');
    assert.ok(!book.includes('#014'), '文档不混进回忆录');
  });
});
