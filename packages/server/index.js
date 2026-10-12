// HTTP 服务（技术架构 §8）：REST + SSE、会话编排、管理面（LLM 配置/连通测试/内容/回放）。
// 单进程、零依赖：node:http + node:sqlite + core/llm 包。
import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Db, decryptKey } from './db.js';
import { loadConfig } from './config.js';
import { makeLogger } from './log.js';
import { hashPassword, verifyPassword, validateUsername, validatePassword, sessionCookie, clearSessionCookie, publicUser } from './auth.js';
import { assertSchemaCurrent, latestVersion } from './migrate.js';
import pkg from '../../package.json' with { type: 'json' };
import { worldBrief, renderDirect } from './narrate.js';
import { loadPack, loadPrompt, createRun, beginRun, resolveInput, parseDirect, fold, optionAvailable, aliveChars, apMaxOf, renderMemoirDirect, memoirLint, planDusk, planNightStep, dawnProblems, suggests, freeExamples, policyOf, validateIntentShape } from '../core/index.js';
import { makeProvider, healthCheck } from '../llm/index.js';
import { referee, narrator, memoirist, optionsmith } from '../llm/index.js';
import { stagedirector } from '../llm/gateway.js';
import { applySceneEffects } from '../core/index.js';
import { anchorPool } from '../core/src/ge.js';
import { collectEchoes, archiveOutcome, closureStatus, composeMemoirBook } from './echoes.js';
import { createGeDirector } from './ge.js';
import { validateOptions, cardBrief } from './options.js';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(here, '..', 'web', 'public');
const PACK_DIR = join(here, '..', '..', 'content', 'base');

