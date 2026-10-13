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
  test('终局（夜夜赌命驱动）：ending 携带 storyline + 直读回忆录，档案馆收录', async () => {
    const { app, base, token } = await boot();
    try {
      const run = await (await fetch(`${base}/api/runs`, { method: 'POST', headers: auth(token), body: JSON.stringify({ seed: 42, prologue: false }) })).json();
      // 单一难度下被动队也能活到交割——想测死亡链就得自己找死：
      // 每晚派最壮的人空手闯已知的最险地点（赌徒策略，全灭率 >90%）。
      // 驱动与 UI 同构：每轮以 GET 重取状态（SSE 补丁可能停在轮中态）。
      const getSt = async () => (await (await fetch(`${base}/api/runs/${run.id}`, { headers: auth(token) })).json()).state;
      const sendIntents = async (keyOrIntent) => {
        const intents = typeof keyOrIntent === 'string'
          ? (keyOrIntent === 'auto_night' || keyOrIntent === 'advance'
              ? [{ type: keyOrIntent }]
              : [{ type: 'event_choice', option: keyOrIntent }])
          : [keyOrIntent];
        const res = await fetch(`${base}/api/runs/${run.id}/input`, { method: 'POST', headers: auth(token), body: JSON.stringify({ intents }) });
        await res.text();
      };
      for (let d = 0; d < 50; d++) {
        let st = await getSt();
        if (st.over) break;
        if (st.eventView) {
          const opt = st.eventView.options.find((o) => o.ok !== false) || st.eventView.options[0];
          await input(base, token, run.id, opt.label);
          st = await getSt();
          if (st.over) break;
          if (st.eventView) continue;
        }
        if (st.phase === 'day') {
          await input(base, token, run.id, '天黑吧');
          st = await getSt();
          if (st.over || st.phase !== 'dusk') continue;
        }
        if (st.phase === 'dusk') {
          const tough = st.charView?.filter((c) => c.alive).sort((a, b) => (b.combat ?? 0) - (a.combat ?? 0))[0]
            || st.charView?.find((c) => c.alive) || { name: '石大' };
          await input(base, token, run.id, `今晚${tough.name}去被焚的南市`);
          st = await getSt();
          if (!st.over && st.phase === 'dusk') { // 地点搜空/不可去：退回守夜
            await input(base, token, run.id, `今晚都不出去，${tough.name}守夜`);
            st = await getSt();
          }
        }
        let stall = '';
        let guard = 0;
        while (!st.over && st.phase === 'night' && st.night && !st.night.home && guard++ < 20) {
          if (st.eventView) {
            const opt = st.eventView.options.find((o) => o.ok !== false) || st.eventView.options[0];
            await sendIntents(opt.key);
          } else {
            await sendIntents('auto_night');
          }
          const prev = stall;
          stall = `${st.day}|${st.phase}|${st.night?.slots}|${st.eventView?.title ?? ''}`;
          if (prev === stall) { await sendIntents('advance'); } // 卡住：推进/撤退兜底
          st = await getSt();
        }
      }
      let st = await getSt();
      assert.ok(st.over, '50 天内应终局');
      const full = await (await fetch(`${base}/api/runs/${run.id}`, { headers: auth(token) })).json();
      assert.ok(full.ending, '结局已落库');
      assert.ok(full.ending.storyline?.beats?.length >= 1, 'storyline 有节拍');
      assert.ok(full.ending.memoir, '有回忆录');
      assert.match(full.ending.memoir, /槐树街 21 号|故事线/, '直读回忆录成形');
      assert.equal(full.ending.memoirVia, 'direct', '无 LLM 时走直读');
      // 人的账：赌命局若有人死（>90% 概率），死亡必须进故事线；活到交割的少数局不硬求
      const verbs = full.ending.storyline.beats.map((b) => b.verb);
      if (full.ending.type === 'wiped') assert.ok(verbs.includes('witness_death'), '全灭局死亡在故事线里');
      // 档案馆
      const arch = await (await fetch(`${base}/api/archive`, { headers: auth(token) })).json();
      const mem = arch.runs.find((r) => r.memoir);
      assert.ok(mem, '档案馆收录了回忆录');
    } finally {
      app.server.close();
    }
  });
});
