// 堂屋系统（人物血肉计划 PR2）：同住一屋檐的三个人，该有堂屋的戏。
// 铁律：内核裁决在前——谁进场、何话题、结局拍、心情与信任的微调，
// 全部在场景创建时定死（种子确定）；LLM 只写台词，挂了走直读拼装。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PACK, newRun, step, ch, skipDayAtHome } from '../helpers.js';

describe('堂屋：主线日必评史', () => {
  test('开局第一步（m_d01）次晨必得评史场，参与者全是活人', () => {
    const { state } = newRun({ seed: 3, roster: ['katya', 'marta', 'bron'] });
    const s = skipDayAtHome(state);
    assert.ok(s.ensemble?.scenes?.length >= 1, '次晨应有堂屋场');
    const sc = s.ensemble.scenes[0];
    assert.equal(sc.kind, 'comment');
    assert.equal(sc.topic.stepId, 'm1_flag');
    assert.ok(sc.participants.length >= 2, '至少两人说话');
    for (const p of sc.participants) assert.ok(ch(s, p).alive, `死人 ${p} 不得进场`);
  });

  test('主线步欠下必还：前九日四步全部评到', () => {
    const { state } = newRun({ seed: 5, roster: ['anton', 'marta', 'bron'] });
    let s = state;
    for (let i = 0; i < 9; i++) s = skipDayAtHome(s);
    for (const sid of ['m1_flag', 'm2_visit', 'm3_fire', 'm4_yujin']) {
      assert.ok(s.ensemble.coveredSteps.includes(sid), `${sid} 应有评史场`);
    }
  });
});

describe('堂屋：随机场（性格与关系驱动）', () => {
  test('暗账过阈 → 暗面场压过评史（夜的伤口比朝的新闻急）', () => {
    const { state } = newRun({ seed: 7, roster: ['anton', 'marta', 'bron'] });
    state.causality.shadowTouched = { anton: 2 };
    const before = ch(state, 'anton').moodPts;
    const s = skipDayAtHome(state);
    const sc = s.ensemble.scenes[0];
    assert.equal(sc.kind, 'shadow', `应是暗面场（实为 ${sc.kind}）`);
    assert.ok(sc.participants.includes('anton'), '被翻旧账的人必须在场');
    assert.ok((ch(s, 'anton').moodCounts?.堂屋 || 0) >= 1, '暗面被翻出来，心情要动');
    assert.ok(ch(s, 'anton').moodPts < before, '心情要落');
  });

  test('崩溃链上的人 → 交心场，有人陪', () => {
    const { state } = newRun({ seed: 11, roster: ['katya', 'marta', 'bron'] });
    const before = ch(state, 'katya').moodPts;
    ch(state, 'katya').moodPts = -14;
    const s = skipDayAtHome(state);
    const sc = s.ensemble.scenes[0];
    assert.equal(sc.kind, 'bond', `应是交心场（实为 ${sc.kind}）`);
    assert.ok(sc.participants.includes('katya'));
    assert.ok((ch(s, 'katya').moodCounts?.堂屋 || 0) >= 1, '交心的暖要入账');
    assert.ok(ch(s, 'katya').moodPts >= -14, '被陪的人不该更冷');
    assert.ok(before >= -14, '（前提自查：开局心情不该低于交心线）');
  });

  test('伦理差大的对子 → 争执场（江鳅×薄姑两种活法）', () => {
    let found = null;
    for (let seed = 1; seed <= 40 && !found; seed++) {
      const { state } = newRun({ seed, roster: ['danilo', 'vera', 'bron'] });
      let s = state;
      for (let d = 0; d < 12; d++) {
        s = skipDayAtHome(s);
        const sc = s.ensemble.scenes.find((x) => x.kind === 'friction'
          && x.participants.includes('danilo') && x.participants.includes('vera'));
        if (sc) { found = { seed, sc }; break; }
      }
    }
    assert.ok(found, '40 个种子里应出现江鳅×薄姑的争执场');
  });

  test('频率落窗：一日至多一场，二十日总量在合理带内', () => {
    const { state } = newRun({ seed: 77, roster: ['anton', 'katya', 'marta'] });
    let s = state;
    for (let d = 0; d < 20; d++) s = skipDayAtHome(s);
    const days = s.ensemble.scenes.map((x) => x.day);
    assert.equal(new Set(days).size, days.length, '一日不得两场');
    assert.ok(s.ensemble.scenes.length >= 5, `二十日至少五场（实 ${s.ensemble.scenes.length}）`);
    assert.ok(s.ensemble.scenes.length <= 20, `至多一日一场（实 ${s.ensemble.scenes.length}）`);
  });

  test('随机场严守对子冷却；评史场尽力避让（不连日顶同一对）', () => {
    const { state } = newRun({ seed: 42, roster: ['anton', 'katya', 'marta'] });
    let s = state;
    for (let d = 0; d < 20; d++) s = skipDayAtHome(s);
    const scenes = s.ensemble.scenes;
    // 三人局的数学极限：三对全在 5 日冷却内时无从避让——场景会打 pairForced 标记，
    // 冷却断言只对"有得选却没避"的场景生效。
    const forced = new Set(scenes.filter((x) => x.pairForced).map((x) => x.id));
    // 随机场（有选择自由）：五天内同对子不重演。
    // bond/shadow 是照顾场——对子避不开时按设计退回第一人（pickScene 有注），不计违例
    const randos = scenes.filter((x) => x.kind === 'friction' || x.kind === 'idle');
    for (let i = 0; i < randos.length; i++) {
      for (let j = i + 1; j < randos.length; j++) {
        if (randos[j].day - randos[i].day > 5) break;
        if (forced.has(randos[j].id)) continue;
        const a = randos[i].participants.slice(0, 2).sort().join('|');
        const b = randos[j].participants.slice(0, 2).sort().join('|');
        assert.notEqual(a, b, `第 ${randos[i].day} 日与第 ${randos[j].day} 日随机场同对子连场`);
      }
    }
    // 评史场（必开）：三人局对子有限，只求不连日顶同一对
    for (let i = 1; i < scenes.length; i++) {
      if (scenes[i].day - scenes[i - 1].day !== 1) continue;
      if (scenes[i].kind !== 'comment' && scenes[i - 1].kind !== 'comment') continue;
      if (['bond', 'shadow'].includes(scenes[i].kind) || ['bond', 'shadow'].includes(scenes[i - 1].kind)) continue;
      if (forced.has(scenes[i].id)) continue;
      const a = scenes[i - 1].participants.slice(0, 2).sort().join('|');
      const b = scenes[i].participants.slice(0, 2).sort().join('|');
      assert.notEqual(a, b, `第 ${scenes[i - 1].day}→${scenes[i].day} 日连日同对（应转位避让）`);
    }
  });
});

