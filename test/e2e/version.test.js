// /api/version（公开只读）：版本对账的锚——菜单扉页展示内容包版本与服务启动时间。
// 背景：多轮线上调试都在猜「跑的是哪版」——现在界面直接亮出来。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../packages/server/index.js';
import { applyMigrations } from '../../packages/server/migrate.js';

describe('GET /api/version', () => {
  let app, dir;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'twom-ver-'));
    applyMigrations(join(dir, 'v.db'));
    app = createApp({ dbPath: join(dir, 'v.db'), nodeEnv: 'test' });
    await new Promise((r) => app.server.listen(0, r));
  });
  after(async () => { await new Promise((r) => app.server.close(r)); rmSync(dir, { recursive: true, force: true }); });

  test('免登录返回内容包版本与启动时间', async () => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/version`);
    assert.equal(res.status, 200);
    const v = await res.json();
    assert.match(v.version, /^\d+\.\d+\.\d+$/, 'semver');
    assert.ok(v.startedAt && !Number.isNaN(Date.parse(v.startedAt)), '启动时间可解析');
    assert.ok(v.uptimeSec >= 0, '存活时长');
    assert.equal(v.version, app.pack.manifest.semver, '与内容包 manifest 一致');
  });
});
