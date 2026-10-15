// 别传 HTTP 创建（修复回归）：POST /api/runs {sidestory} 曾因 sideUnlocked 的 TDZ
// 必然 500——菜单看得见（/api/sidestories 在声明之后），点进去必炸，前端把书页清空
// 后抛 TypeError，玩家面对一本空书。这里钉死整条链：解锁→创建→能输入推进。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../packages/server/index.js';
import { applyMigrations } from '../../packages/server/migrate.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app, base, dir, token;
const auth = { 'content-type': 'application/json' };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'twom-side-'));
  applyMigrations(join(dir, 'g.db'));
  app = createApp({ dbPath: join(dir, 'g.db'), adminUsername: 'admin', adminPassword: 'x'.repeat(10), inputRatePerMin: 0 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.port()}`;
  const reg = await (await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: auth, body: JSON.stringify({ username: '史官', password: 'password1' }) })).json();
  token = reg.token;
  auth.authorization = `Bearer ${token}`;
});

after(async () => {
  await new Promise((r) => app.server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

test('解锁的别传能从菜单一路点进去：列出→创建→开局即有卡可点、有输入可落', async () => {
  // 档案塞满三枚封印（对应三个 5 日别传的解锁门）+ 一条野史（樊城门）
  for (const sid of ['seal_franko_net', 'seal_shelling_list', 'seal_brother_dead']) {
    app.db.archivePut(1, 'seal', sid, { layer: 1, text: '真相一行' }, null);
  }
  app.db.archivePut(1, 'annal', 'a1', { text: '野史一笔' }, null);

  const listed = await (await fetch(`${base}/api/sidestories`, { headers: auth })).json();
  const open = (listed.stories || []).filter((x) => x.unlocked);
  assert.ok(open.length >= 4, `解锁的别传应至少 4 个（实测 ${open.length}）`);

  for (const st of open) {
    const res = await fetch(`${base}/api/runs`, { method: 'POST', headers: auth, body: JSON.stringify({ sidestory: st.id }) });
    const r = await res.json();
    assert.ok(res.ok, `${st.id} 创建应成功（实测 ${res.status} ${r.error || ''}）——旧 bug：sideUnlocked 在同作用域后段声明，创建必 500`);
    assert.equal(r.state.sidestory?.id, st.id, `${st.id} 状态应带别传身份`);
    assert.equal(r.state.phase, 'day', `${st.id} 别传开局应在白天（有今日卡可点）`);
    assert.ok(r.state.charView?.length, `${st.id} 应有人在场`);
    // 开局第一轮能推进（今日卡点得动）——直读意图走 input 管线
    const first = await fetch(`${base}/api/runs/${r.id}/input`, {
      method: 'POST', headers: auth, body: JSON.stringify({ intents: [{ type: 'auto_day' }] })
    });
    assert.equal(first.status, 200, `${st.id} 第一轮输入应 200`);
    const raw = await first.text();
    assert.match(raw, /event: done/, `${st.id} 第一轮应善终`);
  }
});

test('没解锁的别传：菜单不亮门，硬闯 403 带提示', async () => {
  const fresh = await (await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: '新客', password: 'password1' }) })).json();
  const res = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${fresh.token}` },
    body: JSON.stringify({ sidestory: 'luzhou' })
  });
  assert.equal(res.status, 403);
  const r = await res.json();
  assert.equal(r.error, '这扇门还没认你。');
  assert.ok(r.hint, '403 应带解锁提示（前端要说给玩家听）');
});

test('不存在的别传 404（菜单刷新间隙的陈旧项）', async () => {
  const res = await fetch(`${base}/api/runs`, { method: 'POST', headers: auth, body: JSON.stringify({ sidestory: 'nope' }) });
  assert.equal(res.status, 404);
});
