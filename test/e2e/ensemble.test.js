// 堂屋系统 e2e（人物血肉计划 PR2）：内核裁决 → LLM 台词 → 校验 → SSE；
// 桩越界（场外人开口）→ 整份弃 → persona 直读拼装；直读模式堂屋照常开演。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../packages/server/index.js';
import { applyMigrations } from '../../packages/server/migrate.js';

let app, base, stub, dir;
let token, adminToken;
let stubMode = 'valid'; // valid | outsider（场外人开口，必被弃）

before(async () => {
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const sys = JSON.parse(body || '{}').messages?.[0]?.content || '';
      if (sys.includes('堂屋导演')) {
        // 堂屋桩：从场景 JSON 里抓参与者显示名，人各一句；越界模式塞一个场外人
        const names = [...sys.matchAll(/"name":"([^"]{1,6})"/g)].map((m) => m[1]);
        const cast = names.length >= 2 ? names : ['文简', '辛夷'];
        const lines = (stubMode === 'outsider'
          ? [...cast, '石大']
          : [...cast, cast[0]]).map((n) => ({ char: n, text: `${n === cast[0] ? '这话' : '嗯'}——账要记着。` }));
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ lines, narration: '堂屋的晨话。' }) } }] }));
      }
      if (JSON.parse(body || '{}').response_format?.type === 'json_object') {
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intents: [], clarify: null, say: null }) } }] }));
      }
      res.end(JSON.stringify({ choices: [{ message: { content: '【桩叙事】堂屋外，城照旧。' } }] }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  process.env.INPUT_RATE_PER_MIN = '0';
  dir = mkdtempSync(join(tmpdir(), 'twom-ens-'));
  applyMigrations(join(dir, 'game.db'));
  app = createApp({ dbPath: join(dir, 'game.db'), adminUsername: 'admin', adminPassword: 'test-admin-pw' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  token = (await api('POST', '/api/auth/signup', { username: 'ensplayer', password: 'secret1' }, null)).token;
  adminToken = (await api('POST', '/api/auth/login', { username: 'admin', password: 'test-admin-pw' }, null)).token;
  const created = await api('POST', '/api/admin/providers',
    { name: '桩', adapter: 'openai-compat', baseUrl: `http://127.0.0.1:${stub.address().port}`, model: 'stub', apiKey: 'sk-stub' }, adminToken);
  await api('POST', '/api/admin/llm/routes', { purpose: 'ensemble', providerId: created.id }, adminToken);
});

after(() => {
  app.server.close(); app.db.close(); stub.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(method, path, body, tok = token) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}

async function inputIntents(runId, intents) {
  const res = await fetch(`${base}/api/runs/${runId}/input`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ intents })
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

/** 走到次晨（堂屋在破晓管线开演） */
async function playToDawn(runId) {
  await inputIntents(runId, [{ type: 'advance' }]);
  return inputIntents(runId, [{ type: 'dusk_assign', scavenger: null, others: {} }]);
}

describe('堂屋 e2e（LLM 模式）', () => {
  let runId;
  before(async () => {
    stubMode = 'valid';
    const r = await api('POST', '/api/runs', { seed: 3, roster: ['katya', 'marta', 'anton'], prologue: false });
    runId = r.id;
    assert.equal(r.mode, 'llm');
  });

  test('晨间堂屋：SSE 对话事件 + 台词来自桩（via=llm）+ 事件账入档', async () => {
    const evs = await playToDawn(runId);
    const ens = evs.filter((e) => e.ev === 'ensemble');
    assert.ok(ens.length >= 1, '破晓应有堂屋事件');
    const sc = ens[0].data;
    assert.equal(sc.via, 'llm');
    assert.ok(sc.lines.length >= 3, '每人至少一句');
    assert.ok(sc.beat, '内核定的结局拍随事件下发');
    const patch = evs.find((e) => e.ev === 'state-patch').data.state;
    assert.ok(patch.ensemble.scenes.length >= 1, '状态里应有堂屋流水');
    assert.ok(patch.ensemble.scenes[0].outcome.beat, '结局拍在内核先裁决');
    // 事件账（回放源）：ENSEMBLE_SCENE 入 run_event
    const stream = await api('GET', `/api/runs/${runId}/events`);
    assert.ok(stream.events.some((e) => e.t === 'ENSEMBLE_SCENE'), 'ENSEMBLE_SCENE 应入事件账');
  });

  test('桩越界（场外人开口）→ 整份弃 → persona 直读拼装（via=direct）', async () => {
    stubMode = 'outsider';
    const r2 = await api('POST', '/api/runs', { seed: 3, roster: ['katya', 'marta', 'anton'], prologue: false });
    const evs = await playToDawn(r2.id);
    const ens = evs.filter((e) => e.ev === 'ensemble');
    assert.ok(ens.length >= 1);
    const sc = ens[0].data;
    assert.equal(sc.via, 'direct', '越界输出必须被弃，走直读');
    assert.ok(sc.lines.every((l) => ['katya', 'marta', 'anton'].includes(l.char)), '直读台词只出自场内人');
    stubMode = 'valid';
  });
});

describe('堂屋 e2e（直读模式：LLM 全挂）', () => {
  test('无 LLM 堂屋照常开演：评史场直读拼装 stances/voice', async () => {
    const r = await api('POST', '/api/runs', { mode: 'direct', seed: 3, roster: ['katya', 'marta', 'anton'], prologue: false });
    const evs = await playToDawn(r.id);
    const ens = evs.filter((e) => e.ev === 'ensemble');
    assert.ok(ens.length >= 1, '直读模式也要有堂屋');
    const sc = ens[0].data;
    assert.equal(sc.via, 'direct');
    assert.equal(sc.kind, 'comment', '开局次晨应是评史场');
    assert.ok(sc.lines.length >= 2 && sc.lines.every((l) => l.text.length >= 4), '台词成句');
    assert.ok(sc.beat);
  });
});
