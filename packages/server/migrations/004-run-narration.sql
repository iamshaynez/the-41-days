-- 004: 叙事落库——每一轮的玩家落笔与世界回应都存下来（书页不随风散）。
-- 用途：续局/刷新时把前文重新铺上纸面（角色=player 批注体，narrator 正文，sys 小字）。
-- 与 run_event（内核事件溯源）分工不同：这里存的是"呈现给玩家的文字"，可再发行，不影响回放。
CREATE TABLE IF NOT EXISTS run_narration (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  day INTEGER,
  role TEXT NOT NULL,              -- player | narrator | sys
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_run_narration_run ON run_narration(run_id, seq);
