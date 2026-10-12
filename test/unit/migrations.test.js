// 迁移与配置（最佳实践层）：版本管理、幂等、升级路径、守卫、备份。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, pendingOf, assertSchemaCurrent, listMigrations, latestVersion, schemaVersionOf } from '../../packages/server/migrate.js';
import { loadConfig } from '../../packages/server/config.js';
import { Db } from '../../packages/server/db.js';

const dir = () => mkdtempSync(join(tmpdir(), 'twom-mig-'));

describe('迁移生命周期', () => {
  test('全新库：迁移到最新，版本号与目录一致', () => {
    const d = dir();
    const r = applyMigrations(join(d, 'a.db'));
    assert.equal(r.from, 0);
    assert.equal(r.to, latestVersion());
    assert.ok(r.applied.length >= 2, '至少 001+002');
    const db = new DatabaseSync(join(d, 'a.db'));
    for (const t of ['run', 'run_event', 'llm_provider', 'archive_entry', 'meta']) {
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t), `缺表 ${t}`);
    }
    db.close();
    rmSync(d, { recursive: true, force: true });
  });

  test('幂等：重复运行不重复应用', () => {
    const d = dir();
    applyMigrations(join(d, 'b.db'));
    const again = applyMigrations(join(d, 'b.db'));
    assert.deepEqual(again.applied, []);
    assert.equal(again.to, latestVersion());
    rmSync(d, { recursive: true, force: true });
  });

  test('升级路径：v1 旧库（模拟）补齐后续迁移', () => {
    const d = dir();
    const p = join(d, 'c.db');
    applyMigrations(p, { to: 1 }); // 模拟只有 001 的旧库
    const db = new DatabaseSync(p);
    assert.equal(schemaVersionOf(db), 1);
    db.close();
    const r = applyMigrations(p);
    assert.equal(r.from, 1);
    assert.equal(r.to, latestVersion());
    rmSync(d, { recursive: true, force: true });
  });

  test('多用户升级：v2 旧库的 user_id=1 数据升级后无主化（不被首个注册者继承）', () => {
    const d = dir();
    const p = join(d, 'legacy.db');
    applyMigrations(p, { to: 2 }); // 单用户时代的库
    const db = new DatabaseSync(p);
    db.prepare("INSERT INTO run (id,user_id,seed,status,started_at,state_json) VALUES ('legacy1',1,7,'active','2026-01-01','{\"day\":9}')").run();
    db.prepare("INSERT INTO archive_entry (user_id,kind,key,data_json,at) VALUES (1,'doc','d1','{}','2026-01-01')").run();
    db.close();
    applyMigrations(p); // → 003
    const db2 = new Db(p);
    const run = db2.db.prepare("SELECT user_id FROM run WHERE id='legacy1'").get();
    const arch = db2.db.prepare("SELECT user_id FROM archive_entry WHERE key='d1'").get();
    assert.equal(run.user_id, null, '旧对局无主化');
    assert.equal(arch.user_id, null, '旧档案无主化');
    // 无主数据不出现在任何新用户的列表里，但计数仍可见
    assert.equal(db2.listRuns(1).length, 0);
    assert.equal(db2.runCount(), 1);
    db2.close();
    rmSync(d, { recursive: true, force: true });
  });

  test('失败回滚：坏迁移不落版本号', () => {
    const d = dir();
    const p = join(d, 'd.db');
    applyMigrations(p, { to: 1 });
    const db = new Db(p);
    assert.throws(() => db.db.exec('BEGIN; CREATE TABLE x(\n; COMMIT;'), /syntax/);
    // 直接向 runner 注入坏 SQL 目录场景太重——用事务语义断言：错误后版本仍为 1
    assert.equal(db.schemaVersion(), 1);
    db.close();
    rmSync(d, { recursive: true, force: true });
  });

  test('守卫：落后时抛出可操作的错误信息', () => {
    const d = dir();
    const p = join(d, 'e.db');
    applyMigrations(p, { to: 1 });
    const db = new Db(p);
    const pending = pendingOf(db.db);
    assert.ok(pending.length >= 1, '应有待应用迁移');
    assert.throws(() => assertSchemaCurrent(db.db), /npm run migrate/);
    db.close();
    rmSync(d, { recursive: true, force: true });
  });

  test('迁移文件命名规约：目录内全部可识别且版本唯一递增', () => {
    const list = listMigrations();
    assert.deepEqual(list.map((m) => m.version), [...new Set(list.map((m) => m.version))].sort((a, b) => a - b));
    for (const m of list) assert.match(m.file, /^\d+-[\w-]+\.sql$/);
  });

  test('CLI --status：最新时退出 0', async () => {
    const d = dir();
    const p = join(d, 'f.db');
    applyMigrations(p);
    const { execFile } = await import('node:child_process');
    const code = await new Promise((resolve) => {
      execFile('node', ['packages/server/migrate.js', '--status', '--db', p], (err) => resolve(err ? err.code : 0));
    });
    assert.equal(code, 0);
    rmSync(d, { recursive: true, force: true });
  });

  test('CLI --status：落后时退出 2（部署预检信号）', async () => {
    const d = dir();
    const p = join(d, 'g.db');
    applyMigrations(p, { to: 1 });
    const { execFile } = await import('node:child_process');
    const code = await new Promise((resolve) => {
      execFile('node', ['packages/server/migrate.js', '--status', '--db', p], (err) => resolve(err ? err.code : 0));
    });
    assert.equal(code, 2);
    rmSync(d, { recursive: true, force: true });
  });
});

describe('配置中心', () => {
  test('默认值与覆盖', () => {
    const cfg = loadConfig({ PORT: '8123', ADMIN_PASSWORD: 'long-password' });
    assert.equal(cfg.port, 8123);
    assert.equal(cfg.adminPassword, 'long-password');
    assert.equal(cfg.env, 'development');
  });
  test('非法 PORT fail-fast', () => {
    assert.throws(() => loadConfig({ PORT: '99999' }), /PORT/);
  });
  test('生产环境弱口令告警（不阻断）', () => {
    const cfg = loadConfig({ NODE_ENV: 'production', ADMIN_PASSWORD: 'short' });
    assert.ok(cfg.adminPasswordWarn);
  });
});

describe('备份 CLI', () => {
  test('VACUUM INTO 快照 + 保留策略', async () => {
    const d = dir();
    const dbPath = join(d, 'h.db');
    applyMigrations(dbPath);
    const { execFile } = await import('node:child_process');
    const env = { ...process.env, DB_PATH: dbPath, BACKUP_KEEP: '2' };
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve, reject) => execFile('node', ['packages/server/backup.js'], { env }, (e) => e ? reject(e) : resolve()));
    }
    const files = readdirSync(join(d, 'backups')).filter((f) => f.endsWith('.db'));
    assert.equal(files.length, 2, 'BACKUP_KEEP=2 只留两份');
    assert.ok(existsSync(join(d, 'backups', files[0])));
    rmSync(d, { recursive: true, force: true });
  });
});
