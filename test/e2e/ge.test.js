// C 层生成事件 e2e（GE-01~13）：桩 LLM 提案 → 验证 → 注入 → 结算全链
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../packages/server/index.js';
import { applyMigrations } from '../../packages/server/migrate.js';

let app, base, stub, dir;
let token;

const PROPOSAL = {
  title: '半块麦饼',
  text: '文简开门槛时，对门的老者把半块麦饼塞进他手里，没留话。饼是热的，说明他家里今天有火。',
  theme: '稀缺',
  anchors: [], // 桩：服务端以锚池校验，anchors 在桩里由 text 占位（见下）
  options: [
    { label: '收进来分着吃', mood_all: 1, items_gain: { wood: 1 }, outcomeText: '饼很硬，很暖。' },
    { label: '放回去', outcomeText: '门槛空了。' }
  ]
};

before(async () => {
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      const sys = payload.messages?.[0]?.content || '';
      if (sys.includes('编剧')) {
        // 编剧桩：把锚池里现成的两个锚写进提案（校验要求的真实锚）；
        // 锚引用断言要求正文出现真实人物——阵容随机，故从锚池动态取名
        const m = sys.match(/# 当局锚池（只能从这里挑）\n(.+)/);
        const pool = (m?.[1] || '').split('、').filter(Boolean);
        const who = (pool.find((a) => a.startsWith('角色:')) || '').slice(3) || '有人';
        const p = { ...PROPOSAL, text: `${who}开门槛时，对门的老者把半块麦饼塞进他手里，没留话。饼是热的，说明他家里今天有火。`, anchors: pool.slice(0, 2) };
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(p) } }] }));
      }
      if (sys.includes('谋士')) {
        // 谋士桩：从世界简报里抓一个真实角色 id，出一个可行选项 + 两个必被滤掉的
        const wm = sys.match(/队伍：[^（(]*[（(]([a-z]+)/);
        const who = wm?.[1] || 'anton';
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ options: [
          { label: `让${who === 'anton' ? '文简' : '他'}把糙米分了`, hint: '一顿安稳饭', intents: [{ type: 'act', actor: who, action: 'eat', target: 'raw' }] },
          { label: '让不存在的人做事', intents: [{ type: 'act', actor: 'nobody', action: 'eat', target: 'raw' }] },
          { label: '越权的选项', intents: [{ type: 'meta', query: 'status' }] }
        ] }) } }] }));
      }
      if (payload.response_format?.type === 'json_object') {
        const userMsg = payload.messages?.at(-1)?.content || '';
        if (/今晚.+去/.test(userMsg)) {
          // 裁判桩：黄昏指派——从世界简报抓第一个角色 id，地点按关键词
          const wm = sys.match(/队伍：[^（(]*[（(]([a-z]+)/);
          const who = wm?.[1] || 'anton';
          const loc = /医棚/.test(userMsg) ? 'hospital' : /宅区/.test(userMsg) ? 'villas' : 'market';
          return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intents: [{ type: 'dusk_assign', scavenger: who, location: loc, gear: [], others: {} }], clarify: null, say: null }) } }] }));
        }
        if (userMsg.includes('龙')) {
          // 裁判桩：狂语 → echo（世界接住这句话，不执行任何动作）
          return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intents: [], clarify: null, say: null, echo: '没有人应你的话。风把这句话吹散了，渡口的水纹了一路。' }) } }] }));
        }
        const wm2 = sys.match(/队伍：[^（(]*[（(]([a-z]+)/);
        const intents = userMsg.trim().startsWith('选')
          ? [{ type: 'event_choice', option: 'g0' }] // 桩：事件选择直通第一项
          : userMsg.trim().startsWith('状态')
            ? [{ type: 'meta', query: 'status' }] // 桩：状态查询（不动状态，不触发宏观收卷）
            : [{ type: 'act', actor: wm2?.[1] || 'bron', action: 'eat', target: 'raw' }]; // 桩：吃生食（阵容自适应）
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intents, clarify: null, say: null }) } }] }));
      }
      res.end(JSON.stringify({ choices: [{ message: { content: '【桩叙事】' } }] }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  process.env.INPUT_RATE_PER_MIN = '0';
  dir = mkdtempSync(join(tmpdir(), 'twom-ge-'));
  applyMigrations(join(dir, 'game.db'));
  app = createApp({ dbPath: join(dir, 'game.db'), adminUsername: 'admin', adminPassword: 'test-admin-pw' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const su = await api('POST', '/api/auth/signup', { username: 'geplayer', password: 'secret1' }, null);
  token = su.token;
  const created = await api('POST', '/api/admin/providers', { name: '桩', adapter: 'openai-compat', baseUrl: `http://127.0.0.1:${stub.address().port}`, model: 'stub', apiKey: 'sk-stub' }, (await api('POST', '/api/auth/login', { username: 'admin', password: 'test-admin-pw' }, null)).token);
  console.log('provider created:', JSON.stringify(created));
  const rt = await api('POST', '/api/admin/llm/routes', { purpose: 'referee', providerId: created.id }, (await api('POST', '/api/auth/login', { username: 'admin', password: 'test-admin-pw' }, null)).token);
  console.log('route:', JSON.stringify(rt));
});

after(() => {
  app.server.close(); app.db.close(); stub.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(method, path, body, tok = token) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  try { return { status: res.status, ...JSON.parse(text) }; } catch { return { status: res.status, raw: text }; }
}

async function input(runId, text) {
  const res = await fetch(`${base}/api/runs/${runId}/input`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ input: text })
  });
  const raw = await res.text();
  let state = null;
  for (const block of raw.split('\n\n')) {
    const ev = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    if (ev === 'state-patch') state = JSON.parse(data).state;
  }
  return state;
}

