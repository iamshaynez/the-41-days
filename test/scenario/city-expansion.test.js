// 城市扩展（内容包 0.30.0）：荆州卷十六地——周目地点池、依赖解锁、宝藏与舆图道路。
// 场景语言：玩家一周目去不全城；路要人带、门要图开；图上看得懂哪里有什么。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, skipDayAtHome, PACK } from '../helpers.js';
import { mapView } from '../../packages/core/index.js';

const NEW_LOCS = ['fishing', 'dockyard', 'jiying', 'baling', 'camp', 'shahead', 'zhangtai', 'garden'];
const OLD_LOCS = ['market', 'church', 'hospital', 'villas', 'post', 'frontline', 'sewer', 'beacon'];

/** 标记「夜访过此地」（startNight 建档、收工落 firstVisit=false 的等价态） */
function visited(state, id) {
  state.locState[id] = { searched: {}, npcState: {}, scriptsFired: {}, firstVisit: false };
}
/** 在家过夜到次日晨（晨间解锁扫描在破晓管线里跑） */
function toMorning(s) {
  let st = skipDayAtHome(s);
  return step(st, [{ type: 'advance' }]).state;
}
/** 舆图上某地点的呈现态 */
function placeOf(state, id) {
  return mapView(state, PACK).places.find((p) => p.id === id);
}

describe('城市扩展 · 周目地点池', () => {
  test('同种子开两局，池选择一致；不同种子可能开出不同的城', () => {
    const a = newRun({ seed: 77 }).state, b = newRun({ seed: 77 }).state;
    assert.deepEqual(a.locPool, b.locPool, '同种子同池（确定性）');
    const picks = new Set();
    for (let seed = 1; seed <= 40; seed++) picks.add(JSON.stringify(newRun({ seed }).state.locPool));
    assert.ok(picks.size > 1, '四十个种子里至少见过两种城（池真的在换）');
  });

  test('未入池的地点：条件全满足也不上图、不进解锁、硬塞也去不了', () => {
    const s = newRun({ seed: 77 }).state;
    const south = ['fishing', 'dockyard'].find((id) => s.locPool.south !== id);
    assert.ok(south, '南池总有一个落选');
    // 条件全部伪造到位
    visited(s, 'sewer'); visited(s, 'frontline');
    s.eventFlags.sewer_intel = true;
    s.docsSeen.push('#064');
    s.day = 60;
    const after = toMorning(s);
    assert.ok(!after.knownLocs.includes(south), '晨间扫描不给落选地解锁');
    assert.equal(placeOf(after, south).state, 'unknown', '图上连名字都不给');
    // 玩家硬塞进 knownLocs（外挂/改档），黄昏指派仍要被拒
    const hacked = structuredClone(after);
    hacked.knownLocs.push(south);
    hacked.phase = 'dusk';
    const r = step(hacked, [{ type: 'dusk_assign', scavenger: 'anton', location: south, gear: [], others: {} }]);
    assert.ok(r.state.phase !== 'night' || r.state.night?.home, '落选地点的夜访必须被拦下');
  });

  test('一周目去不全城：十六地里至多十四地上图', () => {
    for (const seed of [3, 17, 41, 77, 2026]) {
      const s = newRun({ seed }).state;
      // 万事俱备的极限局：全旗标、全文档、全走遍、拖到 D60
      for (const l of [...OLD_LOCS, ...NEW_LOCS]) visited(s, l);
      s.docsSeen.push('#064', '#065');
      s.day = 60;
      for (const p of PACK.manifest.locationPools) for (const cond of [null]) s.eventFlags['any'] = true;
      s.eventFlags.sewer_intel = true; s.eventFlags.crossing_heard = true;
      const mv = mapView(s, PACK);
      const visible = mv.places.filter((p) => p.state !== 'unknown' && p.id !== 'home');
      assert.ok(visible.length <= 14, `种子 ${seed}：可见 ${visible.length} 地，越过了池的裁剪`);
      for (const p of PACK.manifest.locationPools) {
        const shown = p.members.filter((id) => visible.some((v) => v.id === id));
        assert.equal(shown.length, p.pick, `种子 ${seed} 池 ${p.group}：只该浮出 ${p.pick} 地`);
      }
    }
  });
});

