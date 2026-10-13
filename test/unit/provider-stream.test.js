// Provider 流边界（修复②）：上游把代理对拆在两个 delta JSON 里时不得漏出半个字符；
// 上游送达的 U+FFFD 替换符不得进入正文（实测线上出现"让辛夷��素徽说话"式乱码）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openaiCompat, anthropicCompat } from '../../packages/llm/index.js';

let server, port;
const reply = []; // 每次 /chat/completions 依次吐出的 SSE 行组

before(async () => {
  server = createServer((req, res) => {
    if (req.url !== '/chat/completions' && req.url !== '/v1/messages') { res.writeHead(404); return res.end(); }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const groups = reply.shift() || [];
      for (const g of groups) {
        res.write(g);
        res.write('\n\n');
      }
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

const oai = () => openaiCompat({ baseUrl: `http://127.0.0.1:${port}`, model: 'stub', apiKey: 'k' });
const ant = () => anthropicCompat({ baseUrl: `http://127.0.0.1:${port}`, model: 'stub', apiKey: 'k' });
const oaiLine = (txt) => `data: ${JSON.stringify({ choices: [{ delta: { content: txt } }] })}`;
const antLine = (txt) => `data: ${JSON.stringify({ type: 'content_block_delta', delta: { text: txt } })}`;

describe('openai-compat 流式：代理对与替换符', () => {
  test('代理对拆在两个 delta 里：增量不见半个字，最终文本完整', async () => {
    reply.push([[oaiLine('让辛夷\ud840')].join('\n'), [oaiLine('\udc00素徽说话')].join('\n'), 'data: [DONE]']);
    const seen = [];
    const r = await oai().call({ user: 'x', stream: true, onDelta: (d) => seen.push(d) });
    assert.equal(r.text, '让辛夷𠀀素徽说话', `全文应完整（实际 ${JSON.stringify(r.text)}）`);
    for (const d of seen) {
      const last = d.charCodeAt(d.length - 1);
      assert.ok(!(last >= 0xd800 && last <= 0xdbff), `增量不得以孤立高代理结尾（${JSON.stringify(d)}）`);
    }
    assert.equal(seen.join(''), r.text, '增量拼回等于全文');
  });

  test('上游送达 U+FFFD：剥掉，不留替换符进正文', async () => {
    reply.push([[oaiLine('让辛夷\ufffd素徽')].join('\n'), 'data: [DONE]']);
    const r = await oai().call({ user: 'x', stream: true, onDelta: () => {} });
    assert.ok(!r.text.includes('\ufffd'), `正文不得含替换符（实际 ${JSON.stringify(r.text)}）`);
    assert.equal(r.text, '让辛夷素徽');
  });

  test('流末尾残留孤立高代理（上游真丢了低半）：丢弃半个字', async () => {
    reply.push([[oaiLine('琴声\ud840')].join('\n'), 'data: [DONE]']);
    const r = await oai().call({ user: 'x', stream: true, onDelta: () => {} });
    assert.equal(r.text, '琴声');
  });
});

describe('anthropic-compat 流式：同一条边界', () => {
  test('代理对拆在两个 content_block_delta 里：拼回完整', async () => {
    reply.push([[antLine('让辛夷\ud840')].join('\n'), [antLine('\udc00素徽')].join('\n'), 'data: [DONE]']);
    const r = await ant().call({ user: 'x', stream: true, onDelta: () => {} });
    assert.equal(r.text, '让辛夷𠀀素徽');
  });

  test('U+FFFD 同样剥掉', async () => {
    reply.push([[antLine('天\ufffd快黑了')].join('\n'), 'data: [DONE]']);
    const r = await ant().call({ user: 'x', stream: true, onDelta: () => {} });
    assert.equal(r.text, '天快黑了');
  });
});
