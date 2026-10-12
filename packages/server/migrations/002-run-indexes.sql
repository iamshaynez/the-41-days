-- 002: 运维常用查询索引（对局列表按状态/时间、健康历史按供应商）
CREATE INDEX IF NOT EXISTS idx_run_status_started ON run(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_provider ON llm_health_log(provider_id, id DESC);
