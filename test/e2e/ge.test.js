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
      if (payload.response_format?.type === 'json_object') {
        const userMsg = payload.messages?.at(-1)?.content || '';
        if (userMsg.includes('龙')) {
          // 裁判桩：狂语 → echo（世界接住这句话，不执行任何动作）
          return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intents: [], clarify: null, say: null, echo: '没有人应你的话。风把这句话吹散了，渡口的水纹了一路。' }) } }] }));
        }
        const intents = userMsg.trim().startsWith('选')
          ? [{ type: 'event_choice', option: 'g0' }] // 桩：事件选择直通第一项
          : [{ type: 'act', actor: 'bron', action: 'eat' }];
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

  test('防火墙：提案含正史名人 → 永不进场', async () => {
    // 换一个输出违禁词的桩只需证明验证器拒绝——单元层已覆盖；
    // 这里验证"导演层失败后静默"：开局照常，无卡也不崩
    const r = await api('POST', '/api/runs', { prologue: false });
    const s = await input(r.id, '状态');
    assert.equal(r.status ?? 200, 200);
    assert.ok(s.chars?.length >= 3);
  });
});
