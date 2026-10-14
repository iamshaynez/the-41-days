// L6 e2e：会话落库（登录态跨重启/重部署存活 + 一年 cookie）。
// 场景：应用 A 签发的会话，在同一个库上重建的应用 B（等价于重新部署新版本）依然有效；
// 库里只存 sha256(token)——DB 泄漏不等于会话泄漏。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../packages/server/index.js';
import { applyMigrations } from '../../packages/server/migrate.js';

let dir, dbPath, appA, appB, baseA, baseB;

async function api(base, method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json().catch(() => ({})), res };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'twom-sess-'));
  dbPath = join(dir, 'game.db');
  applyMigrations(dbPath);
});

after(() => {
  appA?.server.close();
  appB?.server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('会话持久化：登录一年不重复，重部署不失活', () => {
  test('签发：cookie Max-Age 为一年（365 天）', async () => {
    appA = createApp({ dbPath, adminUsername: 'admin', adminPassword: 'test-admin-pw' });
    await new Promise((r) => appA.server.listen(0, '127.0.0.1', r));
    baseA = `http://127.0.0.1:${appA.server.address().port}`;
    const su = await api(baseA, 'POST', '/api/auth/signup', { body: { username: 'resident', password: 'secret1' } });
    assert.equal(su.status, 201);
    const cookie = su.res.headers.get('set-cookie');
    assert.match(cookie, /Max-Age=31536000/, 'cookie 时效应为 365 天');
  });

  test('重部署存活：同一库上重建应用，旧 token 照常认人', async () => {
    const login = await api(baseA, 'POST', '/api/auth/login', { body: { username: 'resident', password: 'secret1' } });
    const token = login.json.token;
    assert.ok(token);
    // 应用 A 下线（等价于旧版本进程退出）
    appA.server.close();
    // 应用 B 上线：同一 dbPath 重建（等价于部署新版本）
    appB = createApp({ dbPath, adminUsername: 'admin', adminPassword: 'test-admin-pw' });
    await new Promise((r) => appB.server.listen(0, '127.0.0.1', r));
    baseB = `http://127.0.0.1:${appB.server.address().port}`;
    const me = await api(baseB, 'GET', '/api/auth/me', { token });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.name, 'resident');
  });

  test('登出即失效：删的是库里那一条，重部署也救不回来', async () => {
    const login = await api(baseB, 'POST', '/api/auth/login', { body: { username: 'resident', password: 'secret1' } });
    const token = login.json.token;
    const out = await api(baseB, 'POST', '/api/auth/logout', { token });
    assert.equal(out.status, 200);
    const me = await api(baseB, 'GET', '/api/auth/me', { token });
    assert.equal(me.status, 401);
  });

  test('库里不存原始 token（sha256 摘要）', async () => {
    const login = await api(baseB, 'POST', '/api/auth/login', { body: { username: 'resident', password: 'secret1' } });
    const raw = login.json.token;
    const row = appB.db.db.prepare('SELECT token_hash FROM session').all();
    assert.ok(row.length >= 1);
    for (const r of row) assert.ok(r.token_hash !== raw && r.token_hash.length === 64, '库存的必须是摘要，不是原文');
  });
});
