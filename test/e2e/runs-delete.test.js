// 删除存档 e2e：真删（run + 事件 + 书页 + 该局复盘）；档案馆的文件与真相保留——线索属于城市
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../packages/server/index.js';
import { applyMigrations } from '../../packages/server/migrate.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app, base, dir;
const player = {}, other = {};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'twom-del-'));
  applyMigrations(join(dir, 'game.db'));
  app = createApp({ dbPath: join(dir, 'game.db'), adminUsername: 'admin', adminPassword: 'test-admin-pw' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  player.token = (await api('POST', '/api/auth/signup', { username: 'keeper', password: 'secret1' })).body.token;
  other.token = (await api('POST', '/api/auth/signup', { username: 'stranger', password: 'secret2' })).body.token;
});

after(() => { app.server.close(); app.db.close(); rmSync(dir, { recursive: true, force: true }); });

async function api(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const newRun = (token) => api('POST', '/api/runs', { mode: 'direct', prologue: false, seed: 42, roster: ['bron', 'katya', 'marta'] }, token);

describe('删除存档', () => {
  test('删自己的局：三表清空、列表消失；别人的局一个字都碰不到', async () => {
    const a = await newRun(player.token);
    const b = await newRun(player.token);
    // 未登录 401；他人 404（不泄露存在性）
    assert.equal((await api('DELETE', `/api/runs/${a.body.id}`)).status, 401);
    assert.equal((await api('DELETE', `/api/runs/${a.body.id}`, null, other.token)).status, 404);
    // 本人删除成功
    const del = await api('DELETE', `/api/runs/${a.body.id}`, null, player.token);
    assert.equal(del.status, 200);
    assert.equal((await api('GET', `/api/runs/${a.body.id}`, null, player.token)).status, 404, '删后不可读');
    assert.equal(app.db.eventsOf(a.body.id).length, 0, '事件随局清空');
    assert.equal(app.db.narrationOf(a.body.id).length, 0, '书页随局清空');
    assert.equal(app.db.getRun(a.body.id), null, '局本体清空');
    // 未受牵连
    assert.equal((await api('GET', `/api/runs/${b.body.id}`, null, player.token)).status, 200);
    // 重复删 → 404
    assert.equal((await api('DELETE', `/api/runs/${a.body.id}`, null, player.token)).status, 404);
  });

  test('已收束的局：复盘（回忆录）随局走，档案馆的文件与真相留下', async () => {
    const r = await newRun(player.token);
    const id = r.body.id;
    // 人为收束 + 入档（等价 finalizeEndedRun 的档案面）
    const st = app.db.getRun(id).state;
    st.over = true; st.ending = { type: 'ceasefire', day: st.day, threeThings: [], storyline: null, memoir: '一页复盘。' };
    app.db.finishRun(id, st, st.ending);
    app.db.archivePut(st.user_id ?? 1, 'run_memory', id, { day: st.day, ending: 'ceasefire', memoir: st.ending.memoir }, id);
    app.db.archivePut(st.user_id ?? 1, 'doc', '#014', { title: '死信', layer: 1, text: '一封信。' }, id);
    await api('DELETE', `/api/runs/${id}`, null, player.token);
    const arch = (await api('GET', '/api/archive', null, player.token)).body;
    assert.ok(!arch.runs.some((x) => x.runId === id || x.memoir === '一页复盘。'), '这一局的复盘随局删除');
    assert.ok(arch.docs.some((d) => d.id === '#014'), '档案馆的文件保留——线索属于城市');
  });
});
