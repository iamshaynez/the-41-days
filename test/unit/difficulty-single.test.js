// 难度合并：单一较低难度（玩家不再选）——降低进入门槛，让多数认真玩的局
// 能活到交割日（D45 的交割夜是全游戏的情感顶点，此前均衡策略仅 ~38% 活到）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack, createRun, difficultyCfg } from '../../packages/core/index.js';

const PACK = loadPack();

describe('单一难度', () => {
  test('manifest 只有一档难度（玩家无可选）', () => {
    const keys = Object.keys(PACK.manifest.difficulty);
    assert.equal(keys.length, 1, `难度应只剩一档（实际 ${keys.join(',')}）`);
  });

  test('新局默认落在这唯一一档上', () => {
    const s = createRun(PACK, { seed: 1 });
    assert.ok(PACK.manifest.difficulty[s.difficulty], `默认难度 ${s.difficulty} 必须在 manifest 里`);
  });

  test('这一档是低压力参数（旧叙事档为基准）', () => {
    const cfg = difficultyCfg(PACK, { difficulty: Object.keys(PACK.manifest.difficulty)[0] });
    assert.ok(cfg.raidMul <= 0.75, `袭击频率系数应 ≤0.75（实际 ${cfg.raidMul}）`);
    assert.ok(cfg.starveSick <= 0.1, `饿转病概率应 ≤0.1（实际 ${cfg.starveSick}）`);
    assert.ok(cfg.checkMod >= 1, `检定加值应 ≥1（实际 ${cfg.checkMod}）`);
  });

  test('旧存档的 documentary/narrative 值仍能落到唯一档（不炸档）', () => {
    const cfg = difficultyCfg(PACK, { difficulty: 'narrative' });
    assert.equal(cfg, PACK.manifest.difficulty[Object.keys(PACK.manifest.difficulty)[0]]);
  });
});
