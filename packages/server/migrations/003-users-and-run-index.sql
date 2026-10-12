-- 003: 多用户（注册/登录）。users 表已在 001 预留（name/pass_hash/is_admin）。
-- 单用户时代的对局/档案都写着 user_id=1，但那时 users 表是空的——统一归为无主（NULL）：
-- 普通用户不可见（不落进任何人的列表/档案馆），管理员仍可读（回放/运维）。
UPDATE run SET user_id = NULL WHERE user_id = 1
  AND NOT EXISTS (SELECT 1 FROM users WHERE id = 1);
UPDATE archive_entry SET user_id = NULL WHERE user_id = 1
  AND NOT EXISTS (SELECT 1 FROM users WHERE id = 1);
-- 运维索引：按用户列对局（"我的对局"/续局）。
CREATE INDEX IF NOT EXISTS idx_run_user ON run(user_id, started_at DESC);
