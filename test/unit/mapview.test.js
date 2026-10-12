// 舆图视图（叙事双轴-v0.1 §3）：三态地点、今夜走向、留痕层触发
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, PACK } from '../helpers.js';
import { mapView } from '../../packages/core/index.js';

describe('舆图 · 三态与走向', () => {
  test('家恒亮；已知地点淡显；未闻地点连名字都不给', () => {
    const { state } = newRun({ seed: 1, roster: ['anton', 'marta', 'bron'] });
    const mv = mapView(state, PACK);
    const home = mv.places.find((p) => p.id === 'home');
    assert.equal(home.state, 'known');
    const known = mv.places.filter((p) => p.state === 'known').map((p) => p.id);
    assert.ok(known.includes('market') && known.includes('church'), '开局即知的四地在图');
    const unknown = mv.places.filter((p) => p.state === 'unknown');
    assert.ok(unknown.every((p) => p.name === undefined), '未闻地点不带名字（地名不剧透）');
    assert.equal(mv.tonight, null, '白天全员在家');
  });

  test('夜间外出：地点亮起、署名、走向虚线', () => {
    const { state } = newRun({ seed: 2, roster: ['bron', 'marta', 'anton'] });
    state.phase = 'night';
    state.night = { home: false, locId: 'post', room: 'yard', charId: 'bron', slots: 8 };
    state.knownLocs.push('post');
    const mv = mapView(state, PACK);
    const post = mv.places.find((p) => p.id === 'post');
    assert.equal(post.state, 'tonight');
    assert.equal(post.who, '石大');
    assert.equal(mv.route.to, 'post');
  });
});

describe('舆图 · 留痕层（战争在图上留疤）', () => {
  test('开局即有：南市缺口（围城前的疤）', () => {
    const { state } = newRun({ seed: 1 });
    const ids = mapView(state, PACK).traces.map((t) => t.id);
    assert.ok(ids.includes('tr_gap'));
    assert.equal(ids.length, 1, '开局只有一枚旧疤');
  });

  test('大仓火步落定 → 焦痕上图', () => {
    const { state } = newRun({ seed: 1 });
    state.firedOnce['ml_m_fire'] = true;
    const ids = mapView(state, PACK).traces.map((t) => t.id);
    assert.ok(ids.includes('tr_fire'));
  });

  test('入冬有霜、霖雨有水纹、守夜三夜点灯', () => {
    const { state } = newRun({ seed: 1 });
    state.winterActive = true;
    assert.ok(mapView(state, PACK).winter);
    let mv = mapView({ ...state, winterActive: false, weather: 'rain' }, PACK);
    assert.ok(mv.traces.some((t) => t.id === 'tr_water'), '霖雨当日水纹');
    const s2 = newRun({ seed: 1 }).state;
    for (let i = 0; i < 3; i++) s2.causality.entries.push({ day: i + 1, verb: 'guard_night', actor: 'bron', weight: 1, witnesses: [] });
    mv = mapView(s2, PACK);
    assert.ok(mv.traces.some((t) => t.id === 'tr_lamp'), '连续守夜留灯');
  });

  test('玩家作为的痕：白翎线与惨胜线', () => {
    const { state } = newRun({ seed: 1 });
    state.eventFlags.crossing_heard = true;
    state.eventFlags.alt_jiangling = true;
    const ids = mapView(state, PACK).traces.map((t) => t.id);
    assert.ok(ids.includes('tr_arrow') && ids.includes('tr_dry_axe'), '箭记与干涩门轴');
  });

  test('交割日：七条船与门轴的油', () => {
    const { state } = newRun({ seed: 1 });
    state.day = 45;
    const ids = mapView(state, PACK).traces.map((t) => t.id);
    assert.ok(ids.includes('tr_seven_ships') && ids.includes('tr_door_oil'));
  });
});
