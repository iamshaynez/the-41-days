// L6 全栈 HTTP e2e（技术架构 §10）：真实 server + 临时 DB + LLM 桩上游。
// 多用户改造后：注册/登录/登出、按用户隔离对局与档案、管理员环境变量引导。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../packages/server/index.js';
import { applyMigrations } from '../../packages/server/migrate.js';

let app, base, stub, stubPort, dir;
const admin = {};
const player = {};

before(async () => {
  // LLM 桩上游（OpenAI 兼容）：裁判返回合法意图 JSON，叙事返回一句文本
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const user = payload.messages?.at(-1)?.content || '';
      if (payload.response_format?.type === 'json_object') {
        const isRepair = user.includes('无法解析');
        const intents = isRepair ? [] : [{ type: 'act', actor: 'bron', action: 'eat' }];
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intents, clarify: null, say: null }) } }] }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '【桩叙事】石大吃上了热的。' } }] }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  stubPort = stub.address().port;

  dir = mkdtempSync(join(tmpdir(), 'twom-e2e-'));
  applyMigrations(join(dir, 'game.db')); // 部署等价路径：显式迁移在前
  app = createApp({ dbPath: join(dir, 'game.db'), adminUsername: 'admin', adminPassword: 'test-admin-pw' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;

  // 玩家注册（游戏流程用这个账号）
  const su = await api('POST', '/api/auth/signup', { username: 'player1', password: 'secret1' });
  player.token = su.token;

  // 管理员：环境变量凭据首次登录 → 自动创建 is_admin 账号
  const login = await api('POST', '/api/auth/login', { username: 'admin', password: 'test-admin-pw' });
  admin.token = login.token;
  // 配置指向桩的 provider + 路由
  const created = await api('POST', '/api/admin/providers', { name: '桩', adapter: 'openai-compat', baseUrl: `http://127.0.0.1:${stubPort}`, model: 'stub-model', apiKey: 'sk-stub' }, admin.token);
  admin.providerId = created.id;
  await api('POST', '/api/admin/llm/routes', { purpose: 'referee', providerId: admin.providerId }, admin.token);
  await api('POST', '/api/admin/llm/routes', { purpose: 'narrator', providerId: admin.providerId }, admin.token);
});

after(() => {
  app.server.close(); app.db.close(); stub.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ...json };
}

/** SSE 输入调用：收齐事件流 */
async function input(runId, text, token = player.token) {
  const res = await fetch(`${base}/api/runs/${runId}/input`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ input: text })
  });
  assert.equal(res.status, 200);
  const raw = await res.text();
  const events = [];
  for (const block of raw.split('\n\n')) {
    const ev = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    if (ev) events.push({ ev, data: data ? JSON.parse(data) : {} });
  }
  return events;
}

describe('健康与静态', () => {
  test('GET /healthz 报应用/schema/内容包三版本与用户数', async () => {
    const r = await api('GET', '/healthz');
    assert.equal(r.status, 200);
    assert.ok(r.app, '应用版本');
    assert.equal(r.schema, r.schemaLatest, 'schema 应已迁移到最新');
    assert.ok(r.pack);
    assert.ok(Number.isFinite(r.uptimeSec));
    assert.ok(r.users >= 2, '已注册玩家+管理员');
  });
  test('GET / 提供 landing（注册/登录）', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /第 41 天|html/i);
  });
  test('GET /app 提供游戏 SPA', async () => {
    const res = await fetch(base + '/app');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /app\.js/);
  });
});

