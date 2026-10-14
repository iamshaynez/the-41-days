-- 005: 会话落库——登录态跨重启/重部署存活（"住进这座城，一年不用再报名字"）。
-- 库里只存 sha256(token)：DB 泄漏不等于会话泄漏（cookie 里的原文不可逆推）。
-- 时效走配置（SESSION_TTL_HOURS，默认 8760=365 天）＋ last_seen_at 滑动续期。
CREATE TABLE IF NOT EXISTS session (
  token_hash   TEXT PRIMARY KEY,           -- sha256(cookie 原文) 的 hex
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,           -- epoch ms
  last_seen_at INTEGER NOT NULL            -- epoch ms（滑动续期基准）
);
CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);
CREATE INDEX IF NOT EXISTS idx_session_last_seen ON session(last_seen_at);
