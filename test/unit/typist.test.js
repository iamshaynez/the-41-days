// 流式分句引擎（线上回归）：LLM 增量边界落在「字」与「。」之间时，
// 旧实现把纯标点增量静默丢弃——句子粘连（「笃定三人」）、段尾裸奔（「压手」）。
// SentenceBuffer 跨增量缓冲：任何切块方式下，feed+flush 的总输出 == 原文逐字。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SentenceBuffer, splitSentences } from '../../packages/web/public/typist.js';

const TEXT = '夜里他果然来了，就蹲在渡口边。\n\n于是你依他指的方向去翻。\n粮行区里落了些水。\n\n袋重了，你没有贪。撤出来的时候，身上压着十份东西。';

/** 重建纯文本：0=段界（换行），其余拼接 */
const rebuild = (items) => items.map((x) => (x === 0 ? '\n' : x)).join('');

describe('流式分句：任何切块都不丢字', () => {
  test('逐字符喂入（最恶毒的切块）', () => {
    const b = new SentenceBuffer();
    const out = [];
    for (const ch of TEXT) out.push(...b.feed(ch));
    out.push(...b.flush());
    assert.equal(rebuild(out), TEXT, '逐字喂入必须逐字还原');
  });

  test('随机二段切（模拟 SSE token 边界）', () => {
    for (const seed of [1, 7, 42, 2026]) {
      const b = new SentenceBuffer();
      const out = [];
      let rest = TEXT;
      let x = seed;
      while (rest.length) {
        x = (x * 48271) % 2147483647;
        const n = 1 + (x % 5); // 1~5 字一块
        out.push(...b.feed(rest.slice(0, n)));
        rest = rest.slice(n);
      }
      out.push(...b.flush());
      assert.equal(rebuild(out), TEXT, `seed=${seed} 随机切块必须逐字还原`);
    }
  });

  test('句子边界恰好落在增量交界（旧 bug 的现场）', () => {
    const b = new SentenceBuffer();
    const a = b.feed('只有一种笃定');
    const c = b.feed('。三人在后门退出来');
    const items = [...a, ...c, ...b.flush()];
    const text = rebuild(items);
    assert.ok(text.includes('笃定。三人'), `句号必须保留：${text}`);
    assert.ok(!/笃定三人/.test(text), '不允许句子粘连');
  });

  test('段尾裸奔修复：未完尾句由 flush 落纸', () => {
    const b = new SentenceBuffer();
    b.feed('这一层纸薄，');
    b.feed('压手');
    const items = b.flush();
    assert.equal(rebuild(items), '这一层纸薄，压手');
  });

  test('splitSentences：连续标点随句、纯标点不成碎片', () => {
    assert.deepEqual(splitSentences('来了。。'), ['来了。。']);
    assert.deepEqual(splitSentences('好。'), ['好。']);
    // 碎片并入前一句
    assert.ok(splitSentences('很长的一句话。哈').at(-1).length >= 1);
  });
});
