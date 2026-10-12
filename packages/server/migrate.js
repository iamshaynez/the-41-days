// 迁移运行器（运维最佳实践：schema 版本由 migrations/ 目录管理，幂等、可审计、失败回滚）。
// 用法：npm run migrate            应用全部待迁移
//      npm run migrate:status     只看状态（落后时退出码 2，供部署前检查）
//      node packages/server/migrate.js --db /path/x.db  指定库
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, 'migrations');

/** 解析迁移目录：[{version, file, sql}] 升序 */
export function listMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .map((f) => {
      const m = f.match(/^(\d+)-.+\.sql$/);
      return m ? { version: Number(m[1]), file: f, sql: readFileSync(join(dir, f), 'utf8') } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.version - b.version);
}

export function latestVersion(dir = MIGRATIONS_DIR) {
  const list = listMigrations(dir);
  return list.length ? list[list.length - 1].version : 0;
}

function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  return db;
}

export function schemaVersionOf(db) {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version');
  return row ? Number(row.value) : 0;
}

/** 当前库落后了哪些迁移 */
export function pendingOf(db, dir = MIGRATIONS_DIR) {
  const cur = schemaVersionOf(db);
  return listMigrations(dir).filter((m) => m.version > cur);
}

/** 应用迁移（到指定版本，默认最新）。每个迁移在事务内执行，失败回滚并抛错。 */
export function applyMigrations(dbPathOrDb, { to, dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const own = typeof dbPathOrDb === 'string';
  const db = own ? openDb(dbPathOrDb) : dbPathOrDb.db ?? dbPathOrDb;
  const cur = schemaVersionOf(db);
  const target = to ?? latestVersion(dir);
  const applied = [];
  try {
    for (const m of listMigrations(dir)) {
      if (m.version <= cur || m.version > target) continue;
      db.exec('BEGIN');
      try {
        db.exec(m.sql);
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(m.version));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw new Error(`迁移 ${m.file} 失败（已回滚）：${e.message}`);
      }
      applied.push(m.file);
      log(`  ✓ ${m.file}`);
    }
    return { from: cur, to: schemaVersionOf(db), applied };
  } finally {
    if (own) db.close();
  }
}

/** 守卫：schema 落后时给出可操作的错误（服务启动前调用） */
export function assertSchemaCurrent(db, dir = MIGRATIONS_DIR) {
  const pending = pendingOf(db, dir);
  if (pending.length) {
    throw new Error(
      `数据库 schema 落后（当前 v${schemaVersionOf(db)}，最新 v${latestVersion(dir)}；待应用：${pending.map((p) => p.file).join(', ')}）。` +
      `请先运行：npm run migrate`
    );
  }
}

// —— CLI ——
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const defaultDb = process.env.DB_PATH || join(here, '..', '..', 'data', 'game.db');

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = flag('--db') || defaultDb;
  const statusOnly = args.includes('--status');
  const db = openDb(dbPath);
  const pending = pendingOf(db);
  if (statusOnly) {
    console.log(`schema: v${schemaVersionOf(db)} / 最新 v${latestVersion()}`);
    for (const p of pending) console.log('  待应用:', p.file);
    db.close();
    process.exit(pending.length ? 2 : 0);
  }
  if (!pending.length) {
    console.log(`schema 已是最新（v${schemaVersionOf(db)}）—— ${dbPath}`);
    db.close();
    process.exit(0);
  }
  console.log(`迁移 ${dbPath}`);
  const r = applyMigrations(db, { log: (m) => console.log(m) });
  console.log(`完成：v${r.from} → v${r.to}（应用 ${r.applied.length} 个迁移）`);
  db.close();
}
