// 列传系统 e2e（人物血肉计划 PR3）：打到终局 → ending 携带每人传记。
// 直读模式走 renderBiographiesDirect；LLM 桩按 timeline 事实写列传、幻觉版被 lint 逐人回退。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../packages/server/index.js';
import { applyMigrations } from '../../packages/server/migrate.js';

let app, base, stub, dir, token, adminToken;
let bioMode = 'factual'; // factual（按事实写）| hallucinate（日数幻觉，必被 lint 回退）

async function boot(withStub) {
  const d = mkdtempSync(join(tmpdir(), 'twom-bio-'));
  applyMigrations(join(d, 'g.db'));
  const a = createApp({ dbPath: join(d, 'g.db'), adminUsername: 'admin', adminPassword: 'x'.repeat(10), inputRatePerMin: 0 });
  await new Promise((r) => a.server.listen(0, r));
  const b = `http://127.0.0.1:${a.port()}`;
  const reg = await (await fetch(`${b}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: '史官' + (withStub ? '2' : '1'), password: 'password1' }) })).json();
  return { app: a, base: b, token: reg.token, dir: d };
}

function makeStub() {
  return createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const sys = JSON.parse(body || '{}').messages?.[0]?.content || '';
      if (sys.includes('列传')) {
        // 史官桩：从传主 JSON 抓 id/name/timeline，按事实成文；幻觉模式统一写"第 99 天"
        // 按传主块解析：每块取自己的 id/name 与 timeline 首拍日（lint 要求引用本传主的节拍日）
        const chunks = sys.split('"id":').slice(1);
        const bios = [], names = [], days = [];
        for (const c of chunks) {
          const id = c.match(/^\s*"([a-z]+)"/)?.[1];
          const name = c.match(/"name":\s*"([^"]+)"/)?.[1];
          const day = c.match(/"day":\s*(\d+)/)?.[1];
          if (id && name) { bios.push(id); names.push(name); days.push(Number(day || 1)); }
        }
        const out = bios.map((id, i) => ({
          id,
          text: bioMode === 'hallucinate'
            ? `${names[i]}者，江陵人也，里坊中人。第 99 天，无中生有的一天，史官笔一滑。后日谈：走了。`
            : `${names[i]}者，江陵人也。第 ${days[i] || 1} 天，账起；此后堂屋的灯夜夜亮着，人在，账就在。围城数十日，他守着他那一页，账上没有一笔虚的。后日谈：后来他跟着渡口的人潮走了，江陵没有留住他。`
        }));
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ bios: out }) } }] }));
      }
      if (JSON.parse(body || '{}').response_format?.type === 'json_object') {
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intents: [], clarify: null, say: null }) } }] }));
      }
      res.end(JSON.stringify({ choices: [{ message: { content: '【桩叙事】' } }] }));
    });
  });
}

const auth = (t) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

async function input(b, t, id, text) {
  const res = await fetch(`${b}/api/runs/${id}/input`, { method: 'POST', headers: auth(t), body: JSON.stringify({ input: text }) });
  const raw = await res.text();
  let st = null;
  for (const m of raw.matchAll(/event: state-patch\ndata: (.+)\n/g)) st = JSON.parse(m[1]).state || st;
  for (const m of raw.matchAll(/event: done\ndata: (.+)\n/g)) { const d = JSON.parse(m[1]); if (d.state) st = d.state; }
  return st;
}

/** 硬挨到终局（单一难度更宽容，被动队也可能撑到交割日——上限放到 D50） */
async function playToEnd(b, t, id) {
  let st = await (await fetch(`${b}/api/runs/${id}`, { headers: auth(t) })).json().then((r) => r.state);
  for (let d = 0; d < 50 && !st.over; d++) {
    if (st.eventView) {
      const o = st.eventView.options[st.eventView.options.length - 1];
      st = (await input(b, t, id, `选${o.key === 'refuse' ? 'B' : 'A'}`)) || st;
      if (st.over) break;
    }
    st = (await input(b, t, id, '天黑吧')) || st;
    if (st.over) break;
    const guardName = st.charView?.find((c) => c.alive)?.name || '石大';
    st = (await input(b, t, id, `今晚都不出去，${guardName}守夜`)) || st;
  }
  assert.ok(st.over, '50 天内应终局');
  return st;
}

describe('列传 e2e：直读模式（LLM 全挂）', () => {
  test('终局（全灭或开城）：ending.biographies 每人一段，via=direct，开篇史书体', async () => {
    const ctx = await boot(false);
    try {
      const run = await (await fetch(`${ctx.base}/api/runs`, { method: 'POST', headers: auth(ctx.token), body: JSON.stringify({ mode: 'direct', seed: 42, prologue: false }) })).json();
      await playToEnd(ctx.base, ctx.token, run.id);
      const full = await (await fetch(`${ctx.base}/api/runs/${run.id}`, { headers: auth(ctx.token) })).json();
      const bios = full.ending.biographies;
      assert.ok(Array.isArray(bios) && bios.length === 3, '三人各一传');
      for (const b of bios) {
        assert.equal(b.via, 'direct');
        assert.match(b.text, /者，/, '史书体开篇');
        assert.match(b.text, /后日谈/, '末段有去向');
      }
    } finally {
      ctx.app.server.close(); rmSync(ctx.dir, { recursive: true, force: true });
    }
  });
});

describe('列传 e2e：LLM 模式（桩史官）', () => {
  before(async () => {
    stub = makeStub();
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const ctx = await boot(true);
    app = ctx.app; base = ctx.base; token = ctx.token; dir = ctx.dir;
    adminToken = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'x'.repeat(10) }) })).json()).token;
    const created = await (await fetch(`${base}/api/admin/providers`, { method: 'POST', headers: auth(adminToken), body: JSON.stringify({ name: '桩', adapter: 'openai-compat', baseUrl: `http://127.0.0.1:${stub.address().port}`, model: 'stub', apiKey: 'sk-stub' }) })).json();
    await fetch(`${base}/api/admin/llm/routes`, { method: 'POST', headers: auth(adminToken), body: JSON.stringify({ purpose: 'biographer', providerId: created.id }) });
  });
  after(() => { app.server.close(); stub.close(); rmSync(dir, { recursive: true, force: true }); });

  test('按事实写的列传放行（via=llm）；幻觉版逐人回退直读（不连坐）', async () => {
    bioMode = 'factual';
    const run = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: auth(token), body: JSON.stringify({ seed: 42, prologue: false }) })).json();
    await playToEnd(base, token, run.id);
    let full = await (await fetch(`${base}/api/runs/${run.id}`, { headers: auth(token) })).json();
    assert.ok(full.ending.biographies.every((b) => b.via === 'llm'), '按 timeline 写的列传应放行');

    bioMode = 'hallucinate';
    const run2 = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: auth(token), body: JSON.stringify({ seed: 42, prologue: false }) })).json();
    await playToEnd(base, token, run2.id);
    full = await (await fetch(`${base}/api/runs/${run2.id}`, { headers: auth(token) })).json();
    assert.ok(full.ending.biographies.every((b) => b.via === 'direct'), '第 99 天的幻觉必须被 lint 逐人回退');
  });
});