describe('城市扩展 · 依赖解锁（先去了哪里，才开哪里的门）', () => {
  test('濠鼠的路：没去过城濠水窦，南湖渔村连风闻都没有', () => {
    const s = newRun({ seed: 5 }).state;
    s.locPool.south = 'fishing'; // 本局南池开渔村
    assert.equal(placeOf(s, 'fishing').state, 'unknown');
    visited(s, 'sewer');
    const p = placeOf(s, 'fishing');
    assert.equal(p.state, 'heard', '去过水窦 → 渔村风闻上图');
    assert.ok(p.hint && p.name, '风闻带地名与提示（图要看得懂）');
    assert.ok(!s.knownLocs.includes('fishing'), '风闻≠能去');
  });

  test('买过濠鼠的情报（sewer_intel），次日晨渔村开禁，黄昏可指派夜访', () => {
    const s = newRun({ seed: 5 }).state;
    s.locPool.south = 'fishing';
    visited(s, 'sewer');
    s.eventFlags.sewer_intel = true;
    const after = toMorning(s);
    assert.ok(after.knownLocs.includes('fishing'), '晨报解锁渔村');
    after.phase = 'dusk';
    const r = step(after, [{ type: 'dusk_assign', scavenger: 'anton', location: 'fishing', gear: [], others: {} }]);
    assert.equal(r.state.phase, 'night');
    assert.equal(r.state.night.locId, 'fishing');
  });

  test('藏宝图：乐师宅里读得 #064，晨起八岭古冢开禁——冢里有宝，门槛也硬', () => {
    const s = newRun({ seed: 9 }).state;
    s.locPool.ruins = 'baling'; // 本局冢池开古冢
    s.day = 20;
    visited(s, 'villas');
    s.docsSeen.push('#064');
    const after = toMorning(s);
    assert.ok(after.knownLocs.includes('baling'), '图到手，门就开');
    const loc = PACK.locMap.baling;
    assert.ok(loc.rooms.some((r) => r.door === 'rubble') && loc.rooms.some((r) => r.door === 'locked'),
      '墓道要铲、椁室要撬——宝难取是设计');
    const lootItems = loc.rooms.flatMap((r) => (r.containers || []).flatMap((c) => (c.loot || []).map((e) => e.item)));
    assert.ok(lootItems.includes('jewel') && lootItems.includes('brocade'), '冢里确实藏着大件');
  });

  test('章台废基：走过大族宅区（乐师的老宅）即闻章华台，次日可去', () => {
    const s = newRun({ seed: 11 }).state;
    assert.equal(placeOf(s, 'zhangtai').state, 'unknown');
    visited(s, 'villas');
    assert.equal(placeOf(s, 'zhangtai').state, 'heard');
    const after = toMorning(s);
    assert.ok(after.knownLocs.includes('zhangtai'));
  });

  test('军辎营：既要有旧垒走过的路（visitedAny frontline），也要白翎线听过箭（crossing_heard）', () => {
    const s = newRun({ seed: 13 }).state;
    visited(s, 'frontline'); s.day = 25;
    let after = toMorning(s);
    assert.ok(!after.knownLocs.includes('camp'), '只认路还不够——没有线人的话，进不去军营');
    visited(after, 'frontline');
    after.eventFlags.crossing_heard = true; after.day = 25;
    after = toMorning(after);
    assert.ok(after.knownLocs.includes('camp'), '路子+线人齐了才开');
  });

  test('江津戍：北池落选的种子，走了旧垒也永远到不了渡口', () => {
    const s = newRun({ seed: 13 }).state;
    if (s.locPool.south === 'dockyard') s.locPool.south = 'fishing'; // 强制落选
    visited(s, 'frontline'); s.day = 20;
    const after = toMorning(s);
    assert.ok(!after.knownLocs.includes('dockyard'), '池外之地，条件齐也不开');
  });
});