describe('认证（多用户）', () => {
  test('注册 → 返回用户与 token，/me 可用', async () => {
    const r = await api('POST', '/api/auth/signup', { username: 'echo', password: 'secret1' });
    assert.equal(r.status, 201);
    assert.ok(r.token);
    assert.equal(r.user.name, 'echo');
    assert.equal(r.user.is_admin, false);
    const me = await api('GET', '/api/auth/me', null, r.token);
    assert.equal(me.status, 200);
    assert.equal(me.user.name, 'echo');
  });
  test('重复注册 409', async () => {
    const r = await api('POST', '/api/auth/signup', { username: 'player1', password: 'secret1' });
    assert.equal(r.status, 409);
  });
  test('管理员用户名保留 403', async () => {
    const r = await api('POST', '/api/auth/signup', { username: 'admin', password: 'whatever1' });
    assert.equal(r.status, 403);
  });
  test('用户名/口令格式 400', async () => {
    assert.equal((await api('POST', '/api/auth/signup', { username: 'a', password: 'secret1' })).status, 400);
    assert.equal((await api('POST', '/api/auth/signup', { username: 'okname', password: '123' })).status, 400);
    assert.equal((await api('POST', '/api/auth/signup', { username: 'bad space', password: 'secret1' })).status, 400);
  });
  test('错误口令 401；不存在用户 401（同一文案）', async () => {
    const a = await api('POST', '/api/auth/login', { username: 'player1', password: 'wrongpw' });
    const b = await api('POST', '/api/auth/login', { username: 'no-such-user', password: 'wrongpw' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.error, b.error);
  });
  test('登录下发 HttpOnly cookie，cookie 可过 /me（浏览器路径）', async () => {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'player1', password: 'secret1' })
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    const me = await fetch(base + '/api/auth/me', { headers: { cookie: cookie.split(';')[0] } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.name, 'player1');
  });
  test('登出后 token 失效', async () => {
    const su = await api('POST', '/api/auth/signup', { username: 'gone', password: 'secret1' });
    const out = await api('POST', '/api/auth/logout', {}, su.token);
    assert.equal(out.status, 200);
    assert.equal((await api('GET', '/api/auth/me', null, su.token)).status, 401);
  });
  test('管理员引导：环境变量凭据首次登录创建 is_admin 记录', async () => {
    const me = await api('GET', '/api/auth/me', null, admin.token);
    assert.equal(me.user.name, 'admin');
    assert.equal(me.user.is_admin, true);
    // 再次登录（记录已存在）仍成功——环境凭据持续有效
    const again = await api('POST', '/api/auth/login', { username: 'admin', password: 'test-admin-pw' });
    assert.equal(again.status, 200);
    assert.equal(again.user.is_admin, true);
  });
  test('普通用户访问管理面 401', async () => {
    const r = await api('GET', '/api/admin/providers', null, player.token);
    assert.equal(r.status, 401);
  });
});

describe('管理面：LLM 配置 + 连通性测试（§7.4）', () => {
  test('未登录 401', async () => {
    const r = await api('GET', '/api/admin/providers');
    assert.equal(r.status, 401);
  });
  test('provider 列表掩码（不回显 key）', async () => {
    const r = await api('GET', '/api/admin/providers', null, admin.token);
    assert.equal(r.status, 200);
    const p = r.providers.find((x) => x.id === admin.providerId);
    assert.ok(p && p.hasKey && p.api_key_enc === undefined);
    // 添加即上线：空用途自动接入新供应商（裁判/叙事者/演员三路全通）
    assert.deepEqual(r.routes.map((x) => x.purpose).sort(), ['actor', 'narrator', 'referee']);
  });
  test('用户清单：含玩家与管理员及其对局数', async () => {
    const r = await api('GET', '/api/admin/users', null, admin.token);
    assert.equal(r.status, 200);
    const names = r.users.map((u) => u.name);
    assert.ok(names.includes('admin') && names.includes('player1'));
    assert.equal(r.users.find((u) => u.name === 'admin').is_admin, 1);
  });
  test('连通性测试：真实调用桩上游并记录历史', async () => {
    const r = await api('POST', '/api/admin/llm/test', { providerId: admin.providerId }, admin.token);
    assert.equal(r.results[0].ok, true);
    assert.ok(r.results[0].latencyMs >= 0);
    const h = await api('GET', '/api/admin/llm/health-history', null, admin.token);
    assert.ok(h.history.length >= 1);
    assert.equal(h.history[0].ok, 1);
  });
  test('连通性测试失败路径：错误 provider', async () => {
    const bad = await api('POST', '/api/admin/providers', { name: '坏桩', adapter: 'openai-compat', baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'k' }, admin.token);
    const r = await api('POST', '/api/admin/llm/test', { providerId: bad.id }, admin.token);
    assert.equal(r.results[0].ok, false);
    assert.ok(r.results[0].error);
  });
});

