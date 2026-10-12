// 开发入口（npm run dev）：先迁移再启动，热重启（node --watch 监视 packages 与 content）。
// 新增迁移文件或改内容包都会触发完整重启（含重新迁移），所见即所得。
import { applyMigrations } from './migrate.js';
import { loadConfig } from './config.js';
import { makeLogger } from './log.js';
import { createApp } from './index.js';

const cfg = loadConfig();
const log = makeLogger(cfg.logLevel);
const r = applyMigrations(cfg.dbPath, { log: (m) => log.info(m.trim()) });
if (r.applied.length) log.info(`迁移完成：v${r.from} → v${r.to}`);

const app = createApp({ ...cfg });
const stop = (sig) => {
  app.log.info(`收到 ${sig}，开发服务关停…`);
  app.server.close(() => { app.db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

app.server.listen(cfg.port, () => {
  log.info(`《第 41 天》dev → http://127.0.0.1:${cfg.port} （--watch 已开启：改 packages/ 或 content/ 自动重启）`);
});