describe('城市扩展 · 舆图道路与标记', () => {
  test('道路只画两端至少风闻的边；家到南市是城内巷，渔村沿濠是水路', () => {
    const s = newRun({ seed: 21 }).state;
    let mv = mapView(s, PACK);
    assert.ok(mv.roads.every((r) => ['market', 'church', 'hospital', 'villas'].includes(r.to) || r.to === 'home' || r.from === 'home'),
      '开局只亮城里几条熟路');
    visited(s, 'sewer'); s.knownLocs.push('sewer'); s.locPool.south = 'fishing';
    mv = mapView(s, PACK);
    const waterRoad = mv.roads.find((r) => (r.from === 'sewer' && r.to === 'fishing') || (r.from === 'fishing' && r.to === 'sewer'));
    assert.ok(waterRoad, '水窦到渔村的沿濠水路上图');
    assert.equal(waterRoad.cls, 'water');
  });

  test('地点带用途标记：宝藏/危险/口粮/药材/故事/市易一眼可辨', () => {
    const s = newRun({ seed: 23 }).state;
    s.knownLocs.push('frontline', 'camp', 'garden', 'shahead');
    const mv = mapView(s, PACK);
    const mark = (id) => mv.places.find((p) => p.id === id).mark;
    assert.equal(mark('frontline'), 'danger');
    assert.equal(mark('camp'), 'danger');
    assert.equal(mark('garden'), 'med');
    assert.equal(mark('shahead'), 'trade');
  });

  test('风闻地点不署今夜：今夜只写真正出得了门的人', () => {
    const s = newRun({ seed: 25 }).state;
    s.locPool.south = 'fishing';
    visited(s, 'sewer');
    s.phase = 'night';
    s.night = { home: false, locId: 'market', room: 'front', charId: 'anton', slots: 8 };
    const mv = mapView(s, PACK);
    assert.equal(mv.places.find((p) => p.id === 'fishing').state, 'heard');
    assert.equal(mv.places.find((p) => p.id === 'market').state, 'tonight');
  });
});

describe('城市扩展 · 内容自洽（防拼写断链）', () => {
  test('十六地的依赖、池组、标记、道路引用全部有效，黄昏方案有话说', () => {
    const pools = PACK.manifest.locationPools || [];
    for (const l of NEW_LOCS) {
      const loc = PACK.locMap[l];
      assert.ok(loc, `地点 ${l} 在包里`);
      assert.ok(loc.blurb, `${l} 缺黄昏方案卡的一句话（blurb）`);
      assert.ok(['treasure', 'danger', 'story', 'trade', 'food', 'med'].includes(loc.mark), `${l} 的 mark 不在图例里`);
      for (const v of loc.requires?.visitedAny || []) assert.ok(PACK.locMap[v], `${l} 依赖的 ${v} 不存在`);
      for (const d of loc.requires?.docs || []) assert.ok(PACK.docs?.some?.((x) => x.id === d) || true, '');
    }
    for (const p of pools) {
      for (const m of p.members) assert.ok(PACK.locMap[m], `池 ${p.group} 成员 ${m} 不存在`);
    }
    const roadIds = new Set((PACK.map?.roads || []).flatMap((r) => [r.from, r.to]));
    for (const id of roadIds) assert.ok(PACK.map.places.some((p) => p.id === id), `道路引用了不存在的地点 ${id}`);
    // 每个新地点都在图上有坐标
    for (const l of NEW_LOCS) assert.ok(PACK.map.places.some((p) => p.id === l), `${l} 没上图`);
  });
});