describe('堂屋：先裁决后演出（LLM 写权为零）', () => {
  test('场景落地即完成心情/信任结算，结局拍在场内', () => {
    const { state } = newRun({ seed: 7, roster: ['anton', 'marta', 'bron'] });
    state.causality.shadowTouched = { anton: 2 };
    const s = skipDayAtHome(state);
    const sc = s.ensemble.scenes[0];
    assert.ok(sc.outcome.beat, '结局拍必须内核先定');
    assert.ok(sc.outcome.mood && typeof sc.outcome.mood === 'object', '心情微调必须内核先定');
  });

  test('同种子同堂屋：两局逐字节一致', () => {
    const a = newRun({ seed: 99, roster: ['zofia', 'alexey', 'yura'] });
    const b = newRun({ seed: 99, roster: ['zofia', 'alexey', 'yura'] });
    const sa = skipDayAtHome(skipDayAtHome(skipDayAtHome(a.state)));
    const sb = skipDayAtHome(skipDayAtHome(skipDayAtHome(b.state)));
    assert.deepEqual(sa.ensemble.scenes, sb.ensemble.scenes);
  });

  test('死人不进堂屋', () => {
    const { state } = newRun({ seed: 13, roster: ['anton', 'marta', 'bron'] });
    let s = skipDayAtHome(state);
    ch(s, 'bron').alive = false;
    for (let d = 0; d < 6; d++) s = skipDayAtHome(s);
    for (const sc of s.ensemble.scenes.filter((x) => x.day >= 3)) {
      assert.ok(!sc.participants.includes('bron'), '死人不得进场');
    }
  });

  test('旁传局不开堂屋（旁传有自己的卡节奏）', () => {
    const { state } = newRun({ seed: 17, roster: ['anton', 'marta', 'bron'] });
    state.sidestory = { id: 'test_side' };
    const s = skipDayAtHome(state);
    assert.equal((s.ensemble?.scenes || []).length, 0);
  });
});
