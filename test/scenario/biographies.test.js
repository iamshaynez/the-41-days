// 列传系统（人物血肉计划 PR3）：结局每人一段史书列传 + 个人大事时间线 + 后日谈。
// 铁律：方向判定单一口径（storyline.epilogues.direction 是唯一源），LLM 只润色，
// 幻觉即回退直读模板；时间线每个字出自因果账/堂屋流水/死亡日。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PACK, newRun, step, ch, skipDayAtHome } from '../helpers.js';
import { renderBiographiesDirect, biographyLint } from '../../packages/core/src/storyline.js';
import { buildStoryline } from '../../packages/core/index.js';
import { buildEnding } from '../../packages/core/src/events.js';

function playAWhile(seed) {
  const { state } = newRun({ seed, roster: ['katya', 'marta', 'bron'] });
  let s = state;
  s.inventory.canned = 4;
  s = step(s, [{ type: 'act', actor: 'marta', action: 'treat', target: 'bandage', patient: 'katya' }]).state
    || s; // 无伤可治时静默
  for (let d = 0; d < 12; d++) s = skipDayAtHome(s);
  return s;
}

describe('列传结构：每人一条时间线（EPI-01 扩展）', () => {
  test('epilogues 带 timeline：日戳节拍 ≤8 条，出自因果账与堂屋流水', () => {
    const s = playAWhile(31);
    const story = buildStoryline(s, PACK);
    for (const ep of story.epilogues) {
      assert.ok(Array.isArray(ep.timeline), `${ep.name} 缺 timeline`);
      assert.ok(ep.timeline.length <= 8, `${ep.name} timeline 超篇幅`);
      for (const t of ep.timeline) {
        assert.ok(typeof t.day === 'number' && t.day >= 1 && t.day <= s.day, '节拍必须带合法日戳');
        assert.ok(typeof t.text === 'string' && t.text.length >= 4, '节拍必须成句');
      }
    }
    // 12 天里必有堂屋场（主线步密集期），参与者时间线应收录其场次
    assert.ok(s.ensemble.scenes.length >= 3, '前提自查：堂屋应已开演');
    const inTimeline = story.epilogues.some((ep) => ep.timeline.some((t) => t.ensemble));
    assert.ok(inTimeline, '堂屋场次应进时间线');
  });

  test('死亡收进时间线：末拍是账停之日', () => {
    const s = playAWhile(31);
    const dead = ch(s, 'bron');
    dead.alive = false; // 场景法：直接构造死亡态（触发条件由因果账保证，此处测结算）
    const story = buildStoryline(s, PACK);
    const ep = story.epilogues.find((e) => e.id === 'bron');
    assert.equal(ep.direction, 'fallen');
    assert.equal(ep.deathDay, s.day, '无死亡日记录时收在终局日');
    const last = ep.timeline[ep.timeline.length - 1];
    assert.ok(last.death, '末拍应是死亡拍');
  });
});

describe('口径统一：chars[].fate 消费 storyline.direction（单一源）', () => {
  test('fate 与 direction 一一对应（fallen→没能撑过去 / haunted→惊醒 / honored→道谢 / survived→就是活下来）', () => {
    const s = playAWhile(33);
    const ending = buildEnding(s, PACK);
    const dirById = Object.fromEntries(ending.storyline.epilogues.map((e) => [e.id, e.direction]));
    for (const c of ending.chars) {
      const d = dirById[c.id];
      if (d === 'fallen') assert.match(c.fate, /没能撑过去/);
      else if (d === 'haunted') assert.match(c.fate, /惊醒/);
      else if (d === 'honored') assert.match(c.fate, /道谢|敲门/);
      else assert.match(c.fate, /就是活下来/);
    }
  });
});

describe('直读列传与 lint（LLM 幻觉即回退）', () => {
  test('renderBiographiesDirect：每人成段，开篇史书体，含时间线节拍与后日谈', () => {
    const s = playAWhile(31);
    const story = buildStoryline(s, PACK);
    const bios = renderBiographiesDirect(story, PACK);
    assert.equal(bios.length, story.epilogues.length);
    for (const b of bios) {
      assert.ok(b.id && b.name && b.via === 'direct');
      assert.match(b.text, /者，/, '史书体开篇（X者，……）');
      assert.ok(b.text.length >= 60, '列传成段');
      assert.match(b.text, /后日谈|此后|后来/, '末段有去向');
    }
  });

  test('biographyLint：长度/日数幻觉/未引节拍/封印禁词 四关', () => {
    const s = playAWhile(31);
    const story = buildStoryline(s, PACK);
    const ep = story.epilogues[0];
    const day = ep.timeline[0]?.day ?? 1;
    const good = `${ep.name}者，江陵人也，里坊中人。第 ${day} 天，账起。此后数日，堂屋的灯夜夜亮着，人在，账就在。围城四十五日，他守着他那一页。后日谈：后来他跟着渡口的人潮走了，江陵没有留住他。`;
    assert.equal(biographyLint(good, ep, story), true, '合格列传放行');
    assert.equal(biographyLint('太短', ep, story), false, '长度不过');
    assert.equal(biographyLint(`${ep.name}者，江陵人也。第 99 天，无中生有。后日谈：走了。`, ep, story), false, '日数幻觉（超本局）');
    assert.equal(biographyLint(`${ep.name}者，江陵人也。通篇不提任何一天的事，只说些空话与感想，像一篇没有脚的文。后日谈：走了。`, ep, story), false, '未引用任何时间线节拍日');
    assert.equal(biographyLint(`${ep.name}者，江陵人也。第 ${day} 天，更籍被人卖了。后日谈：走了。`, ep, story), false, '封印禁词');
  });
});
