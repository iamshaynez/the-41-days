// 叙事双轴 e2e（叙事双轴-v0.1）：序章三幕 HTTP 全链、开场二选一（拍板 v4）、舆图/史卷视图、跳过
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
  test('开场选「完整」：三幕全量推进；推到第 1 天即有史卷与舆图', async () => {
    const r = await api('POST', '/api/runs', { mode: 'direct', seed: 7, roster: ['zofia', 'anton', 'marta'] });
    assert.equal(r.status, 200);
    const id = r.body.id;
    let s = r.body.state;
    assert.equal(s.phase, 'prologue');
    assert.equal(s.preludeView.id, 'openingChoice', '第一拍是开场二选一');
    await sendInput(id, { intents: [{ type: 'prelude_full' }] });
    s = (await view(id)).state;
    assert.equal(s.preludeView.canSkip, false, '选了完整三幕就不可跳');
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

  test('开场二选一（拍板 v4）：每一局都从「完整 or 精简」开始，与账号历史无关', async () => {
    // 新账号的第一局：第一拍就是选择，选「完整」翻全卷、选「精简」单句天下
    const r1 = await api('POST', '/api/runs', { mode: 'direct', seed: 11, roster: ['anton', 'marta', 'bron'] });
    assert.equal(r1.body.state.preludeView.id, 'openingChoice', '首局也有开场二选一');
    // 拣「精简开场」：下一拍是单句天下
    await sendInput(r1.body.id, { intents: [{ type: 'advance' }] });
    let s1 = (await view(r1.body.id)).state;
    assert.equal(s1.preludeView.id, 'heavenLine', '精简开场进单句版');
    assert.equal(s1.preludeView.canSkip, true, '精简版可跳');
    // 局一人为收束为全灭（wiped）——下一局仍有开场选择（旧首局门废止）
    const st1 = app.db.getRun(r1.body.id).state;
    st1.over = true; st1.ending = { type: 'wiped' };
    app.db.finishRun(r1.body.id, st1, st1.ending);
    const r2 = await api('POST', '/api/runs', { mode: 'direct', seed: 12, roster: ['anton', 'marta', 'bron'] });
    assert.equal(r2.body.state.preludeView.id, 'openingChoice', '全灭之后的新局同样从选择开始');
    // 拣「完整开场」：模式翻全、此后不可跳、拍数多于精简版
    await sendInput(r2.body.id, { intents: [{ type: 'prelude_full' }] });
    const s2 = (await view(r2.body.id)).state;
    assert.equal(s2.preludeMode, 'full', '模式翻全');
    assert.equal(s2.preludeView.canSkip, false, '完整三幕不设快门');
    assert.ok(s2.preludeView.total > s1.preludeView.total, '完整版拍数更多');
    // 通关（ceasefire）之后的新局：不因通关被夺走选择——仍然从二选一开始
    const st2 = app.db.getRun(r2.body.id).state;
    st2.over = true; st2.ending = { type: 'ceasefire' };
    app.db.finishRun(r2.body.id, st2, st2.ending);
    const r3 = await api('POST', '/api/runs', { mode: 'direct', seed: 13, roster: ['anton', 'marta', 'bron'] });
    assert.equal(r3.body.state.preludeView.id, 'openingChoice', '通关之后仍从选择开始');
    assert.equal(r3.body.state.preludeView.canSkip, true, '选择拍本身可跳（选定精简后即可翻过）');
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
