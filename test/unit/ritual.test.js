// 展卷（rite）纯逻辑：结局大典的数据装配与降级。
// 契约：档案馆点击「走过的结局」展开全文——前因后果要说清楚
// （正史压卷/案语/落幕行/后日谈/双轨来自 run_memory.storyline.codex）；
// 老局没有 codex 也要体面降级（题名/正史一行/人与事/回忆录）；
// 未解锁的结局一概封存——模型层就不给任何可泄露的内容。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { endingRiteSections } from '../../packages/web/public/ritual.js';

const GALLERY = { type: 'ceasefire', title: '开城', canon: '是岁闰十月，江陵易主，不血刃。', hint: '不该出现在封存卡上' };

const FULL_RUN = {
  day: 45, ending: 'ceasefire', survivors: ['石大', '辛夷'], fallen: ['文简'],
  threeThings: [{ day: 12, text: '把最后半袋米分给了邻家' }],
  memoir: '第四十一天清晨，门开了。',
  storyline: {
    title: '第四十一天',
    codex: {
      annals: [{ day: '闰十月', text: '江陵易主，不血刃。', src: '《三国志》' }],
      notes: [{ src: '《三国志·吴书》', text: '吕蒙白衣渡江。', tie: '你们的那四十一天，就叠在这一行底下。' }],
      lines: ['变了的一行：城门没沾血。'],
      futures: ['交割后第卅日，家访队撤了。'],
      tracks: { city: [{ day: 5, title: '粮行断顿', text: '米价三日一翻。' }], gen: [] }
    }
  }
};

describe('结局大典：前因后果装全', () => {
  test('有 codex 的局——五幕俱全', () => {
    const m = endingRiteSections(FULL_RUN, GALLERY);
    assert.equal(m.title, '开城');
    assert.equal(m.canon, GALLERY.canon);
    assert.equal(m.day, 45);
    assert.deepEqual(m.survivors, ['石大', '辛夷']);
    assert.deepEqual(m.fallen, ['文简']);
    assert.equal(m.annals.length, 1);
    assert.equal(m.notes.length, 1);
    assert.equal(m.lines.length, 1);
    assert.equal(m.futures.length, 1);
    assert.equal(m.tracks.city.length, 1);
    assert.equal(m.hasStory, true);
  });
  test('老局没有 storyline——体面降级：题名/正史一行/人与事/回忆录仍在', () => {
    const m = endingRiteSections({ day: 30, ending: 'wiped', survivors: [], fallen: ['石大'], threeThings: [], memoir: null }, GALLERY);
    assert.equal(m.title, '开城');
    assert.deepEqual(m.annals, []);
    assert.deepEqual(m.notes, []);
    assert.deepEqual(m.futures, []);
    assert.equal(m.hasStory, false, '没有 codex 不硬凑幕');
    assert.equal(m.day, 30);
    assert.equal(m.fallen.length, 1);
  });
  test('字段残缺（null/undefined 各处）不抛——大典永不白屏', () => {
    const m = endingRiteSections({ ending: 'ceasefire' }, GALLERY);
    assert.equal(m.title, '开城');
    assert.deepEqual(m.survivors, []);
    assert.equal(m.hasStory, false);
  });
  test('没有走过（run 为 null）——没有大典，只有封存', () => {
    assert.equal(endingRiteSections(null, GALLERY), null);
  });
});
