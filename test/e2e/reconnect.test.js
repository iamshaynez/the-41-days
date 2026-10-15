// 断线重连（页内恢复）e2e：SSE 开闸即心跳 + 客户端半途断开后轮次照常落库。
// 契约（前端页内重连的根据，技术架构「服务端权威」）：
//   1) 输入 SSE 在 LLM 思考期就开闸：响应头与 ack 先走、注释行心跳不断流——
//      反向代理（默认 60s 读超时）不会掐线，前端也能分辨「世界还在想」与「线断了」。
//   2) 客户端半途断开：服务器照常把这轮写完（状态与书页落库），
//      GET /api/runs/:id 返回断点后的最新状态与全量前文——页内重连照此重铺书页。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../packages/server/index.js';
import { applyMigrations } from '../../packages/server/migrate.js';

let app, base, stub, stubPort, dir;
let token;
const auth = { 'content-type': 'application/json' };

// LLM 桩上游（OpenAI 兼容）：裁判先睡 REFERENCE_DELAY 再回合法意图——
// 睡的这一段就是「LLM 还在想」，心跳必须在这段里活着
const REFEREE_DELAY_MS = 800;

before(async () => {
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const user = payload.messages?.at(-1)?.content || '';
      if (payload.response_format?.type === 'json_object') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intents: [{ type: 'act', actor: 'bron', action: 'eat' }], clarify: null, say: null }) } }] }));
        }, REFEREE_DELAY_MS);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '【桩叙事】石大吃上了热的。' } }] }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  stubPort = stub.address().port;

  dir = mkdtempSync(join(tmpdir(), 'twom-reconnect-'));
  applyMigrations(join(dir, 'g.db'));
  // 心跳周期压到 60ms：测试里「长思考」用毫秒级模拟
  app = createApp({ dbPath: join(dir, 'g.db'), adminUsername: 'admin', adminPassword: 'x'.repeat(10), inputRatePerMin: 0, sseHeartbeatMs: 60 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.port()}`;
  const reg = await (await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: auth, body: JSON.stringify({ username: '史官', password: 'password1' }) })).json();
  token = reg.token;
  auth.authorization = `Bearer ${token}`;
  const adm = await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'x'.repeat(10) }) })).json();
  await fetch(`${base}/api/admin/providers`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adm.token}` }, body: JSON.stringify({ name: '慢桩', adapter: 'openai-compat', baseUrl: `http://127.0.0.1:${stubPort}`, model: 'stub-model', apiKey: 'sk-stub' }) });
  await fetch(`${base}/api/admin/llm/routes`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adm.token}` }, body: JSON.stringify({ purpose: 'referee', providerId: 1 }) });
});

after(async () => {
  await new Promise((r) => app.server.close(r));
  await new Promise((r) => stub.close(r));
  rmSync(dir, { recursive: true, force: true });
});

test('SSE 开闸即心跳：LLM 还在想，头与 ack 先到、心跳注释不断流', async () => {
  const run = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: auth, body: JSON.stringify({ prologue: false }) })).json();
  assert.equal(run.mode, 'llm', '已配路由应为 LLM 局');
  const t0 = Date.now();
  const res = await fetch(`${base}/api/runs/${run.id}/input`, {
    method: 'POST', headers: auth, body: JSON.stringify({ input: '石大吃熟食' })
  });
  const ttfb = Date.now() - t0;
  assert.equal(res.status, 200);
  // 头必须在裁判睡醒之前到（留一半余量；旧行为是 parse 完才 writeHead）
  assert.ok(ttfb < REFEREE_DELAY_MS / 2, `响应头应即到（实测 ${ttfb}ms < ${REFEREE_DELAY_MS / 2}ms）`);

  // 流式读：先见 ack，裁判思考期里要见到心跳注释（: hb），最后才 done
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let sawAck = false, sawHeartbeat = false, sawDone = false;
  let hbBeforeDone = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    if (/^event: ack$/m.test(buf)) sawAck = true;
    if (buf.includes(': hb')) {
      if (!sawHeartbeat && !sawDone) hbBeforeDone = true;
      sawHeartbeat = true;
    }
    if (/^event: done$/m.test(buf)) { sawDone = true; break; }
  }
  assert.ok(sawAck, '应有 ack 先行');
  assert.ok(sawHeartbeat && hbBeforeDone, '思考期里应有心跳注释行（: hb）且先于 done');
  assert.ok(sawDone, '轮次要善终（done）');
  // 心跳是注释行：不产生事件，SSE 解析端天然忽略
  for (const block of buf.split('\n\n')) {
    if (block.trim().startsWith(':')) continue;
    if (/^data: /m.test(block) && !/^event: /m.test(block)) throw new Error(`心跳必须是注释行，不能是裸 data：${block.slice(0, 40)}`);
  }
  await reader.cancel().catch(() => {});
});

test('客户端半途断开：服务器照常写完这轮，GET 回最新状态与全量前文', async () => {
  const run = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: auth, body: JSON.stringify({ mode: 'direct', prologue: false }) })).json();
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/runs/${run.id}/input`, {
    method: 'POST', headers: auth, body: JSON.stringify({ input: '照常过吧' }), signal: ctl.signal
  });
  assert.equal(res.status, 200);
  // 头刚到就拔线——最恶劣的断法（正文一个字都没收到）
  ctl.abort();
  await res.body.cancel().catch(() => {});

  // 服务器把这轮写完落库（页内重连的根据：真相在库里，重连=重铺，不是重放）
  let full = null;
  for (let i = 0; i < 50 && !full; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const r2 = await (await fetch(`${base}/api/runs/${run.id}`, { headers: auth })).json();
    if ((r2.history || []).some((h) => h.role === 'player' && h.text === '照常过吧')) full = r2;
  }
  assert.ok(full, '断开后轮次应照常落库');
  assert.ok(full.history.some((h) => h.role === 'narrator'), '正文也该落库（页内重连重铺的是全量前文）');
  assert.ok(full.state && full.state.day, '状态补丁的真相在库里');
  // 再走一轮：恢复后的玩家还能继续——服务器对「断过的局」一视同仁
  const next = await fetch(`${base}/api/runs/${run.id}/input`, { method: 'POST', headers: auth, body: JSON.stringify({ input: '今晚都不出去' }) });
  assert.equal(next.status, 200);
  const raw = await next.text();
  assert.match(raw, /event: done/, '断线恢复后的下一轮正常善终');
});

test('坏形状意图仍回 400（开闸前验形，不是流里报错）', async () => {
  const run = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: auth, body: JSON.stringify({ mode: 'direct', prologue: false }) })).json();
  const res = await fetch(`${base}/api/runs/${run.id}/input`, { method: 'POST', headers: auth, body: JSON.stringify({ intents: [{ type: 'act' }] }) });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, '无效意图');
});
