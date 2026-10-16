#!/usr/bin/env node
// 平衡模拟 CLI：node packages/sim/cli.js [--runs 300] [--policies balanced,gambler] [--seed 41001] [--json]
//               node packages/sim/cli.js --side luzhou|all [--runs 80] [--random]   ← 别传生存/结局分布（CH-04/05；--random 随机选项看分叉覆盖）
import { loadPack } from '../core/index.js';
import { runSim, runSideSim, checkGates } from './runner.js';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const runs = Number(flag('runs', 300));
const policies = String(flag('policies', 'balanced,gambler,hoarder,devil')).split(',');
const seed = Number(flag('seed', 41001));

const pack = loadPack();
const side = flag('side', null);
if (side) {
  const ids = side === 'all' ? pack.sidestories.map((d) => d.id) : side.split(',');
  const reports = ids.map((id) => runSideSim(pack, { story: id, runs: Number(flag('runs', 80)), seed, policy: policies[0], randomChoices: args.includes('--random') }));
  if (args.includes('--json')) { console.log(JSON.stringify(reports, null, 1)); process.exit(0); }
  console.log(`别传平衡模拟 · ${reports[0]?.runs} 局/部 · 策略 ${policies[0]}${args.includes('--random') ? ' · 随机选项' : ''}\n`);
  for (const r of reports) {
    const pct = (x) => `${(x * 100).toFixed(0)}%`;
    console.log(`■ ${r.title}（${r.story}）  到点收束 ${pct(r.reachedEnd)} · 全员活 ${pct(r.allAlive)} · 有人死 ${pct(r.anyDeath)} · 全灭 ${pct(r.wiped)} · 均每局 ${r.cardsPerRun.toFixed(1)} 张别传卡`);
    console.log(`  结局分布：${Object.entries(r.endings).map(([t, n]) => `${t}×${n}`).join('  ')}`);
  }
  process.exit(0);
}
const t0 = Date.now();
const report = runSim(pack, { runs, seed, policies });
const gate = checkGates(report, pack.kpis.gates);

if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 1));
} else {
  console.log(`《第 41 天》平衡模拟 · ${runs} 局 × ${policies.length} 策略 · ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  for (const [p, k] of Object.entries(report.kpis)) {
    console.log(`■ ${p}（n=${k.n}）`);
    console.log(`  中位时长 ${k.median_days} 天 · 有人活到停火 ${(k.any_survivor_to_end * 100).toFixed(0)}% · 全灭 ${(k.wipe_rate * 100).toFixed(0)}% · 停火结局 ${(k.ceasefire_rate * 100).toFixed(0)}% · 文档中位 ${k.docs_median}`);
  }
  console.log(`\n门禁：${gate.pass ? '✅ 全部通过' : '❌ ' + gate.failures.join('；')}`);
}
process.exit(gate.pass ? 0 : 1);
