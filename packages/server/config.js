// 配置中心（最佳实践：环境变量单一入口 + 启动时校验，fail-fast）。
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateUsername } from './auth.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = join(here, '..', '..', 'data', 'game.db');

export function loadConfig(env = process.env) {
  const cfg = {
    env: env.NODE_ENV || 'development',
    port: Number(env.PORT || 3000),
    dbPath: env.DB_PATH || DEFAULT_DB_PATH,
    adminUsername: env.ADMIN_USERNAME || 'admin',
    adminPassword: env.ADMIN_PASSWORD || 'war-admin',
    logLevel: (env.LOG_LEVEL || (cfg_env(env) === 'production' ? 'info' : 'debug')).toLowerCase(),
    inputRatePerMin: Number(env.INPUT_RATE_PER_MIN ?? 120),
    sessionTtlMs: Number(env.SESSION_TTL_HOURS ?? 24) * 3600 * 1000
  };
  // —— 校验（坏的配置在启动第一毫秒就死，不要在第一个请求里死）——
  if (!Number.isInteger(cfg.port) || cfg.port <= 0 || cfg.port > 65535) {
    throw new Error(`PORT 无效：${env.PORT}`);
  }
  if (cfg.inputRatePerMin < 0 || Number.isNaN(cfg.inputRatePerMin)) {
    throw new Error(`INPUT_RATE_PER_MIN 无效：${env.INPUT_RATE_PER_MIN}`);
  }
  if (cfg.env === 'production' && !env.ADMIN_PASSWORD) {
    // 允许默认口令启动，但必须在日志里大声说出来
    cfg.adminPasswordWarn = '生产环境未设置 ADMIN_PASSWORD，正在使用默认口令 war-admin';
  }
  if (cfg.adminPassword.length < 8 && cfg.env === 'production') {
    cfg.adminPasswordWarn = 'ADMIN_PASSWORD 少于 8 位，生产环境建议强口令';
  }
  if (validateUsername(cfg.adminUsername)) {
    throw new Error(`ADMIN_USERNAME 无效（需 2–24 个字母/数字/_/-）：${cfg.adminUsername}`);
  }
  return cfg;
}
function cfg_env(env) { return env.NODE_ENV || 'development'; }
