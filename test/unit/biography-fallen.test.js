// 死者列传（修复④）：fallen 的末笔是"墙上的名字"，不得把救赎种子（生者愿望句）
// 错当"后日谈"安在死人头上——实测直读局里石大死了却接"后日谈：这回我进去。数到八。"
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PACK } from '../helpers.js';
import { renderBiographiesDirect } from '../../packages/core/src/storyline.js';

const STORY = (direction, timeline) => ({
  days: 20,
  epilogues: [{
    id: 'bron', name: '石大', direction, knot: '那次大火，第七个和第一个之间',
    timeline: timeline || [{ day: 2, text: '堂屋评史，与石大、逄灶。' }, { day: 18, text: '重病不治。' }]
  }]
});

describe('直读列传：fallen 的后日谈', () => {
  test('死者的后日谈是"墙上的名字"，不是救赎愿望句', () => {
    const [bio] = renderBiographiesDirect(STORY('fallen'), PACK);
    assert.match(bio.text, /没能撑过去/, '方向句在');
    assert.match(bio.text, /后日谈：橘里九号的墙上/, '死者后日谈落在墙上的名字');
    assert.doesNotMatch(bio.text, /数到八/, '不得把救赎种子写给死人');
  });

  test('生者方向仍可用救赎种子作后日谈（不回归）', () => {
    const [bio] = renderBiographiesDirect(STORY('honored'), PACK);
    assert.match(bio.text, /后日谈：/);
    assert.match(bio.text, /数到八|邻家的门|摇篮|还回去/, '生者后日谈化用救赎种子');
  });
});
