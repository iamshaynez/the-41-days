#!/usr/bin/env node
// 备份 CLI（npm run backup）：WAL 检查点 + VACUUM INTO 快照，保留最近 N 份。
// cron 示例：0 4 * * * cd /app && npm run backup
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadConfig } from './config.js';
import { Db } from './db.js';

const cfg = loadConfig();
const KEEP = Number(process.env.BACKUP_KEEP || 10);
const dir = join(dirname(cfg.dbPath), 'backups');
mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '') + '-' + process.pid;
const out = join(dir, `game-${stamp}.db`);

const db = new Db(cfg.dbPath);
try {
  db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

// 修剪旧备份
const backups = readdirSync(dir).filter((f) => f.startsWith('game-') && f.endsWith('.db'))
  .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
for (const old of backups.slice(KEEP)) unlinkSync(join(dir, old.f));

console.log(`备份完成：${out}（现存 ${Math.min(backups.length, KEEP) + 1} 份，保留上限 ${KEEP}）`);
