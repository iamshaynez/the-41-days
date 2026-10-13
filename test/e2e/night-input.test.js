// 夜间输入管线 e2e（夜间双模修复批次）：
// 裁判只回 say（玩家对 NPC 说话、世界代答）时——话不丢（done.say 带回前端渲染）、
// 不触发直读兜底把玩家的话再当命令解析一遍、也不降格成 whisper 素材。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../packages/server/index.js';
import { applyMigrations } from '../../packages/server/migrate.js';

let app, base, stub, dir, token;

const SAY_LINE = '守藏吏隔着门板回了话：夜里路不好，走城墙根。';

before(async () => {
  // LLM 桩：玩家说「隔着门问」时裁判只回 say（对 NPC 说话，无意图）；其余回一个 no-op 意图
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const user = payload.messages?.at(-1)?.content || '';
      if (payload.response_format?.type === 'json_object') {
        const sayOnly = user.includes('隔着门问');
        const out = sayOnly
          ? { intents: [], clarify: null, say: SAY_LINE }
          : { intents: [{ type: 'meta', query: 'status' }], clarify: null, say: null };
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '【桩叙事】一切照旧。' } }] }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubPort = stub.address().port;

  dir = mkdtempSync(join(tmpdir(), 'twom-night-'));
  applyMigrations(join(dir, 'game.db'));
  app = createApp({ dbPath: join(dir, 'game.db'), adminUsername: 'admin', adminPassword: 'owl admin watchword', inputRatePerMin: 0 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;

  const su = await api('POST', '/api/auth/signup', { username: 'nightowl', password: 'owls read at night' });
  token = su.token;
  const login = await api('POST', '/api/auth/login', { username: 'admin', password: 'owl admin watchword' });
  const created = await api('POST', '/api/admin/providers', { name: '桩', adapter: 'openai-compat', baseUrl: `http://127.0.0.1:${stubPort}`, model: 'stub-model', apiKey: 'owl stub pass phrase' }, login.token);
  await api('POST', '/api/admin/llm/routes', { purpose: 'referee', providerId: created.id }, login.token);
  await api('POST', '/api/admin/llm/routes', { purpose: 'narrator', providerId: created.id }, login.token);
});

after(() => {
  app.server.close(); app.db.close(); stub.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(method, path, body, tok = token) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ...json };
}

async function input(runId, text) {
  const res = await fetch(`${base}/api/runs/${runId}/input`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ input: text })
  });
  assert.equal(res.status, 200);
  const raw = await res.text();
  const events = [];
  for (const block of raw.split('\n\n')) {
    const ev = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    if (ev) events.push({ ev, data: data ? JSON.parse(data) : {} });
  }
  return events;
}

describe('say 管线：对 NPC 说话不该被误解析', () => {
  test('裁判只回 say：done.say 带回、无意图、无 whisper、状态不动', async () => {
    const run = await api('POST', '/api/runs', { mode: 'llm', seed: 7, roster: ['anton', 'marta', 'bron'], prologue: false });
    assert.ok(run.id, `建局应成功：${JSON.stringify(run).slice(0, 120)}`);
    const runId = run.id;
    const before = await api('GET', `/api/runs/${runId}`);

    const events = await input(runId, '隔着门问一声：今晚能过去吗');
    const done = events.find((e) => e.ev === 'done');
    assert.ok(done, '应收到 done');
    assert.equal(done.data.say, SAY_LINE, 'say 要带回前端（修前前端根本不渲染，话凭空消失）');
    assert.equal(done.data.rejects?.length ?? 0, 0, `不该有拒绝（修前会拿玩家的话跑直读兜底吃出误动作）：${JSON.stringify(done.data.rejects)}`);
    const after = await api('GET', `/api/runs/${runId}`);
    assert.equal(after.state.day, before.state.day, '说话不动时间');
    assert.deepEqual(after.state.whispers || [], [], '对 NPC 说话不降格成 whisper 素材');
  });
});
