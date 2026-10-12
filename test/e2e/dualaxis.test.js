// 叙事双轴 e2e（叙事双轴-v0.1）：序章三幕 HTTP 全链、首局门、舆图/史卷视图、跳过
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../packages/server/index.js';
import { applyMigrations } from '../../packages/server/migrate.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app, base, dir, token;
const jar = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'twom-dualaxis-'));
  applyMigrations(join(dir, 'game.db'));
  app = createApp({ dbPath: join(dir, 'game.db'), adminUsername: 'admin', adminPassword: 'test-admin-pw' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const su = await api('POST', '/api/auth/signup', { username: 'reader1', password: 'secret1' });
  token = su.body.token;
});

after(() => { app.server.close(); app.db.close(); rmSync(dir, { recursive: true, force: true }); });

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), cookie: jar.join('; ') },
    body: body ? JSON.stringify(body) : undefined
  });
  for (const c of res.headers.getSetCookie?.() || []) jar.push(c.split(';')[0]);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
/** 输入走 SSE：读完即弃，状态另查 */
async function sendInput(id, payload) {
  const res = await fetch(`${base}/api/runs/${id}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  });
  await res.text();
}
const view = (id) => api('GET', `/api/runs/${id}`).then((r) => r.body);

describe('序章三幕 · HTTP 全链', () => {
  test('首局：三幕全量、不可跳；推到第 1 天即有史卷与舆图', async () => {
    const r = await api('POST', '/api/runs', { mode: 'direct', seed: 7, roster: ['zofia', 'anton', 'marta'] });
    assert.equal(r.status, 200);
    const id = r.body.id;
    let s = r.body.state;
    assert.equal(s.phase, 'prologue');
    assert.equal(s.preludeView.canSkip, false, '首局不可跳');
    assert.ok(s.preludeView.total >= 10, '全量节拍在册');
    assert.ok(s.mapView.places.some((p) => p.id === 'home' && p.state === 'known'), '舆图就位');
    let guard = 0;
    while (s.phase === 'prologue' && guard++ < 30) {
      if (s.eventView) await sendInput(id, { intents: [{ type: 'event_choice', option: s.eventView.options[0].key }] });
      else await sendInput(id, { intents: [{ type: 'advance' }] });
      s = (await view(id)).state;
    }
    assert.equal(s.phase, 'day');
    assert.equal(s.chronicle.entries[0]?.title, '大胜之秋', 'D1 大事步入卷');
    assert.ok(s.chronicle.entries[0].text.length > 0, '直读回落 fallback 有文');
    assert.ok(s.chronicle.entries[0].digest, '我方一行在卷');
  });

  test('二周目（显式 short）：单句版 + 翻过序章直达第 1 天', async () => {
    const r = await api('POST', '/api/runs', { mode: 'direct', seed: 8, preludeMode: 'short', roster: ['bron', 'katya', 'pavel'] });
    const id = r.body.id;
    let s = r.body.state;
    assert.equal(s.preludeView.canSkip, true, '二周目可跳');
    await sendInput(id, { intents: [{ type: 'skip_prelude' }] });
    s = (await view(id)).state;
    assert.equal(s.phase, 'day');
    assert.equal(s.chronicle.entries[0]?.title, '大胜之秋');
  });

  test('首局门（拍板 v2）：全灭不算通关，活到战争收束才进单句版', async () => {
    // 局一：人为收束为全灭（wiped）——账号仍算没通关
    const r1 = await api('POST', '/api/runs', { mode: 'direct', seed: 11, prologue: false, roster: ['anton', 'marta', 'bron'] });
    const st1 = app.db.getRun(r1.body.id).state;
    st1.over = true; st1.ending = { type: 'wiped' };
    app.db.finishRun(r1.body.id, st1, st1.ending);
    const r2 = await api('POST', '/api/runs', { mode: 'direct', seed: 12, roster: ['anton', 'marta', 'bron'] });
    assert.equal(r2.body.state.preludeView.canSkip, false, '全灭之后仍是完整三幕');
    assert.ok(r2.body.state.preludeView.total >= 12, '全量拍数');
    // 局二：活到开城（ceasefire）——账号通关，此后续局进单句版
    const st2 = app.db.getRun(r2.body.id).state;
    st2.over = true; st2.ending = { type: 'ceasefire' };
    app.db.finishRun(r2.body.id, st2, st2.ending);
    const r3 = await api('POST', '/api/runs', { mode: 'direct', seed: 13, roster: ['anton', 'marta', 'bron'] });
    assert.equal(r3.body.state.preludeView.canSkip, true, '通关之后进单句版');
    assert.ok(r3.body.state.preludeView.total < r2.body.state.preludeView.total, '单句版拍数更少');
    // 入局引在线上也在卷（{{names}} 已插值）
    assert.ok(r3.body.state.chronicle, '史卷在卷');
  });

  test('史卷随日翻新（留白日无笔是设计）；GET 视图带舆图与史卷', async () => {
    const r = await api('POST', '/api/runs', { mode: 'direct', seed: 9, prologue: false, roster: ['anton', 'marta', 'bron'] });
    const id = r.body.id;
    let s = r.body.state;
    assert.ok(s.chronicle.entries.length >= 1, 'D1 开卷即有笔');
    for (let d = 0; d < 2; d++) {
      await sendInput(id, { intents: [{ type: 'advance' }] });
      await sendInput(id, { intents: [{ type: 'dusk_assign', scavenger: null, others: {} }] });
      s = (await view(id)).state;
    }
    const days = s.chronicle.entries.map((e) => e.day);
    assert.ok(days.includes(3), 'D3 逃卒步随日翻新: ' + days.join(','));
    assert.ok(s.mapView && s.chronicle, 'GET 视图携带双轴');
  });
});