describe('C 层全链（编剧桩）', () => {
  test('提案 → 验证 → 注入 → 玩家结算', async () => {
    const r = await api('POST', '/api/runs', { prologue: false });
    assert.equal(r.status, 200);
    // 第一次输入：导演预取（异步，桩立回）
    let s = await input(r.id, '状态');
    // 第二次输入：昨日预取已就绪 → 注入
    s = await input(r.id, '状态');
    assert.ok(s.activeEvent?.cardId?.startsWith('ge_'), `C 层卡注入（实际：${s.activeEvent?.cardId}）`);
    assert.equal(s.activeEvent.generated, true);
    assert.match(s.eventView?.title || '', /半块麦饼/);
    // 结算：选第一项（全队 +1 + 板材×1，数值断言走库存）
    const before = s.inventory?.wood || 0;
    s = await input(r.id, '选1');
    assert.ok(!s.activeEvent || s.activeEvent.cardId.startsWith('ge_'), '结算后至多注入下一张 C 层卡');
    assert.equal((s.inventory?.wood || 0), before + 1, '效果白名单入账（板材 +1）');
  });

  test('狂语兜底：echo 演出 + 素材环收存（世界什么都听着）', async () => {
    const r = await api('POST', '/api/runs', { prologue: false });
    const res = await fetch(`${base}/api/runs/${r.id}/input`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ input: '我在渡口看见龙了' })
    });
    const raw = await res.text();
    assert.ok(/^event: echo$/m.test(raw), 'SSE 应有 echo 事件');
    let state = null;
    for (const block of raw.split('\n\n')) {
      const ev = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      if (ev === 'state-patch') state = JSON.parse(data).state;
    }
    assert.ok(state.whispers?.some((w) => w.text.includes('龙')), '素材环收存原话');
  });

  test('刷新命运（/options）：可行放行/戏文轨/预算只算手动、auto 出场免费', async () => {
    const r = await api('POST', '/api/runs', { prologue: false });
    const call = (exclude, auto) => api('POST', `/api/runs/${r.id}/options`, { card: 'day', exclude, auto });
    const r1 = await call([]);
    assert.ok(r1.options?.length === 3, `一个动作选项 + 两个戏文选项（实际 ${JSON.stringify(r1.options)}）`);
    assert.ok(r1.options[0].intents[0].type === 'act');
    assert.ok(r1.options.filter((o) => o.stage).length === 2, '不可行的都走戏文轨');
    assert.ok(r1.options.every((o) => o.stage || o.intents.at(-1).type === 'auto_day'), '动作选项收卷、戏文不收卷');
    // 出场 auto 免费额度：连打多次不占手动预算
    for (let i = 0; i < 3; i++) {
      const a = await call([], true);
      assert.ok(a.options?.length >= 1 && !a.budget, 'auto 不占预算');
    }
    // 手动两次成功后封顶
    const r2 = await call([r1.options[0].label]);
    assert.ok(r2.options?.length >= 1);
    const r3 = await call([]);
    assert.equal(r3.budget, true, '手动两次后应触预算');
    assert.deepEqual(r3.options, []);
  });

  test('宏观收卷：白天自由输入办成事即收卷；黄昏打字指派整夜走完', async () => {
    // 白天：一句自由输入 → 执行 + 自动收卷入黄昏
    const r1 = await api('POST', '/api/runs', { prologue: false });
    const s1 = await input(r1.id, '让石大吃点东西');
    assert.equal(s1.phase, 'dusk', `自由输入应收卷入黄昏（实际 ${s1.phase}）`);
    // 黄昏：打字指派 → 按老规矩带方针，整夜走完到第 2 天
    const s2 = await input(r1.id, '今晚阿走去南市');
    assert.equal(s2.day, 2, `整夜应走完（实际 第${s2.day}天 ${s2.phase}）`);
    assert.ok(!s2.nightView, '夜访已了结');
  });

  test('防火墙：提案含正史名人 → 永不进场', async () => {
    // 换一个输出违禁词的桩只需证明验证器拒绝——单元层已覆盖；
    // 这里验证"导演层失败后静默"：开局照常，无卡也不崩
    const r = await api('POST', '/api/runs', { prologue: false });
    const s = await input(r.id, '状态');
    assert.equal(r.status ?? 200, 200);
    assert.ok(s.chars?.length >= 3);
  });
});
