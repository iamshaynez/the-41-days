#!/usr/bin/env node
// 平衡模拟 CLI：node packages/sim/cli.js [--runs 300] [--policies balanced,gambler] [--seed 41001] [--json]
import { loadPack } from '../core/index.js';
import { runSim, checkGates } from './runner.js';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const runs = Number(flag('runs', 300));
const policies = String(flag('policies', 'balanced,gambler,hoarder,devil')).split(',');
const seed = Number(flag('seed', 41001));

const pack = loadPack();
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
