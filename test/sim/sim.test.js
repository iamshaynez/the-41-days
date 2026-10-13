// L7 平衡模拟门禁（技术架构 §11.3）：固定种子 → 确定性 KPI 断言。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack } from '../../packages/core/index.js';
import { runSim, checkGates } from '../../packages/sim/runner.js';

const pack = loadPack();

describe('平衡模拟（固定种子，确定性）', () => {
  const report = runSim(pack, { runs: 100, seed: 41001, policies: ['balanced', 'gambler', 'hoarder', 'devil'] });

  test('同参数重跑 → 报告逐字节一致（RND-06）', () => {
    const again = runSim(pack, { runs: 100, seed: 41001, policies: ['balanced', 'gambler', 'hoarder', 'devil'] });
    assert.equal(JSON.stringify(again.runs), JSON.stringify(report.runs));
  });

  test('守恒与出界：无 NaN、天数/存活合法', () => {
    for (const r of report.runs) {
      assert.ok(Number.isFinite(r.days) && r.days >= 1 && r.days <= 62);
      assert.ok(r.alive >= 0 && r.alive <= 3);
      assert.ok(['ceasefire', 'contract_end', 'wiped', 'timeout', 'maicheng', 'pyrrhic', 'alt_both', 'hostage'].includes(r.ending)); // v0.2：结局枚举含或然三类
    }
  });

  test('策略分离：赌徒最惨，守财奴活不过均衡，恶魔受道德惩罚', () => {
    const k = report.kpis;
    assert.ok(k.gambler.wipe_rate >= k.balanced.wipe_rate, '赌徒全灭率应 ≥ 均衡');
    assert.ok(k.hoarder.any_survivor_to_end <= k.balanced.any_survivor_to_end, '守家不应优于外出');
    assert.ok(k.devil.any_survivor_to_end < k.balanced.any_survivor_to_end - 0.03, '恶魔存活率应显著低于均衡');
  });

  test('KPI 门禁（kpis.json 目标带，PR 必跑）', () => {
    const gate = checkGates(report, pack.kpis.gates);
    assert.ok(gate.pass, `门禁失败：${gate.failures.join('；')}`);
  });
});

describe('管家自驾（delegate）：玩家全部委托这条路径的平衡性', () => {
  // 管家就是游戏内 autopilot 本人——玩家"全程只点卡"不应等于送死，也不应显著劣于均衡策略
  const report = runSim(pack, { runs: 100, seed: 41001, policies: ['delegate'] });

  test('确定性：重跑逐字节一致', () => {
    const again = runSim(pack, { runs: 100, seed: 41001, policies: ['delegate'] });
    assert.equal(JSON.stringify(again.runs), JSON.stringify(report.runs));
  });

  test('管家及格：中位局长不崩盘，有人能活到停火', () => {
    const d = report.kpis.delegate;
    assert.ok(d.median_days >= 15, `管家带队中位 ${d.median_days} 天，太短说明委托=送死`);
    assert.ok(d.any_survivor_to_end >= 0.1, `委托后活到停火率 ${(d.any_survivor_to_end * 100).toFixed(0)}%，不应趋零`);
    assert.ok(d.docs_median >= 1, '管家夜里应能带回文档（暗线不该被自动化饿死）');
  });
});
