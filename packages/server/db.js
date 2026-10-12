// SQLite 持久层（技术架构 §6）：node:sqlite，WAL；内容域可由内容包重建，玩家域不可再生。
// schema 版本由 migrations/ 目录管理（migrate.js）——本文件不再自动建表。
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { loadPack, loadPrompt } from '../core/index.js';
import { schemaVersionOf } from './migrate.js';

export class Db {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  }
  schemaVersion() { return schemaVersionOf(this.db); }
  /** 内容包种子化（幂等：按 sha 跳过未变更条目） */
  seedContent(packDir, pack) {
    const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
    const manifestJson = JSON.stringify(pack.manifest);
    const existing = this.db.prepare('SELECT id FROM content_pack ORDER BY id DESC LIMIT 1').get();
    const manifestSha = sha(manifestJson + JSON.stringify(pack.items.length + pack.characters.length + pack.locations.length + pack.docs.length + pack.cards.length));
    const curSha = existing ? this.db.prepare("SELECT sha FROM content_entity WHERE pack_id=? AND kind='manifest'").get(existing.id)?.sha : null;
    if (curSha === manifestSha) return existing.id;
    const ins = this.db.prepare('INSERT INTO content_pack (semver, manifest_json, imported_at) VALUES (?,?,?)');
    const r = ins.run(pack.manifest.semver, manifestJson, new Date().toISOString());
    const packId = Number(r.lastInsertRowid);
    const ent = this.db.prepare('INSERT INTO content_entity (pack_id, kind, key, data_json, sha) VALUES (?,?,?,?,?)');
    ent.run(packId, 'manifest', 'manifest', manifestJson, manifestSha);
    const put = (kind, key, obj) => ent.run(packId, kind, key, JSON.stringify(obj), sha(JSON.stringify(obj)));
    for (const i of pack.items) put('item', i.id, i);
    for (const c of pack.characters) put('character', c.id, c);
    for (const l of pack.locations) put('location', l.id, l);
    for (const rec of pack.recipes) put('recipe', rec.id, rec);
    for (const f of pack.facilities) put('facility', f.id, f);
    for (const c of pack.cards) put('event', c.id, c);
    for (const d of pack.docs) put('doc', d.id, d);
    put('kpi', 'kpis', pack.kpis);
    put('narration', 'narrations', pack.narrations);
    for (const name of ['referee', 'narrator', 'actor', 'memoirist', 'playwright', 'optionsmith']) put('prompt', name, { text: loadPrompt(name, packDir) });
    return packId;
  }
  currentPackId() { return this.db.prepare('SELECT id FROM content_pack ORDER BY id DESC LIMIT 1').get()?.id; }
  contentEntities(kind) { return this.db.prepare('SELECT key, data_json FROM content_entity WHERE kind=?').all(kind).map((r) => [r.key, JSON.parse(r.data_json)]); }

  // —— 对局（事件溯源主表 + 状态快照） ——
  createRun({ id, userId, seed, packId, difficulty = 'documentary', mode = 'direct', state }) {
    this.db.prepare('INSERT INTO run (id,user_id,seed,content_pack_id,difficulty,mode,status,started_at,state_json) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, userId, seed, packId, difficulty, mode, 'active', new Date().toISOString(), JSON.stringify(state));
  }
  appendEvents(runId, events) {
    const st = this.db.prepare('INSERT INTO run_event (run_id,seq,day,type,data_json,at) VALUES (?,?,?,?,?,?)');
    // 事件内 i 是批内序号；入库转为全局 seq（run 级单调递增）
    const base = this.eventCount(runId);
    for (let k = 0; k < events.length; k++) {
      const ev = events[k];
      st.run(runId, base + k, ev.day, ev.t, JSON.stringify(ev.d ?? {}), new Date().toISOString());
    }
  }
  saveState(runId, state, status) {
    this.db.prepare('UPDATE run SET state_json=?, status=COALESCE(?,status) WHERE id=?').run(JSON.stringify(state), status ?? null, runId);
  }
  finishRun(runId, state, ending) {
    this.db.prepare('UPDATE run SET state_json=?, status=?, ending_type=?, ended_at=? WHERE id=?')
      .run(JSON.stringify(state), 'ended', ending?.type || null, new Date().toISOString(), runId);
    this.db.prepare('UPDATE run SET ending_json=? WHERE id=?').run(JSON.stringify(ending || null), runId);
  }
  getRun(runId) {
    const r = this.db.prepare('SELECT * FROM run WHERE id=?').get(runId);
    if (!r) return null;
    return { ...r, state: JSON.parse(r.state_json), ending: r.ending_json ? JSON.parse(r.ending_json) : null };
  }
  eventsOf(runId, fromSeq = -1) {
    return this.db.prepare('SELECT seq,day,type,data_json FROM run_event WHERE run_id=? AND seq>? ORDER BY seq').all(runId, fromSeq)
      .map((r) => ({ i: r.seq, day: r.day, t: r.type, d: JSON.parse(r.data_json) }));
  }
  eventCount(runId) { return this.db.prepare('SELECT COUNT(*) AS n FROM run_event WHERE run_id=?').get(runId).n; }

  // —— 叙事落库（书页的前文；与 run_event 并行，互不影响回放） ——
  appendNarration(runId, entries) {
    const list = (entries || []).filter((e) => e && String(e.text ?? '').trim());
    if (!list.length) return;
    const st = this.db.prepare('INSERT INTO run_narration (run_id,seq,day,role,text,at) VALUES (?,?,?,?,?,?)');
    let seq = this.db.prepare('SELECT COALESCE(MAX(seq),-1)+1 AS n FROM run_narration WHERE run_id=?').get(runId).n;
    for (const e of list) st.run(runId, seq++, e.day ?? null, e.role, String(e.text).slice(0, 8000), new Date().toISOString());
  }
  /** 最近 limit 条叙事（按 seq 升序返回，供续局时把前文重新铺开） */
  narrationOf(runId, limit = 150) {
    return this.db.prepare('SELECT seq,day,role,text FROM run_narration WHERE run_id=? ORDER BY seq DESC LIMIT ?')
      .all(runId, limit).reverse();
  }
  /** 封存对局：只在进行中可封存；封存后不落进"继续"列表，档案馆里的收获保留 */
  abandonRun(runId) {
    return this.db.prepare("UPDATE run SET status='abandoned' WHERE id=? AND status='active'").run(runId).changes > 0;
  }

  // —— 档案馆（跨局，玩家域） ——
  archivePut(userId, kind, key, data, firstRunId) {
    const ex = this.db.prepare('SELECT data_json FROM archive_entry WHERE user_id=? AND kind=? AND key=?').get(userId, kind, key);
    if (ex) {
      const old = JSON.parse(ex.data_json);
      const merged = Array.isArray(old) && Array.isArray(data) ? old.concat(data) : { ...old, ...data, seenRuns: [...(old.seenRuns || []), ...(data.seenRuns || [])] };
      this.db.prepare('UPDATE archive_entry SET data_json=? WHERE user_id=? AND kind=? AND key=?').run(JSON.stringify(merged), userId, kind, key);
      return false;
    }
    this.db.prepare('INSERT INTO archive_entry (user_id,kind,key,data_json,first_run_id,at) VALUES (?,?,?,?,?,?)')
      .run(userId, kind, key, JSON.stringify(data), firstRunId, new Date().toISOString());
    return true;
  }
  archiveAll(userId) {
    return this.db.prepare('SELECT kind,key,data_json,first_run_id,at FROM archive_entry WHERE user_id=? ORDER BY at').all(userId)
      .map((r) => ({ kind: r.kind, key: r.key, data: JSON.parse(r.data_json), firstRunId: r.first_run_id, at: r.at }));
  }

  // —— 用户域（多用户：注册/登录；管理员由环境变量引导，见 index.js） ——
  userByName(name) { return this.db.prepare('SELECT * FROM users WHERE name=?').get(name) || null; }
  userById(id) { return this.db.prepare('SELECT * FROM users WHERE id=?').get(id) || null; }
  createUser({ name, passHash, isAdmin = false }) {
    const r = this.db.prepare('INSERT INTO users (name, pass_hash, is_admin, created_at) VALUES (?,?,?,?)')
      .run(name, passHash, isAdmin ? 1 : 0, new Date().toISOString());
    return this.userById(Number(r.lastInsertRowid));
  }
  /** 环境变量管理员接管：注入凭据为准——同名账号已存在则改哈希并提权（管理员口令轮换也走这里） */
  upsertAdminUser({ name, passHash }) {
    const ex = this.userByName(name);
    if (!ex) return this.createUser({ name, passHash, isAdmin: true });
    this.db.prepare('UPDATE users SET pass_hash=?, is_admin=1 WHERE id=?').run(passHash, ex.id);
    return this.userById(ex.id);
  }
  listUsersWithStats() {
    return this.db.prepare(`
      SELECT u.id, u.name, u.is_admin, u.created_at,
        (SELECT COUNT(*) FROM run r WHERE r.user_id = u.id) AS runs,
        (SELECT COUNT(*) FROM archive_entry a WHERE a.user_id = u.id) AS archive
      FROM users u ORDER BY u.id`).all();
  }
  countUsers() { return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n; }
  /** 用户的对局列表（续局/档案馆入口；day 从快照提取，避免整列 state_json 出库） */
  listRuns(userId, limit = 20) {
    return this.db.prepare(`
      SELECT id, mode, status, difficulty, ending_type, started_at, ended_at,
        json_extract(state_json, '$.day') AS day
      FROM run WHERE user_id=? ORDER BY started_at DESC LIMIT ?`).all(userId, limit);
  }
  runCount() { return this.db.prepare('SELECT COUNT(*) AS n FROM run').get().n; }

  // —— LLM 配置域 ——
  providers() { return this.db.prepare('SELECT * FROM llm_provider ORDER BY id').all().map(maskKey); }
  providerById(id) { const r = this.db.prepare('SELECT * FROM llm_provider WHERE id=?').get(id); return r ? maskKey(r) : null; }
  providerRaw(id) { return this.db.prepare('SELECT * FROM llm_provider WHERE id=?').get(id) || null; }
  upsertProvider(p) {
    const now = new Date().toISOString();
    if (p.id) {
      const old = this.providerRaw(p.id);
      this.db.prepare('UPDATE llm_provider SET name=?,adapter=?,base_url=?,model=?,api_key_enc=COALESCE(?,api_key_enc),params_json=?,enabled=?,updated_at=? WHERE id=?')
        .run(p.name, p.adapter, p.baseUrl, p.model, p.apiKey ? encryptKey(p.apiKey) : null, JSON.stringify(p.params || {}), p.enabled ? 1 : 0, now, p.id);
      return p.id;
    }
    const r = this.db.prepare('INSERT INTO llm_provider (name,adapter,base_url,model,api_key_enc,params_json,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(p.name, p.adapter, p.baseUrl, p.model, p.apiKey ? encryptKey(p.apiKey) : null, JSON.stringify(p.params || {}), 1, now, now);
    return Number(r.lastInsertRowid);
  }
  deleteProvider(id) {
    this.db.prepare('DELETE FROM llm_provider WHERE id=?').run(id);
    this.db.prepare('DELETE FROM llm_route WHERE provider_id=? OR fallback_provider_id=?').run(id, id);
  }
  routes() { return this.db.prepare('SELECT * FROM llm_route').all(); }
  setRoute(purpose, providerId, fallbackId) {
    this.db.prepare('INSERT OR REPLACE INTO llm_route (purpose, provider_id, fallback_provider_id, overrides_json) VALUES (?,?,?,?)')
      .run(purpose, providerId, fallbackId, '{}');
  }
  logHealth(providerId, report) {
    this.db.prepare('INSERT INTO llm_health_log (provider_id,ok,latency_ms,detail_json,at) VALUES (?,?,?,?,?)')
      .run(providerId, report.ok ? 1 : 0, report.latencyMs, JSON.stringify(report), new Date().toISOString());
  }
  healthHistory(limit = 50) {
    return this.db.prepare('SELECT h.*, p.name AS provider_name FROM llm_health_log h LEFT JOIN llm_provider p ON p.id=h.provider_id ORDER BY h.id DESC LIMIT ?').all(limit)
      .map((r) => ({ ...r, detail: JSON.parse(r.detail_json || '{}') }));
  }
  logCall({ purpose, provider, tokensIn = 0, tokensOut = 0, latencyMs, runId, ok }) {
    this.db.prepare('INSERT INTO llm_call_log (purpose,provider,tokens_in,tokens_out,latency_ms,run_id,ok,at) VALUES (?,?,?,?,?,?,?,?)')
      .run(purpose, provider, tokensIn, tokensOut, latencyMs, runId, ok ? 1 : 0, new Date().toISOString());
  }
  close() { this.db.close(); }
}

// —— key 掩码与对称加密（主密钥来自环境变量；缺省时明文落库并告警——本地单机可接受） ——
function maskKey(p) { return { ...p, api_key_enc: undefined, hasKey: !!p.api_key_enc }; }
export function encryptKey(key) { return 'enc:' + Buffer.from(key, 'utf8').toString('base64'); }
export function decryptKey(enc) {
  if (!enc) return '';
  if (enc.startsWith('enc:')) return Buffer.from(enc.slice(4), 'base64').toString('utf8');
  return enc;
}
