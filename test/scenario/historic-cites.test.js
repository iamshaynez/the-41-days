// 史注（内容包 0.33.0）：41 天里不断扣回正史——将军轨步文带《三国志》引文，
// 幕带《三国演义》回目定位。玩家活在宏大历史的页边，史书随时来对表。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, PACK } from '../helpers.js';
import { buildChronicle } from '../../packages/core/index.js';

function runTo(day) {
  const { state } = newRun({ seed: 51 });
  state.day = day;
  return state;
}

describe('史注 · 步文引文（内容契约）', () => {
  test('至少十步带《三国志》引文，条条成色（src 志书、引文 8~90 字）', () => {
    const cited = PACK.mainline.steps.filter((s) => s.cite);
    assert.ok(cited.length >= 10, `带史注的步只有 ${cited.length} 步——密度不够`);
    for (const s of cited) {
      assert.ok(/《三国志·.+》/.test(s.cite.src || ''), `步 ${s.id} 的史源不是志书：${s.cite.src}`);
      assert.ok(s.cite.text && s.cite.text.length >= 8 && s.cite.text.length <= 90, `步 ${s.id} 引文 8~90 字：${s.cite.text?.slice(0, 14)}`);
    }
  });

  test('引文挂在真史实发生的日子：将军轨为主，城轨只挂 D1 易帜', () => {
    const cited = PACK.mainline.steps.filter((s) => s.cite);
    const gen = cited.filter((s) => s.track === 'gen');
    assert.ok(gen.length >= 8, `将军轨史注 ${gen.length} 步——樊城到临沮的每段正史都该有出处`);
    const cityCited = cited.filter((s) => s.track !== 'gen');
    for (const s of cityCited) {
      const d = s.day ?? s.dayWindow?.[0];
      assert.equal(d, 1, `城轨史注只许挂在易帜日（${s.id} 在 D${d}）`);
    }
  });

  test('大事的日子对得上正史：樊城围解、麦城、临沮三锚必有引文', () => {
    const byId = Object.fromEntries(PACK.mainline.steps.map((s) => [s.id, s]));
    for (const id of ['m5_cannon', 'm14_maicheng', 'm21_linju']) {
      assert.ok(byId[id]?.cite, `步 ${id} 缺史注——这是正史落锚的日子`);
    }
  });
});

describe('史注 · 幕回目（演义定位）', () => {
  test('五幕幕幕带《三国演义》回目——玩家知道自己活在第几回的页边', () => {
    const acts = PACK.mainline.acts;
    assert.ok(acts.length >= 5);
    for (const a of acts) {
      assert.ok(/《三国演义》/.test(a.romance || ''), `幕 ${a.id} 缺演义回目定位`);
      assert.ok(/第.+回/.test(a.romance || ''), `幕 ${a.id} 的定位要落到回数`);
    }
    assert.ok(/七十五回/.test(acts[0].romance), '第一幕从白衣渡江之后开始');
    assert.ok(/第七十七回/.test(acts[acts.length - 1].romance), '末幕走向显圣那一回');
  });
});

describe('史注 · 装配（史卷视图）', () => {
  test('步日志带出 cite，幕对象带出 romance', () => {
    const st = runTo(41);
    st.mainline = [
      { day: 10, stepId: 'm5_cannon', pens: [], mirrors: [] },
      { day: 31, stepId: 'm14_maicheng', pens: [], mirrors: [] },
      { day: 33, stepId: 'm15_surrender', pens: [], mirrors: [] }
    ];
    const ch = buildChronicle(st, PACK);
    const withCite = ch.entries.filter((e) => e.cite);
    assert.equal(withCite.length, 3, '三步三注');
    for (const e of withCite) assert.ok(e.cite.src && e.cite.text, '注完整');
    assert.ok((ch.acts || []).every((a) => a.romance), '幕幕带定位');
    assert.ok(ch.currentAct?.romance, '当前幕带定位');
  });
});
