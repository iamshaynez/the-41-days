// 落幕 · 正史压卷（内容包 0.31.0）：幕一开场先用足够密度的史实压住注意力，
// 再谈变化、分支、传记。历史不因玩家而动——动的那几行，做「改注」。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, PACK } from '../helpers.js';
import { buildEnding } from '../../packages/core/index.js';

const REAL_ENDINGS = ['ceasefire', 'maicheng', 'pyrrhic', 'alt_both', 'lighthouse', 'join_table', 'hostage', 'wiped', 'contract_end'];

/** 造一局走到指定结局的终局态（buildEnding 只读这些面） */
function endedAs(type) {
  const { state } = newRun({ seed: 31 });
  state.war.ended = true;
  state.war.endingType = type;
  state.over = true;
  return state;
}

describe('落幕 · 正史压卷（内容契约）', () => {
  test('正脊在：至少六条，条条有日历锚、纪事文、史源引文', () => {
    const spine = PACK.mainline.annals;
    assert.ok(Array.isArray(spine) && spine.length >= 6, '正脊密度够压卷（≥6 条）');
    for (const e of spine) {
      assert.ok(e.day && e.day.length >= 2, `条目缺日历锚：${JSON.stringify(e).slice(0, 40)}`);
      assert.ok(e.text && e.text.length >= 12 && e.text.length <= 80, `条目纪事文 12~80 字：${e.text?.slice(0, 20)}`);
      assert.ok(e.src && /《.+》/.test(e.src), `条目缺史源引文：${e.src}`);
      for (const [t, f] of Object.entries(e.fork || {})) {
        assert.ok(REAL_ENDINGS.includes(t), `分岔键 ${t} 不是结局类型`);
        assert.ok(f.text && f.text.length >= 12 && f.text.length <= 80, `分岔文 12~80 字：${f.text?.slice(0, 20)}`);
      }
    }
    // 日历锚按序不倒：冬十月 → 头一天 → 第十天 → … → 第四十一天
    const dayNum = (d) => (d.startsWith('第') ? parseInt(d.replace(/[^\d]/g, ''), 10) || 0 : 0);
    const nums = spine.map((e) => dayNum(e.day)).filter((n) => n > 0);
    for (let i = 1; i < nums.length; i++) assert.ok(nums[i] > nums[i - 1], `日历锚倒序：${nums.join(',')}`);
    assert.equal(spine[spine.length - 1].day, '第四十一天', '卷末落在第四十一天');
  });

  test('每个可玩结局都被分岔照顾过，或显式走正脊', () => {
    const forked = new Set();
    for (const e of PACK.mainline.annals) for (const t of Object.keys(e.fork || {})) forked.add(t);
    // ceasefire 家族（含 wiped/contract_end/hostage）走正脊；其余正典结局各有改注
    for (const t of REAL_ENDINGS) {
      const onSpine = ['ceasefire', 'wiped', 'contract_end', 'hostage', 'join_table'].includes(t);
      assert.ok(onSpine || forked.has(t), `结局 ${t} 既不在正脊白名单，也没有分岔改注`);
    }
  });
});

describe('落幕 · 装配（codex.annals）', () => {
  test('正史结局：原脊原样，无改注', () => {
    const st = endedAs('ceasefire');
    const story = buildEnding(st, PACK).storyline;
    const annals = story.codex.annals;
    assert.equal(annals.length, PACK.mainline.annals.length, '全须全尾');
    assert.ok(annals.every((e) => !e.forked), '史书没被改');
  });

  test('麦城得脱：章乡与临沮两行被改注——正脊条数不变，改的行有标记', () => {
    const st = endedAs('maicheng');
    const story = buildEnding(st, PACK).storyline;
    const annals = story.codex.annals;
    assert.equal(annals.length, PACK.mainline.annals.length, '卷面行数不增不减（改注，不是加页）');
    const forked = annals.filter((e) => e.forked);
    assert.ok(forked.length >= 2, '章乡与临沮至少两行被改');
    assert.ok(forked.every((e) => e.forked && e.text !== PACK.mainline.annals.find((x) => x.day === e.day).text),
      '改注行确实换了纪事文');
    assert.ok(annals.slice(0, 4).every((e) => !e.forked), '前面的正史（渡江/开城/围解/军散）一字未动');
  });

  test('惨胜：军散那条起开始分岔（比麦城更早动刀）', () => {
    const st = endedAs('pyrrhic');
    const annals = buildEnding(st, PACK).storyline.codex.annals;
    const firstFork = annals.findIndex((e) => e.forked);
    assert.ok(firstFork >= 0 && firstFork <= 3, '惨胜的历史从中盘就拐了');
  });
});
