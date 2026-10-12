CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS content_pack (id INTEGER PRIMARY KEY AUTOINCREMENT, semver TEXT, manifest_json TEXT, imported_at TEXT);
    CREATE TABLE IF NOT EXISTS content_entity (pack_id INTEGER, kind TEXT, key TEXT, data_json TEXT, sha TEXT, UNIQUE(pack_id, kind, key));
    CREATE TABLE IF NOT EXISTS canon_seal (pack_id INTEGER, seal_key TEXT, trigger_json TEXT, payload_enc TEXT, UNIQUE(pack_id, seal_key));
    CREATE TABLE IF NOT EXISTS llm_provider (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, adapter TEXT NOT NULL,
      base_url TEXT NOT NULL, model TEXT NOT NULL, api_key_enc TEXT, params_json TEXT,
      enabled INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS llm_route (purpose TEXT PRIMARY KEY, provider_id INTEGER, fallback_provider_id INTEGER, overrides_json TEXT);
    CREATE TABLE IF NOT EXISTS llm_health_log (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER, ok INTEGER, latency_ms INTEGER, detail_json TEXT, at TEXT);
    CREATE TABLE IF NOT EXISTS llm_call_log (id INTEGER PRIMARY KEY AUTOINCREMENT, purpose TEXT, provider TEXT, tokens_in INTEGER, tokens_out INTEGER, latency_ms INTEGER, run_id TEXT, ok INTEGER, at TEXT);
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, pass_hash TEXT, is_admin INTEGER DEFAULT 0, created_at TEXT);
    CREATE TABLE IF NOT EXISTS run (
      id TEXT PRIMARY KEY, user_id INTEGER, seed INTEGER, content_pack_id INTEGER,
      difficulty TEXT, mode TEXT, status TEXT, ending_type TEXT,
      started_at TEXT, ended_at TEXT, state_json TEXT, ending_json TEXT
    );
    CREATE TABLE IF NOT EXISTS run_event (run_id TEXT, seq INTEGER, day INTEGER, type TEXT, data_json TEXT, at TEXT, PRIMARY KEY(run_id, seq));
    CREATE TABLE IF NOT EXISTS archive_entry (user_id INTEGER, kind TEXT, key TEXT, data_json TEXT, first_run_id TEXT, at TEXT, UNIQUE(user_id, kind, key));
    CREATE INDEX IF NOT EXISTS idx_run_event_day ON run_event(run_id, day);
    CREATE INDEX IF NOT EXISTS idx_archive_user ON archive_entry(user_id, kind);
