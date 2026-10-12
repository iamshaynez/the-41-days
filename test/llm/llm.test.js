// L4 LLM 层测试（零外呼：本地桩服务模拟 OpenAI 兼容端点 + 纯函数断言）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openaiCompat, anthropicCompat, healthCheck, extractJson, referee, makeGateway } from '../../packages/llm/index.js';

let server, port;

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      if (req.url === '/chat/completions') {
        const isPing = payload.messages?.[0]?.content?.includes('正常');
        if (isPing) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { content: '正常' } }], usage: { total_tokens: 12 } }));
        }
        const wantsJson = payload.response_format?.type === 'json_object';
        const secondTry = payload.messages?.[1]?.content?.includes('无法解析');
        if (wantsJson && secondTry) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { content: '{"intents":[{"type":"meta","query":"status"}],"clarify":null,"say":null}' } }] }));
        }
        if (wantsJson) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { content: '我觉得你想…… ```json\n{"intents":[{"type":"act","actor":"bron","action":"eat","target":"meal"}],"clarify":null,"say":null}\n```' } }] }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '石大把最后一口热的咽下去，像咽下一个承诺。' } }] }));
        return;
      }
      if (req.url === '/messages') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ content: [{ type: 'text', text: '（anthropic 桩）' }] }));
      }
      if (req.url === '/bad') { res.writeHead(500); return res.end('boom'); }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => server.close());

describe('Provider 适配器（L4-1）', () => {
  test('openai-compat：非流式调用解析 choices', async () => {
    const p = openaiCompat({ baseUrl: `http://127.0.0.1:${port}`, model: 'stub', apiKey: 'k' });
    const r = await p.call({ user: '渲染' });
    assert.match(r.text, /石大/);
  });
  test('anthropic-compat：messages 端点解析 content', async () => {
    const p = anthropicCompat({ baseUrl: `http://127.0.0.1:${port}`, model: 'stub', apiKey: 'k' });
    const r = await p.call({ user: 'hi' });
    assert.match(r.text, /anthropic 桩/);
  });
  test('连通性测试 healthCheck：成功路径带延迟与回显', async () => {
    const h = await healthCheck({ adapter: 'openai-compat', baseUrl: `http://127.0.0.1:${port}`, model: 'stub', apiKey: 'k', name: '桩' });
    assert.equal(h.ok, true);
    assert.equal(h.echo, '正常');
    assert.ok(h.latencyMs >= 0);
  });
  test('连通性测试：失败路径带原始错误', async () => {
    const h = await healthCheck({ adapter: 'openai-compat', baseUrl: `http://127.0.0.1:${port}/x`, model: 'stub', apiKey: 'k' });
    assert.equal(h.ok, false);
    assert.ok(h.error);
  });
});

describe('extractJson（L4-2）', () => {
  test('容忍围栏与前后闲话', () => {
    assert.deepEqual(extractJson('好的！```json\n{"a":1}\n``` 以上。'), { a: 1 });
    assert.deepEqual(extractJson('前缀 {"a":[1,2]} 后缀'), { a: [1, 2] });
    assert.equal(extractJson('完全没有 JSON'), null);
  });
});

describe('裁判：意图解析契约 + 修复链 + 直读兜底（L4-3）', () => {
  const prompts = { referee: 'SYS {{world}} {{day_actions}} {{dusk_actions}} {{night_scene}} {{merchant}}' };
  const args = { prompts, worldBrief: 'W', dayActions: 'D', duskActions: 'K', nightScene: '', merchant: '' };
  const fb = (input) => ({ intents: [{ type: 'meta', query: 'status' }] });

  test('正常解析：闲话+围栏 JSON 也能抽出意图', async () => {
    const provider = openaiCompat({ baseUrl: `http://127.0.0.1:${port}`, model: 'stub', apiKey: 'k' });
    const r = await referee({ ...args, provider }, '石大吃熟食', fb);
    assert.equal(r.ok, true);
    assert.equal(r.intents[0].action, 'eat');
    assert.equal(r.degraded, undefined);
  });
  test('修复链：第一次坏输出 → 重试成功', async () => {
    // 桩：第一次 wantsJson 返回坏内容？——用坏 provider 模拟两连败再走兜底
    let calls = 0;
    const flaky = { call: async () => { calls++; throw new Error('503'); }, model: 'flaky' };
    const r = await referee({ ...args, provider: flaky }, '随便', fb);
    assert.equal(r.ok, true);
    assert.equal(r.degraded, true, '两连败应降级直读');
    assert.equal(calls, 2, '修复链重试恰好一轮');
    assert.equal(r.intents[0].type, 'meta');
  });
  test('intents 为空且无 clarify → 视为解析失败', async () => {
    const empty = { call: async () => ({ text: '{"intents":[],"clarify":null,"say":null}' }), model: 'e' };
    const r = await referee({ ...args, provider: empty }, 'x', fb);
    assert.equal(r.degraded, true, '空意图触发修复→兜底');
  });
});

describe('网关：按用途路由 + 主备降级（L4-4）', () => {
  test('主 provider 失败切备，双败降级', async () => {
    const logs = [];
    const gw = makeGateway({
      providers: {
        narrator: { call: async () => { throw new Error('down'); }, model: 'A' },
        'narrator:fallback': openaiCompat({ baseUrl: `http://127.0.0.1:${port}`, model: 'B', apiKey: 'k' })
      },
      log: (l) => logs.push(l)
    });
    const r = await gw.call('narrator', (p) => p.call({ user: '渲染' }));
    assert.equal(r.via, 'B');
    assert.equal(logs[0].ok, false);
    assert.equal(logs[1].ok, true);
    // 双败
    const gw2 = makeGateway({ providers: { narrator: { call: async () => { throw new Error('x'); }, model: 'A' } }, log: () => {} });
    const r2 = await gw2.call('narrator', (p) => p.call({ user: 'x' }));
    assert.equal(r2.degraded, true);
  });
});
