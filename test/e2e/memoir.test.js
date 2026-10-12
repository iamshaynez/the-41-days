// 终局回忆录 e2e：HTTP 全链路——开局 → 打到终局 → ending 携带 storyline + 文学复盘 + 档案馆沉淀。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../packages/server/index.js';
import { applyMigrations } from '../../packages/server/migrate.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'twom-e2e-'));
  applyMigrations(join(dir, 'g.db')); // 部署等价路径：显式迁移在前
  const app = createApp({ dbPath: join(dir, 'g.db'), adminUsername: 'admin', adminPassword: 'x'.repeat(10), inputRatePerMin: 0 });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.port()}`;
  const reg = await (await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: '复盘员', password: 'password1' }) })).json();
  return { app, base, token: reg.token };
}
const auth = (t) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

async function input(base, token, id, text) {
  const res = await fetch(`${base}/api/runs/${id}/input`, { method: 'POST', headers: auth(token), body: JSON.stringify({ input: text }) });
  const raw = await res.text();
  // 解析 SSE：state-patch 与 done 都可能携带终态（data 是 {state:…} 包装）
  let st = null;
  for (const m of raw.matchAll(/event: state-patch\ndata: (.+)\n/g)) st = JSON.parse(m[1]).state || st;
  for (const m of raw.matchAll(/event: done\ndata: (.+)\n/g)) { const d = JSON.parse(m[1]); if (d.state) st = d.state; }
  return { raw, state: st };
}

describe('e2e：终局回忆录', () => {
  test('全灭局：ending 携带 storyline + 直读回忆录，档案馆收录', async () => {
    const { app, base, token } = await boot();
    try {
      const run = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: auth(token), body: JSON.stringify({ seed: 42, prologue: false }) })).json();
      // 什么都不干，硬挨到全灭（最多 40 天）
      let st = run.state;
      for (let d = 0; d < 40; d++) {
        if (st.over) break;
        if (st.eventView) { const o = st.eventView.options[st.eventView.options.length - 1]; const r = await input(base, token, run.id, `选${o.key === 'refuse' ? 'B' : 'A'}`); st = r.state || st; if (st.over) break; }
        let r = await input(base, token, run.id, '天黑吧');
        st = r.state || st;
        if (st.over) break;
        const guardName = st.charView?.find((c) => c.alive)?.name || '石大';
        r = await input(base, token, run.id, `今晚都不出去，${guardName}守夜`);
        st = r.state || st;
      }
      assert.ok(st.over, '40 天内应终局');
      const full = await (await fetch(`${base}/api/runs/${run.id}`, { headers: auth(token) })).json();
      assert.ok(full.ending, '结局已落库');
      assert.ok(full.ending.storyline?.beats?.length >= 1, 'storyline 有节拍');
      assert.ok(full.ending.memoir, '有回忆录');
      assert.match(full.ending.memoir, /槐树街 21 号|故事线/, '直读回忆录成形');
      assert.equal(full.ending.memoirVia, 'direct', '无 LLM 时走直读');
      // 人的账：饿死是这一局的主旋律，deny/witness 至少其一在节拍里
      const verbs = full.ending.storyline.beats.map((b) => b.verb);
      assert.ok(verbs.includes('witness_death'), '死亡在故事线里');
      // 档案馆
      const arch = await (await fetch(`${base}/api/archive`, { headers: auth(token) })).json();
      const mem = arch.runs.find((r) => r.memoir);
      assert.ok(mem, '档案馆收录了回忆录');
    } finally {
      app.server.close();
    }
  });
});