export function createApp({ dbPath, adminUsername, adminPassword, inputRatePerMin, sessionTtlMs, logLevel, nodeEnv } = {}) {
  // 显式参数 > 环境变量 > 默认值（只传实际存在的键，避免 undefined 覆盖）
  const overrides = {};
  for (const k of ['PORT', 'DB_PATH', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'LOG_LEVEL', 'INPUT_RATE_PER_MIN', 'SESSION_TTL_HOURS', 'NODE_ENV']) {
    if (process.env[k] !== undefined) overrides[k] = process.env[k];
  }
  if (dbPath !== undefined) overrides.DB_PATH = dbPath;
  if (adminUsername !== undefined) overrides.ADMIN_USERNAME = adminUsername;
  if (adminPassword !== undefined) overrides.ADMIN_PASSWORD = adminPassword;
  if (inputRatePerMin !== undefined) overrides.INPUT_RATE_PER_MIN = String(inputRatePerMin);
  if (sessionTtlMs !== undefined) overrides.SESSION_TTL_HOURS = String(sessionTtlMs / 3600000);
  if (logLevel !== undefined) overrides.LOG_LEVEL = logLevel;
  if (nodeEnv !== undefined) overrides.NODE_ENV = nodeEnv;
  const cfg = loadConfig(overrides);
  const log = makeLogger(cfg.logLevel);
  const db = new Db(cfg.dbPath);
  // schema 守卫：落后即拒启（迁移是显式操作：npm run migrate）
  assertSchemaCurrent(db.db);  // 传原生 DatabaseSync（pendingOf 直接 prepare）
  const pack = loadPack(PACK_DIR);
  const packId = db.seedContent(PACK_DIR, pack);
  const sessions = new Map(); // token -> {userId, name, admin, at}
  const SESSION_TTL = cfg.sessionTtlMs;
  const COOKIE_NAME = 'twom_session';
  const DUMMY_HASH = hashPassword('twom-timing-pad'); // 用户不存在时也跑一次同代价校验，抹平时间差
  const startedAt = Date.now();
  if (cfg.adminPasswordWarn) log.warn(cfg.adminPasswordWarn);
  // 输入限流（内存令牌桶，单机足够；0 = 关闭）
  const RATE = cfg.inputRatePerMin;
  const buckets = new Map(); // ip -> {n, windowStart}
  const promptsCache = loadPrompts();
  const optionRefresh = new Map(); // runId:card:day -> 已刷新次数（内存即可）

  function loadPrompts() {
    const ents = Object.fromEntries(db.contentEntities('prompt'));
    // 老库缺条目（如新加的 optionsmith）时兜底读内容包原文件——提示词永远不允许是空的
    const fromDisk = (n) => { try { return loadPrompt(n, PACK_DIR); } catch { return ''; } };
    const pick = (n) => ents[n]?.text || fromDisk(n);
    return { referee: pick('referee'), narrator: pick('narrator'), actor: pick('actor'), memoirist: pick('memoirist'), playwright: pick('playwright'), optionsmith: pick('optionsmith'), stage: pick('stage') };
  }

  // —— C 层导演（GE：LLM 在配才在场；离线即关，游戏完整可玩） ——
  const geDirector = createGeDirector({
    pack,
    prompts: promptsCache,
    getProvider: () => { try { const g = buildGateway('ge'); return g?.providers?.referee || g?.providers?.narrator || null; } catch { return null; } }, // GE 永远不能弄坏一个回合
    log: (msg, extra) => log.info(msg, extra)
  });

  // —— LLM 网关构造（按路由表） ——
  function buildGateway(runId) {
    const routes = db.routes();
    const providers = {};
    for (const r of routes) {
      const p = r.provider_id ? db.providerRaw(r.provider_id) : null;
      const f = r.fallback_provider_id ? db.providerRaw(r.fallback_provider_id) : null;
      // adapter 必须随行传入——漏了它，anthropic-compat 会被静默当成 openai 兼容
      //（打到 /chat/completions 上，GLM 网关用 HTTP200 包 404，整层无声降级成直读）
      if (p && p.enabled) providers[r.purpose] = makeProvider({ adapter: p.adapter, baseUrl: p.base_url, model: p.model, apiKey: decryptKey(p.api_key_enc), ...(JSON.parse(p.params_json || '{}')) });
      if (f && f.enabled) providers[r.purpose + ':fallback'] = makeProvider({ adapter: f.adapter, baseUrl: f.base_url, model: f.model, apiKey: decryptKey(f.api_key_enc), ...(JSON.parse(f.params_json || '{}')) });
    }
    if (!Object.keys(providers).length) return null;
    const gw = { providers };
    return {
      providers, // C 层导演（GE）直接取 provider；裁判/叙事走下面的方法
      async parse(input, state) {
        const t0 = Date.now();
        const r = await referee({
          provider: providers.referee || providers.narrator,
          prompts: promptsCache,
          worldBrief: worldBrief(state, pack),
          dayActions: 'eat/cook/craft/build/treat/talk/guard/sleep/rest/listen_radio/search_home/open_room/chop/repair/read/play_piano',
          duskActions: 'dusk_assign( scavenger/location/gear/others )',
          nightScene: state.night && !state.night.home ? 'move/observe/search/open/clear/bars/dialogue/attack/backstab/retreat' : '',
          merchant: state.franko ? `${state.franko.merchant} 摊位在售：${state.franko.stock.filter((s) => s.n > 0).map((s) => `${s.item}×${s.n}@${s.buy}`).join(' ')}` : ''
        }, input, (text) => parseDirect(state, pack, text));
        db.logCall({ purpose: 'referee', provider: r?.via || 'llm', latencyMs: Date.now() - t0, runId, ok: r.ok });
        return r;
      },
      async narrate(facts, state, onDelta) {
        const t0 = Date.now();
        try {
          const out = await narrator({ provider: providers.narrator || providers.referee, prompts: promptsCache, worldBrief: worldBrief(state, pack) }, facts, onDelta);
          db.logCall({ purpose: 'narrator', provider: out.via || 'llm', latencyMs: Date.now() - t0, runId, ok: true });
          return out.text;
        } catch (e) {
          db.logCall({ purpose: 'narrator', provider: 'degraded', latencyMs: Date.now() - t0, runId, ok: false });
          return null;
        }
      },
      async memoir(storyline, onDelta) {
        const t0 = Date.now();
        try {
          const out = await memoirist({ provider: providers.narrator || providers.referee, prompts: promptsCache }, storyline, onDelta);
          db.logCall({ purpose: 'memoirist', provider: out.via || 'llm', latencyMs: Date.now() - t0, runId, ok: true });
          return out.text;
        } catch (e) {
          db.logCall({ purpose: 'memoirist', provider: 'degraded', latencyMs: Date.now() - t0, runId, ok: false });
          return null;
        }
      }
    };
  }

  /** 结局入档（长线体验 §3：档案馆跨局沉淀）——实现见 ./echoes.js */
  function archiveRun(userId, runId, st) {
    archiveOutcome(db, userId, runId, st);
  }

  /**
   * 终局 finalize（EPI-02）：文学复盘三链路——
   * LLM 回忆录 → N-02 事实校验（memoirLint）→ 失败回退直读模板。之后落库 + 入档。
   */
  async function finalizeEndedRun(userId, runId, st, gw, onMemoirDelta) {
    const storyline = st.ending?.storyline;
    if (storyline && !st.ending.memoir) {
      let memoir = gw ? await gw.memoir(storyline, onMemoirDelta) : null;
      if (!memoirLint(memoir, storyline, pack)) memoir = null; // N-02：幻觉即回退
      st.ending.memoir = memoir || renderMemoirDirect(storyline, pack);
      st.ending.memoirVia = memoir ? 'llm' : 'direct';
    }
    db.finishRun(runId, st, st.ending);
    archiveRun(userId, runId, st);
  }

  // —— 状态富化（给 UI 的视图） ——
  function enrich(state) {
    const view = { ...state };
    view.itemNames = Object.fromEntries(pack.items.map((i) => [i.id, i.name]));
    // 事件卡视图（黄昏命运卡除外——它并进黄昏方案卡；夜访未定方针时也让位给方针卡）
    if (state.activeEvent && !state.activeEvent.duskFate
      && !(state.night && !state.night.home && !state.night.directive && !state.night.micro)) {
      const card = pack.cardMap[state.activeEvent.cardId] || state.geCards?.[state.activeEvent.cardId]; // C 层生成卡走 run 级卡册
      if (card) {
        const names = state.chars.map((c) => c.name).join('、');
        // 用 ctx 检查选项可用性（无副作用：只读检查）
        view.eventView = {
          title: card.title, text: (card.text || '').replaceAll('{{names}}', names).replaceAll('{{wish_name}}', state.echoes?.wish?.charName || '前人'),
          options: (card.options || []).map((o) => ({ key: o.key, label: o.label }))
        };
      }
    }
    // 交易已沉入水下（统一交互面）：管家在商人到访时自理（planDay），不再有价目卡；
    // 想干预的玩家用自由文本开价（trade_op）或种念头——世界简报仍报商人行踪。
    // 夜间场景视图
    if (state.night && !state.night.home) {
      const loc = pack.locMap[state.night.locId];
      const room = loc.rooms.find((r) => r.id === state.night.room);
      const idx = loc.rooms.indexOf(room);
      const st = state.locState[state.night.locId] || { searched: {} };
      view.nightView = {
        loc: loc.name, slots: state.night.slots, noise: state.night.noise,
        room: room.name, rooms: loc.rooms.map((r, i) => ({ id: r.id, name: r.name, door: r.door, adjacent: Math.abs(i - idx) === 1 })),
        containers: (room.containers || []).map((c) => ({ id: c.id, name: c.name, locked: c.type === 'locked' && !st.searched[c.id + ':open'], searched: !!st.searched[c.id] })),
        npcs: (loc.npcs || []).map((n) => ({ id: n.id, name: n.name, stance: n.stance, state: st.npcState[n.id] || 'unknown' }))
      };
      // 夜间双模（宏观方针 / 微观岔路）：
      // 未选方针且未进微操 → 方针卡（一次决策整夜自走，开局撞上的夜事件也归方针自动应答）；
      // 微操 → 岔路停问照旧
      if (!state.night.directive && !state.night.micro) {
        view.nightView.directives = [
          { stance: 'cautious', label: '谨慎走：不出声，见人就绕', hint: '少拿少惹，平安到家' },
          { stance: 'normal', label: '照常走一遭：看情况拿，看情况避', hint: '见了人就说话，不对付就绕' },
          { stance: 'bold', label: '放手干：值钱的都拿，挡路的敢动手', hint: '收获大，动静也大' }
        ];
      } else if (!state.activeEvent) {
        const step = planNightStep(state, pack, {});
        if (step?.stop && step.stop.kind !== 'event') view.nightView.fork = { kind: step.stop.kind, text: step.stop.text, options: step.stop.options };
      }
    }
    // 黄昏决策卡（每晚必答）：2~3 个完整方案，点一个或自己说。
    // 黄昏命运卡（duskFate）与方案卡同屏：方案照常，命运作为追加问题；出门即路过。
    if (state.phase === 'dusk' && !state.over && (!state.activeEvent || state.activeEvent.duskFate)) {
      view.duskView = planDusk(state, pack);
      if (state.activeEvent?.duskFate) {
        const card = pack.cardMap[state.activeEvent.cardId] || state.geCards?.[state.activeEvent.cardId];
        if (card) view.duskView.fate = {
          title: card.title, text: card.text || '',
          options: (card.options || []).map((o) => ({ key: o.key, label: o.label }))
        };
      }
    }
    // 晨报问题前置（白天）：火烧眉毛的事 + 主建议入口
    if (state.phase === 'day' && !state.over) {
      const problems = dawnProblems(state, pack);
      if (problems.length) view.careView = { title: '今天需要注意', problems };
    }
    // 情境建议（替代静态 chips）：玩家可能想说的话，由状态现算
    view.suggests = suggests(state, pack);
    view.policy = policyOf(state);
    // v3 命运导演：活着的念头（晨报区展示）+ 自由输入语境示例（停问卡末位输入行）
    view.directions = Object.values(state.directions || {}).filter((d) => d.alive).map((d) => ({
      id: d.id, text: d.text, day: d.day,
      name: d.subject ? (state.chars.find((c) => c.id === d.subject)?.name || d.subject) : '这个家'
    }));
    view.freeExamples = freeExamples(state, pack);
    // 人物视图（人话状态；desc 供名词情报卡引用——只转述内核已知，不现编）
    view.charView = state.chars.map((c) => ({
      id: c.id, name: c.name, role: c.role, alive: c.alive, desc: c.desc || '',
      hunger: ['濒死', '严重饥饿', '饥饿', '正常', '饱足'][c.hunger],
      mood: moodName(c.moodPts), ap: c.ap, apMax: apMaxOf(c),
      wound: ['无', '轻伤', '重伤', '危重'][c.wound], sick: ['无', '微恙', '重病', '危重'][c.sick],
      fatigue: ['正常', '疲惫', '力竭'][c.fatigue], breakdown: !!c.breakdown
    }));
    view.packVersion = pack.manifest.semver;
    return view;
  }
  function moodName(pts) {
    if (pts >= 4) return '坚定'; if (pts >= -3) return '平静'; if (pts >= -8) return '低落'; if (pts >= -13) return '抑郁'; return '崩溃';
  }

  // —— 路由 ——
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(obj)); };
  const bearerOrCookie = (req) => {
    const h = req.headers.authorization || '';
    return h.replace(/^Bearer\s+/i, '') || parseCookie(req.headers.cookie || '')[COOKIE_NAME] || '';
  };
  const auth = (req) => {
    const s = sessions.get(bearerOrCookie(req));
    if (!s) return null;
    if (Date.now() - s.at > SESSION_TTL) { sessions.delete(bearerOrCookie(req)); return null; }
    return s;
  };
  /** 签发会话：内存表 + HttpOnly cookie（浏览器自动携带；API/测试可用 Bearer） */
  function issueSession(res, user) {
    for (const [k, v] of sessions) if (Date.now() - v.at > SESSION_TTL) sessions.delete(k);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { userId: user.id, name: user.name, admin: !!user.is_admin, at: Date.now() });
    res.setHeader('set-cookie', sessionCookie(COOKIE_NAME, token, Math.floor(SESSION_TTL / 1000)));
    return token;
  }
  function rateLimited(ip) {
    if (RATE <= 0) return false;
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b || now - b.windowStart > 60000) { b = { n: 0, windowStart: now }; buckets.set(ip, b); }
    b.n++;
    return b.n > RATE;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    try {
      // —— 健康 ——
      if (path === '/healthz') return json(res, 200, {
        ok: true, app: pkg.version, schema: db.schemaVersion(), schemaLatest: latestVersion(),
        pack: pack.manifest.semver, runs: db.runCount(), users: db.countUsers(), uptimeSec: Math.floor((Date.now() - startedAt) / 1000)
      });

      // 静态资源
      if ((req.method === 'GET' || req.method === 'HEAD') && !path.startsWith('/api/')) return await staticFile(path, res);

      // —— 认证（多用户：注册 / 登录 / 登出 / 我是谁） ——
      if (path === '/api/auth/signup' && req.method === 'POST') {
        if (rateLimited(req.socket.remoteAddress || '?')) return json(res, 429, { error: '请求太快了，稍等一下。' });
        const body = await readBody(req);
        const name = typeof body.username === 'string' ? body.username.trim() : '';
        const pw = typeof body.password === 'string' ? body.password : '';
        const nameErr = validateUsername(name);
        if (nameErr) return json(res, 400, { error: nameErr });
        const pwErr = validatePassword(pw);
        if (pwErr) return json(res, 400, { error: pwErr });
        if (name === cfg.adminUsername) return json(res, 403, { error: '这个名字留给管理员，请换一个。' });
        if (db.userByName(name)) return json(res, 409, { error: '这个名字已经有人用了。' });
        let user;
        try {
          user = db.createUser({ name, passHash: hashPassword(pw) });
        } catch {
          return json(res, 409, { error: '这个名字已经有人用了。' }); // UNIQUE 兜底（并发注册）
        }
        log.info('新用户注册', { userId: user.id, name });
        const token = issueSession(res, user);
        return json(res, 201, { token, user: publicUser(user) });
      }

      if (path === '/api/auth/login' && req.method === 'POST') {
        if (rateLimited(req.socket.remoteAddress || '?')) return json(res, 429, { error: '请求太快了，稍等一下。' });
        const body = await readBody(req);
        const name = typeof body.username === 'string' ? body.username.trim() : '';
        const pw = typeof body.password === 'string' ? body.password : '';
        let user = null;
        // 管理员引导：环境变量凭据首次登录 → 创建 is_admin=1 记录；
        // 之后仍以环境变量为准（改口令/提权都在这里生效）——注入的凭据就是运营者的证明。
        if (name === cfg.adminUsername && pw === cfg.adminPassword) {
          user = db.upsertAdminUser({ name, passHash: hashPassword(pw) });
          log.info('管理员登录（环境变量凭据）', { userId: user.id, name });
        } else {
          const u = db.userByName(name);
          if (u && verifyPassword(pw, u.pass_hash)) user = u;
          else verifyPassword(pw, DUMMY_HASH); // 不存在/口令不符也付同样的哈希代价，抹平时间差
        }
        if (!user) return json(res, 401, { error: '用户名或口令不对。' });
        const token = issueSession(res, user);
        return json(res, 200, { token, user: publicUser(user) });
      }

      if (path === '/api/auth/logout' && req.method === 'POST') {
        const token = bearerOrCookie(req);
        if (token) sessions.delete(token);
        res.setHeader('set-cookie', clearSessionCookie(COOKIE_NAME));
        return json(res, 200, { ok: true });
      }

      if (path === '/api/auth/me' && req.method === 'GET') {
        const s = auth(req);
        if (!s) return json(res, 401, { error: '未登录' });
        return json(res, 200, { user: { id: s.userId, name: s.name, is_admin: s.admin } });
      }

      // —— 游戏（登录用户的私有数据：对局与档案馆按 user_id 隔离） ——
      if (req.method === 'GET' && path === '/api/runs') {
        const s = auth(req);
        if (!s) return json(res, 401, { error: '请先登录。' });
        // engine 供开局页提示（只报配置状态，不泄露供应商细节）
        return json(res, 200, { runs: db.listRuns(s.userId), engine: db.routes().length ? 'llm' : 'direct' });
      }

      if (req.method === 'POST' && path === '/api/runs') {
        const s = auth(req);
        if (!s) return json(res, 401, { error: '请先登录。' });
        const body = await readBody(req);
        // 玩家侧没有模式选择：配了 LLM 路由就是 LLM；否则直读兜底运行（直读不是游戏模式，是测试与降级通道）。
        // body.mode === 'direct' 是测试/开发的显式后门，UI 不提供。
        const mode = body.mode === 'direct' ? 'direct' : (db.routes().length ? 'llm' : 'direct');
        const id = randomUUID().slice(0, 8);
        // 别传局：固定阵容/天数/开局修饰，序章不演（别传有自己的开场）
        const sideDef = body.sidestory ? pack.sideMap?.[body.sidestory] : null;
        if (body.sidestory && !sideDef) return json(res, 404, { error: '没有这个别传。' });
        if (sideDef && !sideUnlocked(sideDef.unlock, db.archiveAll(s.userId))) {
          return json(res, 403, { error: '这扇门还没认你。', hint: sideDef.unlockHint });
        }
        const prologue = body.sidestory ? false : body.prologue !== false; // 玩家局默认带序章（围城头九天）；测试/sim 显式关闭
        // —— 跨周目回响装配（长线体验 EC 系）：档案馆里有什么，新局就从什么里长出来 ——
        const echoes = collectEchoes(db, s.userId);
        const state = createRun(pack, { seed: body.seed || Math.floor(Math.random() * 1e9), difficulty: body.difficulty || 'documentary', roster: body.roster, prologue, echoes, sidestory: sideDef?.id || null });
        const { events } = beginRun(state, pack, { prologue });
        db.createRun({ id, userId: s.userId, seed: state.seed, packId, difficulty: state.difficulty, mode, state });
        db.appendEvents(id, events);
        return json(res, 200, { id, mode, state: enrich(state) });
      }

      // 对局访问（读/输入/确认计划共用）：本人或管理员，其余一律 404（不泄露存在性）
      const loadOwnRun = (id) => {
        const s = auth(req);
        if (!s) { json(res, 401, { error: '请先登录。' }); return null; }
        const run = db.getRun(id);
        if (!run || (run.user_id !== s.userId && !s.admin)) { json(res, 404, { error: 'run not found' }); return null; }
        return { s, run };
      };

      // 时间胶囊（EC-02）：局终后埋下一件物品 + 一句话，后续周目的后院真的会挖到
      const capsuleMatch = path.match(/^\/api\/runs\/([^/]+)\/capsule$/);
      if (capsuleMatch && req.method === 'POST') {
        const ctx = loadOwnRun(capsuleMatch[1]);
        if (!ctx) return;
        const { s, run } = ctx;
        const body = await readBody(req);
        const item = String(body.item || '');
        const message = String(body.message || '').trim();
        const def = pack.itemMap[item];
        if (!def || def.docOnly) return json(res, 400, { error: '这件东西埋不了。' });
        if (!message || message.length > 100) return json(res, 400, { error: '留话要在一百字以内。' });
        if (run.status !== 'ended') return json(res, 409, { error: '这一局还没落幕。' });
        if ((run.state?.inventory?.[item] || 0) < 1) return json(res, 400, { error: '终局时手里没有这件东西。' });
        const active = db.archiveAll(s.userId).filter((e) => e.kind === 'capsule');
        if (active.length >= 5) return json(res, 409, { error: '这座城的角落最多替你记五处。' });
        const key = 'cap_' + randomUUID().slice(0, 8);
        db.archivePut(s.userId, 'capsule', key, { item, message, fromRun: run.id, itemName: def.name }, run.id);
        return json(res, 200, { ok: true, key });
      }


      if (req.method === 'GET' && path.startsWith('/api/runs/') && path.endsWith('/events')) {
        const id = path.split('/')[3];
        const ctx = loadOwnRun(id);
        if (!ctx) return;
        const from = Number(url.searchParams.get('from') || 0);
        return json(res, 200, { events: db.eventsOf(id, from) });
      }
      if (req.method === 'GET' && path.startsWith('/api/runs/')) {
        const id = path.split('/')[3] === 'events' ? null : path.split('/')[3];
        const ctx = id ? loadOwnRun(id) : null;
        if (!ctx) return;
        const run = ctx.run;
        return json(res, 200, { id: run.id, mode: run.mode, status: run.status, state: enrich(run.state), ending: run.ending, history: db.narrationOf(run.id) });
      }

      // 封存对局（玩家主动合上这本书：不进"继续"列表，档案馆收获保留）
      if (req.method === 'POST' && /^\/api\/runs\/[^/]+\/abandon$/.test(path)) {
        const id = path.split('/')[3];
        const ctx = loadOwnRun(id);
        if (!ctx) return;
        if (ctx.run.status !== 'active') return json(res, 400, { error: '这一局已经结束了。' });
        db.abandonRun(id);
        log.info('对局被封存', { runId: id, userId: ctx.s.userId });
        return json(res, 200, { ok: true });
      }

      // 玩家输入 → SSE（叙事流式 + 终态）
      if (req.method === 'POST' && /^\/api\/runs\/[^/]+\/input$/.test(path)) {
        const id = path.split('/')[3];
        const ctx = loadOwnRun(id);
        if (!ctx) return;
        const { s, run } = ctx;
        if (run.status === 'ended') return json(res, 400, { error: 'run ended' });
        if (rateLimited(req.socket.remoteAddress || '?')) return json(res, 429, { error: '说话太快了，喘口气。' });
        const body = await readBody(req);
        const input = String(body.input || '').slice(0, 2000);
        // 玩家落笔的"书页文字"：决策卡用按钮的 label，自由输入用原文——落库的前文与玩家所见一致
        const display = String(body.display || input || '').slice(0, 500);
        const state = run.state;
        const ink = []; // 本轮要落库的书页文字（player 批注 + narrator 正文 + sys 小字）
        if (display.trim()) ink.push({ day: state.day, role: 'player', text: display });

        // 意图解析：决策卡直传结构化意图（v2）→ LLM 裁判 → 直读兜底（同一 schema，同一 resolve 管线）
        let intents = [], clarify = null, say = null, echo = null, degraded = false;
        const gw = run.mode === 'llm' ? buildGateway(id) : null;
        if (Array.isArray(body.intents) && body.intents.length) {
          intents = body.intents.filter(validateIntentShape).slice(0, 20);
          if (!intents.length) {
            json(res, 400, { error: '无效意图' });
            return;
          }
        } else if (gw) {
          const r = await gw.parse(input, state);
          if (r.ok && !r.degraded) { intents = r.intents; clarify = r.clarify; say = r.say; echo = r.echo || null; }
          else degraded = true;
          // 直读兜底只在降级或真的一无所获时跑——echo 是合法的完整回应，不许被 clarify 抢走
          if (degraded || (!intents.length && !clarify && !echo)) { const fb = parseDirect(state, pack, input); intents = intents.concat(fb.intents); clarify = clarify || fb.clarify || null; }
        } else {
          const fb = parseDirect(state, pack, input);
          intents = fb.intents; clarify = fb.clarify || null;
        }
        // 未被接住的话（v3）：echo 演出世界如何接住它，素材环收存原文——
        // 两天后命运导演可能长出一张回应卡（离谱输入的兜底不是拒绝，是消化）
        if (!intents.length && !clarify && input.trim()) {
          intents = [{ type: 'whisper', text: input.slice(0, 60) }];
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache', connection: 'keep-alive',
          'x-accel-buffering': 'no'
        });
        const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
        if (clarify && !intents.length) {
          send('clarify', { text: clarify });
          ink.push({ day: state.day, role: 'sys', text: '……' + clarify });
          db.appendNarration(id, ink);
          send('done', { state: enrich(state), events: [] });
          return res.end();
        }
        if (echo) { // 世界的回应先落一笔（作为叙事入前文），再走素材收存
          send('echo', { text: echo });
          ink.push({ day: state.day, role: 'narrator', text: echo });
        }

        let result = resolveInput(state, pack, intents);
        // 宏观收卷（全通道统一节奏）：LLM 局的自由输入也一次走完——
        // 白天打字办成了事即自动收卷入黄昏；黄昏打字指派后按现行规矩带方针走完整夜。
        // 直读模式不收（测试/微操通道）；clarify/echo/狂语/求助不动状态也不收
        if (!Array.isArray(body.intents) && run.mode === 'llm') {
          const ok = (t) => intents.some((i) => i.type === t && !result.rejects?.some((r) => r.intent === i));
          const alreadyClosing = intents.some((i) => i.type === 'auto_day' || i.type === 'advance');
          const merge = (r2) => {
            result.events.push(...r2.events); result.facts.push(...r2.facts); result.rejects.push(...r2.rejects);
            result.state = r2.state;
          };
          if (result.state.phase === 'day' && !result.state.activeEvent && !result.state.over
            && !alreadyClosing && ['act', 'policy', 'direction', 'trade_op'].some(ok)) {
            merge(resolveInput(result.state, pack, [{ type: 'auto_day' }])); // 打字办成事：今天就此收卷
          } else if (result.state.phase === 'night' && result.state.night && !result.state.night.home
            && !result.state.night.directive && !result.state.night.micro && ok('dusk_assign')) {
            const pol = policyOf(result.state).nightApproach || 'normal';
            merge(resolveInput(result.state, pack, [{ type: 'night_directive', stance: pol, text: '今晚按老规矩走' }])); // 打字指派：整夜随之走完
          }
        }
        db.appendEvents(id, result.events);
        // 文档发现即入档（幂等；弃局不丢线索）——记到会话用户名下
        for (const ev of result.events) {
          if (ev.t === 'DOC_FOUND') {
            const doc = pack.docMap[ev.d.docId];
            if (doc) db.archivePut(s.userId, 'doc', doc.id, { title: doc.title, layer: doc.layer, text: doc.text, seenRuns: [id] }, id);
          }
          if (ev.t === 'SEAL_UNLOCKED') {
            const seal = pack.sealMap[ev.d.id];
            if (seal) db.archivePut(s.userId, 'seal', seal.id, { layer: seal.layer, text: seal.text }, id);
          }
        }
        // 时间胶囊被挖到：登记"东西已取走"（此后每周目只剩字条）
        for (const key of Object.keys(result.state.capsuleFound || {})) {
          const cap = db.archiveAll(s.userId).find((e) => e.kind === 'capsule' && e.key === key);
          if (cap && !cap.data.foundRun) db.archivePut(s.userId, 'capsule', key, { ...cap.data, foundRun: id }, cap.first_run_id);
        }
        if (result.state.over) {
          geDirector.drop(id);
          await finalizeEndedRun(s.userId, id, result.state, run.mode === 'llm' ? gw : null, (d) => send('memoir-delta', { d }));
        } else {
          // C 层导演（GE）：注入昨日预取 + 预取明日（离线即整层关闭）
          await geDirector.onTurn(id, result.state);
          db.saveState(id, result.state);
        }

        // 戏文轨（stage-play）：scene_request 事实交给舞台导演——写一段当场戏文，
        // 可附白名单微效果（心情/声望/念头），越界即整份丢弃；LLM 缺席走直读兜底
        for (const f of result.facts.filter((x) => x.k === 'scene_request')) {
          const stageOut = gw ? await stagedirector({ provider: gw.providers.narrator || gw.providers.referee, prompts: promptsCache },
            { worldBrief: worldBrief(result.state, pack), move: f.text }).catch((e) => ({ __error: String(e?.message || e).slice(0, 200) })) : null;
          if (stageOut?.__error) log.warn('stage director failed', { runId: id, error: stageOut.__error });
          if (stageOut?.text?.trim()) {
            send('stage', { text: stageOut.text.trim() });
            ink.push({ day: result.state.day, role: 'narrator', text: stageOut.text.trim() });
            if (stageOut.effects) {
              const applied = applySceneEffects(result.state, pack, stageOut.effects);
              if (applied.ok) { db.appendEvents(id, applied.events); result.facts.push(...applied.facts); }
              else log.warn('戏文微效果被拒', { runId: id, reasons: applied.reasons });
            }
          } else {
            const line = '你做了。没有什么立刻改变——但这一刻被这座城记住了。';
            send('stage', { text: line });
            ink.push({ day: result.state.day, role: 'narrator', text: line });
          }
        }
        // 叙事：LLM 流式 → 直读模板兜底（空白输出也视为没写出来，落兜底）
        let text = '';
        const gwN = run.mode === 'llm' ? gw : null;
        if (gwN && result.facts.length) {
          text = await gwN.narrate(result.facts, result.state, (d) => send('narration-delta', { d }));
          if (text && !text.trim()) text = '';
        }
        if (!text) {
          text = renderDirect(result.state, result.facts, pack);
          send('narration-delta', { d: text });
        }
        if (text.trim()) ink.push({ day: result.state.day, role: 'narrator', text });
        if (result.rejects?.length) ink.push({ day: result.state.day, role: 'sys', text: '（有些事做不到：' + result.rejects.map((r) => r.reason).join('、') + '）' });
        db.appendNarration(id, ink);
        db.saveState(id, result.state); // 戏文微效果可能改了状态——以最终态发补丁
        send('state-patch', { state: enrich(result.state) });
        send('done', { rejects: result.rejects, degraded, say });
        return res.end();
      }

      // 谋士选项（统一交互面）：刷新命运——纯视图数据，点了才走输入管线
      if (req.method === 'POST' && /^\/api\/runs\/[^/]+\/options$/.test(path)) {
        const id = path.split('/')[3];
        const ctx = loadOwnRun(id);
        if (!ctx) return;
        const { run } = ctx;
        if (run.status !== 'active' || run.state.over) return json(res, 400, { error: 'run ended' });
        const body = await readBody(req);
        const card = ['day', 'dusk', 'night'].includes(body.card) ? body.card : null;
        if (!card) return json(res, 400, { error: 'card 不对' });
        if (rateLimited(req.socket.remoteAddress || '?')) return json(res, 200, { options: [], reason: '太快了，喘口气' });
        if (run.mode !== 'llm') return json(res, 200, { options: [], reason: '这一局是直读模式（添加 LLM 供应商后新开的局才有谋士）' });
        const gw = buildGateway(id);
        if (!gw?.providers?.referee && !gw?.providers?.narrator) return json(res, 200, { options: [], reason: '没有可用的 LLM 路由（管理页配置后自动接入）' });
        // 刷新预算：同一卡面至多两次「成功出选项」的手动刷新（失败/被滤不扣次数）；
        // 出场自动那次（auto）免费——否则玩家会失去一次「再想想」
        const bkey = id + ':' + card + ':' + run.state.day;
        const auto = body.auto === true;
        if (!auto && (optionRefresh.get(bkey) || 0) >= 2) return json(res, 200, { options: [], budget: true });
        try {
          const st = run.state;
          const brief = {
            card: cardBrief(st, pack, card),
            exclude: Array.isArray(body.exclude) ? body.exclude.slice(0, 8).map(String) : [],
            anchors: anchorPool(pack, st).slice(0, 24),
            worldBrief: worldBrief(st, pack)
          };
          const provider = gw.providers.referee || gw.providers.narrator;
          const raw = await optionsmith({ provider, prompts: promptsCache }, brief);
          const options = validateOptions(pack, st, raw, { card });
          const reason = options.length ? '' : (raw ? '谋士出的选项都没过验证（id 对照/可行性/禁词）' : '谋士的输出没法解析成 JSON');
          if (options.length && !auto) optionRefresh.set(bkey, (optionRefresh.get(bkey) || 0) + 1);
          return json(res, 200, { options, reason });
        } catch (e) {
          log.warn('optionsmith 失败', { runId: id, error: String(e?.message || e) });
          return json(res, 200, { options: [], reason: `调用失败：${String(e?.message || e).slice(0, 120)}` });
        }
      }

      // 计划确认（直读模式 v1 走同一条 input 通道）
      if (req.method === 'POST' && /^\/api\/runs\/[^/]+\/confirm-plan$/.test(path)) {
        const id = path.split('/')[3];
        const ctx = loadOwnRun(id);
        if (!ctx) return;
        const { s, run } = ctx;
        const body = await readBody(req);
        const result = resolveInput(run.state, pack, Array.isArray(body.intents) ? body.intents : []);
        db.appendEvents(id, result.events);
        if (result.state.over) await finalizeEndedRun(s.userId, id, result.state, null);
        else db.saveState(id, result.state);
        const text = renderDirect(result.state, result.facts, pack);
        const ink = [];
        const display = String(body.display || '').slice(0, 500);
        if (display.trim()) ink.push({ day: run.state.day, role: 'player', text: display });
        if (text.trim()) ink.push({ day: result.state.day, role: 'narrator', text });
        db.appendNarration(id, ink);
        return json(res, 200, { state: enrich(result.state), narration: text, rejects: result.rejects });
      }

      // —— 档案馆（跨局，按用户隔离） ——
      if (path === '/api/archive') {
        const s = auth(req);
        if (!s) return json(res, 401, { error: '请先登录。' });
        const entries = db.archiveAll(s.userId);
        const docs = entries.filter((e) => e.kind === 'doc');
        const runs = entries.filter((e) => e.kind === 'run_memory');
        const seals = entries.filter((e) => e.kind === 'seal');
        const gates = pack.layerGates;
        const layer1 = docs.length >= gates.layer1, layer2 = docs.length >= gates.layer2;
        return json(res, 200, {
          docs: docs.map((d) => ({ id: d.key, ...d.data })),
          runs: runs.map((r) => r.data),
          seals: seals.map((x) => ({ id: x.key, ...x.data })),
          // 史册格（GDD-v0.2 §12.1）：正史栏=通行叙事（公开水面），野史栏=你打出来的那几页
          annals: entries.filter((e) => e.kind === 'annal').map((e) => ({ id: e.key, ...e.data })),
          canonAnnals: pack.canonAnnals || [],
          // 回响区：胶囊、遗愿、商路的记性
          echoes: entries.filter((e) => ['echo', 'capsule', 'wish'].includes(e.kind)).map((e) => ({ kind: e.kind, id: e.key, ...e.data })),
          closure: closureStatus(entries, pack),
          layers: { layer1, layer2, layerNames: gates.layerNames, progress: { docs: docs.length, total: pack.docs.length } }
        });
      }

      // 回忆录成册（EX-01）：档案馆书架装订成一本可下载的纯文本小书
      if (path === '/api/archive/memoir-book' && req.method === 'GET') {
        const s = auth(req);
        if (!s) return json(res, 401, { error: '请先登录。' });
        const text = composeMemoirBook(db.archiveAll(s.userId), s.name || '无名者');
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="wo-de-jiangling.txt"'
        });
        return res.end(text);
      }

      // 合上兰台（§3.6）：谢幕是两步确认，档案馆永远可重开
      if (path === '/api/archive/close' && req.method === 'POST') {
        const s = auth(req);
        if (!s) return json(res, 401, { error: '请先登录。' });
        const entries = db.archiveAll(s.userId);
        const st = closureStatus(entries, pack);
        if (st.done) return json(res, 409, { error: '兰台已经合上了。' });
        if (!st.available) return json(res, 409, { error: '还没到时候。', progress: st.progress });
        db.archivePut(s.userId, 'closure', 'closed', { at: new Date().toISOString() }, null);
        // 送行：城市用你最后十局的三件事
        const runs = entries.filter((e) => e.kind === 'run_memory').map((e) => e.data).slice(-10);
        const things = runs.map((r) => r.threeThings?.[0]).filter(Boolean)
          .map((t) => `第${t.day}天，${t.text}`);
        return json(res, 200, { farewell: things });
      }

      // —— 别传（长线体验-v0.2 §3.4：档案馆里的故事认出门） ——
      const sideUnlocked = (u, arch) => {
        if (!u) return true;
        if (u.kind === 'seal') return arch.some((e) => e.kind === 'seal' && e.key === u.key);
        if (u.kind === 'annal') return arch.some((e) => e.kind === 'annal');
        if (u.kind === 'run_ending') return arch.some((e) => e.kind === 'run_memory' && e.data.ending === u.ending);
        if (u.kind === 'docs') return arch.filter((e) => e.kind === 'doc').length >= u.count;
        return false;
      };
      if (path === '/api/sidestories' && req.method === 'GET') {
        const s = auth(req);
        if (!s) return json(res, 401, { error: '请先登录。' });
        const arch = db.archiveAll(s.userId);
        const unlockedBy = (u) => sideUnlocked(u, arch);
        return json(res, 200, {
          stories: (pack.sidestories || []).map((d) => ({
            id: d.id, title: d.title, blurb: d.blurb, days: d.days,
            unlocked: unlockedBy(d.unlock), unlockHint: d.unlockHint
          }))
        });
      }

      // —— 管理面（管理员账号登录后方可访问；管理员由 ADMIN_USERNAME/ADMIN_PASSWORD 引导） ——
      const requireAdmin = () => {
        const s = auth(req);
        return s && s.admin;
      };
      if (path.startsWith('/api/admin/')) {
        if (!requireAdmin()) return json(res, 401, { error: '需要管理员账号登录。' });
      }

      if (path === '/api/admin/users' && req.method === 'GET') {
        return json(res, 200, { users: db.listUsersWithStats() });
      }

      if (path === '/api/admin/providers' && req.method === 'GET') {
        return json(res, 200, { providers: db.providers(), routes: db.routes(), presets: (await import('../llm/index.js')).PRESETS });
      }
      if (path === '/api/admin/providers' && req.method === 'POST') {
        const b = await readBody(req);
        if (!b.name || !b.adapter || !b.baseUrl || !b.model) return json(res, 400, { error: '缺字段' });
        const id = db.upsertProvider(b);
        // 添加即上线：没配路由的用途自动接入新供应商（已有路由不劫持）
        for (const purpose of ['referee', 'narrator', 'actor']) {
          const cur = db.routes().find((r) => r.purpose === purpose);
          if (!cur || !cur.provider_id) db.setRoute(purpose, Number(id), cur?.fallback_provider_id || null);
        }
        return json(res, 200, { id, provider: db.providerById(id), routes: db.routes() });
      }
      if (/^\/api\/admin\/providers\/\d+$/.test(path) && req.method === 'PATCH') {
        const b = await readBody(req);
        db.upsertProvider({ ...b, id: Number(path.split('/').pop()) });
        return json(res, 200, { ok: true });
      }
      if (/^\/api\/admin\/providers\/\d+$/.test(path) && req.method === 'DELETE') {
        db.deleteProvider(Number(path.split('/').pop()));
        return json(res, 200, { ok: true });
      }
      if (path === '/api/admin/llm/routes' && req.method === 'POST') {
        const b = await readBody(req);
        db.setRoute(b.purpose, b.providerId || null, b.fallbackId || null);
        return json(res, 200, { routes: db.routes() });
      }
      if (path === '/api/admin/llm/test' && req.method === 'POST') {
        const b = await readBody(req);
        const targets = b.providerId ? [db.providerRaw(b.providerId)].filter(Boolean)
          : db.providers().map((p) => db.providerRaw(p.id)).filter(Boolean);
        const results = [];
        for (const p of targets) {
          const report = await healthCheck({ adapter: p.adapter, baseUrl: p.base_url, model: p.model, apiKey: decryptKey(p.api_key_enc), name: p.name });
          db.logHealth(p.id, report);
          results.push(report);
        }
        return json(res, 200, { results });
      }
      if (path === '/api/admin/llm/health-history' && req.method === 'GET') {
        return json(res, 200, { history: db.healthHistory() });
      }
      if (path === '/api/admin/content/pack' && req.method === 'GET') {
        return json(res, 200, { pack: pack.manifest, counts: { items: pack.items.length, characters: pack.characters.length, locations: pack.locations.length, docs: pack.docs.length, cards: pack.cards.length } });
      }
      if (/^\/api\/admin\/runs\/[^/]+\/replay$/.test(path) && req.method === 'GET') {
        const id = path.split('/')[4];
        const events = db.eventsOf(id);
        const rebuilt = fold(events);
        return json(res, 200, { ok: true, day: rebuilt?.day, docs: rebuilt?.docsSeen?.length, events: events.length, match: JSON.stringify(rebuilt) === JSON.stringify(db.getRun(id)?.state) });
      }
      if (path === '/api/admin/sim/smoke' && req.method === 'POST') {
        const { runSim } = await import('../sim/runner.js');
        const report = runSim(pack, { runs: 20, policies: ['balanced'], seed: 999 });
        return json(res, 200, report);
      }

      json(res, 404, { error: 'no route', path });
    } catch (e) {
      log.error(`${req.method} ${path} 失败`, { error: String(e && e.stack || e) });
      if (res.headersSent) {
        try { res.write(`event: error\ndata: ${JSON.stringify({ error: String(e.message || e) })}\n\n`); } catch { /* 已断开 */ }
        res.end();
      } else {
        json(res, 500, { error: String(e.message || e) });
      }
    }
  });

  async function staticFile(path, res) {
    // 多用户入口：/ 为 landing（注册/登录），/app 为游戏 SPA（会话 cookie 已具备则直接可用）
    const file = path === '/' ? '/landing.html' : path === '/app' ? '/index.html' : path;
    try {
      const content = await readFile(join(WEB_DIR, file));
      const types = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg'
      };
      const isAsset = file.startsWith('/assets/');
      res.writeHead(200, {
        'content-type': types[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        // 字体切片按 unicode-range 按需取用且内容随版本稳定，值得长缓存；代码文件保持协商缓存便于开发
        'cache-control': isAsset ? 'public, max-age=604800' : 'no-cache'
      });
      res.end(content);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  }

  return { server, db, pack, cfg, log, port: () => server.address()?.port };
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
function parseCookie(str) {
  return Object.fromEntries(str.split(';').map((s) => s.trim().split('=').map(decodeURIComponent)));
}

// 直启入口：严格模式——schema 落后时拒启并提示 migrate（部署入口见 package.json / Dockerfile）
// 开发模式请用 npm run dev（自动迁移 + 热重启）。
if (process.argv[1] && process.argv[1].endsWith('server/index.js')) {
  let app;
  try {
    app = createApp();
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
  const stop = (sig) => {
    app.log.info(`收到 ${sig}，优雅关停…`);
    app.server.close(() => {
      try { app.db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 忽略 */ }
      app.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  app.server.listen(app.cfg.port, () => {
    app.log.info(`《第 41 天》 → http://127.0.0.1:${app.cfg.port}`, {
      app: pkg.version, schema: `v${app.db.schemaVersion()}`, pack: app.pack.manifest.semver, env: app.cfg.env
    });
  });
}
