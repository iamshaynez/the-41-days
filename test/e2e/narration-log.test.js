// 叙事账本去重（修复③）：同一轮的 narrator 文本不得重复入账——
// 实测重进对局时每段戏文连读两遍（index.js 曾对同一 text push 两次）。
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
  dir = mkdtempSync(join(tmpdir(), 'twom-dedup-'));
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

test('跑一天：history 里没有相邻重复的 narrator 条目', async () => {
  const run = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: auth, body: JSON.stringify({ mode: 'direct', prologue: false }) })).json();
  // 白天过一天 + 黄昏留守
  await fetch(`${base}/api/runs/${run.id}/input`, { method: 'POST', headers: auth, body: JSON.stringify({ input: '照常过吧' }) });
  await fetch(`${base}/api/runs/${run.id}/input`, { method: 'POST', headers: auth, body: JSON.stringify({ input: '今晚都不出去，石大守夜' }) });
  const full = await (await fetch(`${base}/api/runs/${run.id}`, { headers: auth })).json();
  const hist = full.history;
  assert.ok(hist.length >= 2, '至少有叙事入账');
  const dups = [];
  for (let i = 1; i < hist.length; i++) {
    if (hist[i].role === 'narrator' && hist[i - 1].role === 'narrator' && hist[i].text === hist[i - 1].text) {
      dups.push(hist[i].text.slice(0, 30));
    }
  }
  assert.deepEqual(dups, [], `相邻重复的叙事块：${dups.join(' | ')}`);
});
