// 跨周目回响 e2e（长线体验-v0.2 EC 系）：时间胶囊全链 / 史册格字段
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../packages/server/index.js';
import { applyMigrations } from '../../packages/server/migrate.js';

let app, base, dir;
let token;

before(async () => {
  process.env.INPUT_RATE_PER_MIN = '0'; // 全链回放要几百次输入，关掉限流
  dir = mkdtempSync(join(tmpdir(), 'twom-echo-'));
  applyMigrations(join(dir, 'game.db'));
  app = createApp({ dbPath: join(dir, 'game.db'), adminUsername: 'admin', adminPassword: 'test-admin-pw' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const su = await api('POST', '/api/auth/signup', { username: 'echoer', password: 'secret1' });
  token = su.token;
});

after(() => {
  app.server.close(); app.db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ...json };
}

async function input(runId, text) {
  const res = await fetch(`${base}/api/runs/${runId}/input`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ input: text })
  });
  assert.equal(res.status, 200);
  const raw = await res.text();
  let state = null;
  const texts = [];
  for (const block of raw.split('\n\n')) {
    const ev = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    if (ev === 'state-patch') state = JSON.parse(data).state;
    if (ev === 'narration-delta') texts.push(JSON.parse(data).d);
  }
  return { state, text: texts.join('') };
}

/** 守家到终局（直读模式）：事件选 1，白天托管，黄昏全在家 */
async function playUntilOver(runId) {
  let state = null;
  for (let i = 0; i < 160; i++) {
    const r = await api('GET', `/api/runs/${runId}`);
    state = r.state;
    if (state.over) return state;
    if (state.activeEvent) {
      // 选项可能因缺物不可用（事件不解锁会让循环卡死）：逐个试
      for (const k of ['选1', '选2', '选3']) {
        const r = await input(runId, k);
        if (!r.state.activeEvent || r.state.activeEvent.cardId !== state.activeEvent.cardId) break;
      }
    }
    else if (state.phase === 'day') await input(runId, '照常过吧');
    else if (state.phase === 'dusk') await input(runId, '今晚都在家');
    else await input(runId, '继续');
  }
  return state;
}

describe('时间胶囊全链（EC-02：埋 → 下周目挖 → 再下周目只剩字条）', () => {
  test('闭环', async () => {
    const r1 = await api('POST', '/api/runs', { mode: 'direct', prologue: false });
    // 进行中的局不能埋
    const early = await api('POST', `/api/runs/${r1.id}/capsule`, { item: 'wood', message: '给后来的人' });
    assert.equal(early.status, 409, '进行中的局不能埋');

    const end = await playUntilOver(r1.id);
    assert.ok(end.over, '第一局应终局');
    const invItem = Object.entries(end.inventory || {}).find(([, n]) => n > 0);
    assert.ok(invItem, '终局总还剩点什么');
    const [item] = invItem;
    const bury = await api('POST', `/api/runs/${r1.id}/capsule`, { item, message: '给后来的人：别嫌少。' });
    assert.equal(bury.status, 200, '局终可埋');

    // 第二局：后院挖到（东西在）
    const r2 = await api('POST', '/api/runs', { mode: 'direct', prologue: false });
    const before = r2.state.inventory[item] || 0;
    const dig = await input(r2.id, '搜后院');
    assert.match(dig.text, /给后来的人/, '读到了上周目的字条');
    const afterDig = dig.state.inventory[item] || 0;
    assert.equal(afterDig, before + 1, '第一次挖到：东西还在');

    // 第三局：只剩字条（东西已被取走）
    const r3 = await api('POST', '/api/runs', { mode: 'direct', prologue: false });
    const dig3 = await input(r3.id, '搜后院');
    assert.match(dig3.text, /上次已经取走/, '第三次起只剩字条');
  });

  test('校验：文档埋不了，留话一百字以内', async () => {
    const r1 = await api('POST', '/api/runs', { mode: 'direct', prologue: false });
    const bad = await api('POST', `/api/runs/${r1.id}/capsule`, { item: 'doc', message: '纸' });
    assert.equal(bad.status, 400);
    const long = await api('POST', `/api/runs/${r1.id}/capsule`, { item: 'wood', message: '长'.repeat(101) });
    assert.equal(long.status, 400);
  });
});

describe('史册格（/api/archive）', () => {
  test('正史栏随包下发，野史栏与回响区字段在', async () => {
    const r = await api('GET', '/api/archive');
    assert.equal(r.status, 200);
    assert.ok((r.canonAnnals || []).length >= 3, '正史栏有通行叙事');
    assert.ok(Array.isArray(r.annals), '野史栏字段存在');
    assert.ok(Array.isArray(r.echoes), '回响区字段存在');
    assert.ok(r.echoes.some((e) => e.kind === 'capsule'), '胶囊在回响区');
  });
});

describe('回忆录成册与合上兰台（EX-01 / §3.6）', () => {
  test('成册下载：玩过局入书，带扉页', async () => {
    const r = await fetch(`${base}/api/archive/memoir-book`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/plain/);
    const text = await r.text();
    assert.match(text, /《我的江陵》/);
    assert.match(text, /第 1 章/, '前面玩过的局已成章');
  });
  test('谢幕门：条件不齐时 409，档案馆如实报进度', async () => {
    const a = await api('GET', '/api/archive');
    assert.equal(a.closure.done, false);
    assert.equal(a.closure.available, false, '文档未满不合');
    assert.ok(a.closure.progress.total > 0);
    const close = await api('POST', '/api/archive/close');
    assert.equal(close.status, 409, '条件不齐不给合');
  });
});
