// 极简结构化日志（零依赖）：级别过滤 + ISO 时间；error 走 stderr。
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
export function makeLogger(level = 'info') {
  const threshold = LEVELS[level] ?? 20;
  const emit = (lv, stream) => (msg, extra) => {
    if (LEVELS[lv] < threshold) return;
    const line = { t: new Date().toISOString(), lv, msg, ...(extra ? { extra } : {}) };
    stream.write(JSON.stringify(line) + '\n');
  };
  return {
    debug: emit('debug', process.stdout),
    info: emit('info', process.stdout),
    warn: emit('warn', process.stdout),
    error: emit('error', process.stderr)
  };
}
