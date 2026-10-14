// L6 e2e：管理员全局注册开关——城门开合，只有守城的说了算。
// 关：新住户进不来（signup 403），老住户照常回家（login 200）；
// 开：恢复登记。开关只有管理员能动，状态对公众只读可查（落地页要显「暂不开放」）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../packages/server/index.js';
import { applyMigrations } from '../../packages/server/migrate.js';

let app, base, dir;
const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'twom-signup-'));
  const dbPath = join(dir, 'game.db');
  applyMigrations(dbPath);
  app = createApp({ dbPath, adminUsername: 'admin', adminPassword: 'test-admin-pw' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.close(); rmSync(dir, { recursive: true, force: true }); });

describe('管理员全局注册开关', () => {
  test('默认开放：注册即入城', async () => {
    const st = await api('GET', '/api/auth/signup-open');
    assert.equal(st.status, 200);
    assert.equal(st.json.open, true);
    const su = await api('POST', '/api/auth/signup', { body: { username: 'oldfriend', password: 'secret1' } });
    assert.equal(su.status, 201);
  });

  test('管理员合上城门：新登记被拒，老住户照常回家', async () => {
    const login = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test-admin-pw' } });
    assert.equal(login.status, 200);
    const admin = login.json.token;

    const off = await api('POST', '/api/admin/signup-toggle', { token: admin, body: { open: false } });
    assert.equal(off.status, 200, JSON.stringify(off.json));

    const su = await api('POST', '/api/auth/signup', { body: { username: 'newcomer', password: 'secret1' } });
    assert.equal(su.status, 403, '城门已闭，新住户进不来');
    assert.ok(su.json.error, '拒绝要有话');

    const back = await api('POST', '/api/auth/login', { body: { username: 'oldfriend', password: 'secret1' } });
    assert.equal(back.status, 200, '老住户不受影响');

    const st = await api('GET', '/api/auth/signup-open');
    assert.equal(st.json.open, false, '公众查询要如实报「暂不开放」');
  });

  test('开关只听管理员的：普通用户动不了', async () => {
    const me = await api('POST', '/api/auth/login', { body: { username: 'oldfriend', password: 'secret1' } });
    const r = await api('POST', '/api/admin/signup-toggle', { token: me.json.token, body: { open: true } });
    assert.equal(r.status, 401, '非管理员不得动城门');
    const st = await api('GET', '/api/auth/signup-open');
    assert.equal(st.json.open, false, '状态没被偷改');
  });

  test('重开城门：登记恢复（状态跨重启——落在库里）', async () => {
    const login = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test-admin-pw' } });
    const on = await api('POST', '/api/admin/signup-toggle', { token: login.json.token, body: { open: true } });
    assert.equal(on.status, 200);
    const su = await api('POST', '/api/auth/signup', { body: { username: 'newcomer', password: 'secret1' } });
    assert.equal(su.status, 201);
    // 落库验证：meta 表里的开关值
    assert.equal(app.db.db.prepare("SELECT value FROM meta WHERE key='signup_open'").get().value, '1');
  });
});