describe('游戏主流程（LLM 模式 + SSE，按用户隔离）', () => {
  let runId;
  test('未登录 401：开局/档案馆/对局列表都要会话', async () => {
    assert.equal((await api('POST', '/api/runs', { mode: 'direct' })).status, 401);
    assert.equal((await api('GET', '/api/runs')).status, 401);
    assert.equal((await api('GET', '/api/archive')).status, 401);
  });
  test('开局：默认 direct 或已配 llm', async () => {
    const r = await api('POST', '/api/runs', { mode: 'llm', seed: 42, roster: ['bron', 'katya', 'marta'], prologue: false }, player.token);
    assert.equal(r.status, 200);
    runId = r.id;
    assert.equal(r.mode, 'llm');
    assert.equal(r.state.day, 1);
    assert.equal(r.state.charView.length, 3);
  });
  test('开局不传 mode：有路由即 LLM（玩家侧无模式选择）', async () => {
    const r = await api('POST', '/api/runs', { seed: 43, prologue: false }, player.token);
    assert.equal(r.mode, 'llm', '已配置路由时默认 LLM');
  });
  test('对局列表：只看见自己的', async () => {
    const r = await api('GET', '/api/runs', null, player.token);
    assert.ok(r.runs.length >= 1);
    assert.ok(r.runs.some((x) => x.id === runId && x.status === 'active'), '应含主流程对局');
    assert.ok(r.runs.every((x) => x.id), '列表不含他人对局（隔离由下方数据隔离测试兜底）');
    assert.equal(r.engine, 'llm', '已配路由时引擎状态对外可读');
  });

  test('SSE 输入：裁判解析→内核结算→叙事流→状态补丁', async () => {
    const evs = await input(runId, '石大吃熟食');
    const kinds = evs.map((e) => e.ev);
    assert.ok(kinds.includes('narration-delta'), '应有叙事流');
    assert.ok(kinds.includes('state-patch'), '应有状态补丁');
    assert.ok(kinds.includes('done'));
    const patch = evs.find((e) => e.ev === 'state-patch').data.state;
    assert.ok(patch.inventory !== undefined);
    const narration = evs.filter((e) => e.ev === 'narration-delta').map((e) => e.data.d).join('');
    assert.ok(narration.length > 0);
  });

  test('直读兜底：越界输入返回引导而不是执行', async () => {
    const evs = await input(runId, '我口袋里其实有一百把AK');
    const done = evs.find((e) => e.ev === 'done').data;
    const patch = evs.find((e) => e.ev === 'state-patch').data.state;
    assert.equal(patch.inventory['rifle'] || 0, 0, '不能凭空产生武器');
    // clarify 或空意图叙事
    assert.ok(evs.some((e) => e.ev === 'clarify') || done.rejects !== undefined);
  });

  test('事件流端点：可按 seq 增量拉取（断线恢复）', async () => {
    const all = await api('GET', `/api/runs/${runId}/events`, null, player.token);
    assert.ok(all.events.length > 0);
    const tail = await api('GET', `/api/runs/${runId}/events?from=${all.events.length - 1}`, null, player.token);
    assert.equal(tail.events.length, 1, '增量=最后一条之后');
  });

  test('数据隔离：他人对局 404、列表与档案馆互不可见；管理员可读（回放）', async () => {
    const su2 = await api('POST', '/api/auth/signup', { username: 'player2', password: 'secret2' });
    assert.equal((await api('GET', `/api/runs/${runId}`, null, su2.token)).status, 404);
    assert.equal((await api('GET', `/api/runs/${runId}/events`, null, su2.token)).status, 404);
    assert.equal((await api('POST', `/api/runs/${runId}/input`, { input: '吃饭' }, su2.token)).status, 404);
    const mine = await api('GET', '/api/runs', null, su2.token);
    assert.equal(mine.runs.length, 0, '别人的局不在我的列表');
    const arch = await api('GET', '/api/archive', null, su2.token);
    assert.equal(arch.docs.length, 0, '档案馆按用户隔离');
    const adm = await api('GET', `/api/runs/${runId}`, null, admin.token);
    assert.equal(adm.id, runId, '管理员可读（回放）');
  });

  test('完整一天（直读模式）：白天→黄昏→夜访→次日晨报', async () => {
    const r = await api('POST', '/api/runs', { mode: 'direct', seed: 42, roster: ['bron', 'katya', 'marta'], prologue: false }, player.token);
    const rid = r.id;
    assert.equal(r.mode, 'direct');
    await input(rid, '石大搜家里');
    await input(rid, '天黑吧');
    await input(rid, '今晚石大去里社，其他人睡觉');
    let guard = 0;
    let state = (await api('GET', `/api/runs/${rid}`, null, player.token)).state;
    while (state.phase === 'night' && state.nightView && guard++ < 10) {
      if (state.eventView) { await input(rid, '选1'); }
      else await input(rid, '搜');
      state = (await api('GET', `/api/runs/${rid}`, null, player.token)).state;
    }
    if (state.phase === 'night') await input(rid, '撤退');
    state = (await api('GET', `/api/runs/${rid}`, null, player.token)).state;
    assert.equal(state.day, 2, '夜访结束应进入第 2 天');
    assert.equal(state.phase, 'day');
  });

  test('档案馆：初期为空且带层级门槛', async () => {
    const r = await api('GET', '/api/archive', null, player.token);
    assert.equal(r.status, 200);
    assert.ok(r.layers && typeof r.layers.layer1 === 'boolean');
    assert.ok(r.layers.progress.docs <= r.layers.progress.total);
  });

  test('v2 决断路径：决策卡直传意图（auto_day → 黄昏方案 → 夜间自动流）', async () => {
    const r = await api('POST', '/api/runs', { mode: 'direct', seed: 42, roster: ['bron', 'katya', 'marta'], prologue: false }, player.token);
    const rid = r.id;
    // 决策卡/建议由服务端现算：白天有"自己张罗"入口
    assert.ok(r.state.suggests.some((x) => x.text === '照常过吧'), '首日建议栏应含自动日常');
    // 决策卡直传结构化意图（不走文本解析，同一 SSE 管线）
    const postIntents = async (intents) => {
      const res = await fetch(`${base}/api/runs/${rid}/input`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${player.token}` },
        body: JSON.stringify({ intents })
      });
      assert.equal(res.status, 200);
      const raw = await res.text();
      const evs = [];
      for (const block of raw.split('\n\n')) {
        const ev = block.match(/^event: (.+)$/m)?.[1];
        const data = block.match(/^data: (.+)$/m)?.[1];
        if (ev) evs.push({ ev, data: data ? JSON.parse(data) : {} });
      }
      return evs;
    };
    let evs = await postIntents([{ type: 'auto_day' }]);
    let patch = evs.find((e) => e.ev === 'state-patch').data.state;
    assert.ok(patch.phase === 'dusk' || patch.eventView, 'auto_day 后应入黄昏或停在未决事件');
    if (patch.eventView) {
      evs = await postIntents([{ type: 'event_choice', option: patch.eventView.options[0].key }]);
      patch = evs.find((e) => e.ev === 'state-patch').data.state;
    }
    if (patch.phase === 'day') { evs = await postIntents([{ type: 'advance' }]); patch = evs.find((e) => e.ev === 'state-patch').data.state; }
    assert.equal(patch.phase, 'dusk');
    assert.ok(patch.duskView?.plans?.length >= 2, '黄昏方案卡应有得选');
    // 点第一方案 → 深夜
    evs = await postIntents([patch.duskView.plans[0].intent]);
    patch = evs.find((e) => e.ev === 'state-patch').data.state;
    assert.equal(patch.phase, 'night');
    // 夜间自动流：岔路停问 → 点选项；事件卡 → 选项；否则继续
    let guard = 0;
    while (patch.phase === 'night' && patch.nightView && guard++ < 12) {
      if (patch.eventView) evs = await postIntents([{ type: 'event_choice', option: patch.eventView.options[0].key }]);
      else if (patch.nightView.fork) evs = await postIntents(patch.nightView.fork.options[0].intents);
      else evs = await postIntents([{ type: 'auto_night' }]);
      patch = evs.find((e) => e.ev === 'state-patch')?.data.state || (await api('GET', `/api/runs/${rid}`, null, player.token)).state;
    }
    assert.equal(patch.day, 2, '完整一天后进入第 2 天');
    assert.equal(patch.phase, 'day');
    assert.ok(Array.isArray(patch.suggests), '建议栏始终在场');
  });

  test('管理面：回放（fold 一致性在真库上验证）', async () => {
    const r = await api('GET', `/api/admin/runs/${runId}/replay`, null, admin.token);
    assert.equal(r.status, 200);
    assert.equal(r.ok, true);
    assert.equal(r.match, true, '事件折叠应与存档状态一致');
  });

  test('限流：超阈值返回 429（低阈值专用局）', async () => {
    const { createApp: fresh } = await import('../../packages/server/index.js');
    const { applyMigrations: mig } = await import('../../packages/server/migrate.js');
    const d2 = mkdtempSync(join(tmpdir(), 'twom-rate-'));
    mig(join(d2, 'g.db'));
    // 限流阈值 4：注册占 1，之后 3 次输入放行、第 4 次起 429
    const app2 = fresh({ dbPath: join(d2, 'g.db'), adminUsername: 'admin', adminPassword: 'x', inputRatePerMin: 4 });
    await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
    const b2 = `http://127.0.0.1:${app2.server.address().port}`;
    const su = await (await fetch(`${b2}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ratelimit', password: 'secret1' }) })).json();
    const run = await (await fetch(b2 + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${su.token}` }, body: '{}' })).json();
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${b2}/api/runs/${run.id}/input`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${su.token}` }, body: JSON.stringify({ input: '吃饭' }) });
      codes.push(res.status);
      await res.text();
    }
    app2.server.close(); app2.db.close(); rmSync(d2, { recursive: true, force: true });
    assert.ok(codes.includes(429), `应出现 429（${codes.join(',')}）`);
    assert.equal(codes.filter((c) => c === 200).length, 3);
  });

  test('schema 守卫：落后库启动即拒（报错含 migrate 指引）', async () => {
    const { createApp: fresh } = await import('../../packages/server/index.js');
    const { applyMigrations: mig } = await import('../../packages/server/migrate.js');
    const d3 = mkdtempSync(join(tmpdir(), 'twom-guard-'));
    mig(join(d3, 'g.db'), { to: 1 }); // 落后两个版本
    assert.throws(() => fresh({ dbPath: join(d3, 'g.db'), adminUsername: 'admin', adminPassword: 'x' }), /npm run migrate/);
    rmSync(d3, { recursive: true, force: true });
  });

  test('平衡模拟冒烟端点', async () => {
    const r = await api('POST', '/api/admin/sim/smoke', {}, admin.token);
    assert.equal(r.status, 200);
    assert.ok(r.kpis.balanced);
  });
});
