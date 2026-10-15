// 群像批次（主角代入感）：开局关系网（不再是三个陌生人）、人物梗（重复出现的记忆钩子）、
// 记名钩子（开局一行：名字·职衔·题名）。关系开局入信任弧（PAIR_ARC 可回放），
// 梗按种子日程轻触（晨报轨），浮卡亮关系与心结。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK } from '../helpers.js';
import { Ctx, fold } from '../../packages/core/index.js';
import { relationsOf } from '../../packages/core/src/delegate.js';
import { tickThreads } from '../../packages/core/src/threads.js';

describe('内容契约：关系网与梗', () => {
  test('14 对关系：两端皆在册、每人 ≥2 条；12 人人有意一件（gesture 带 ≥2 句）', () => {
    const rels = PACK.relations;
    assert.ok(rels.length >= 14, `关系网要成规模（${rels.length}）`);
    const deg = {};
    for (const r of rels) {
      assert.ok(PACK.charMap[r.a] && PACK.charMap[r.b], `关系 ${r.a}-${r.b} 两端在册`);
      deg[r.a] = (deg[r.a] || 0) + 1; deg[r.b] = (deg[r.b] || 0) + 1;
      assert.ok(r.label && r.opener && Number.isInteger(r.arc), '关系要有名、有开局一句、有弧值');
    }
    for (const c of PACK.characters) {
      assert.ok((deg[c.id] || 0) >= 2, `${c.name} 至少 2 条关系（实际 ${deg[c.id] || 0}）`);
      const g = c.persona?.gesture;
      assert.ok(g && g.sig && g.lines.length >= 2, `${c.name} 要有梗（招牌小动作 + ≥2 句）`);
    }
  });
});

describe('开局关系：进门就不是陌生人', () => {
  test('同册有关系 → 信任弧预置 + 开局落账一句；无关三人不落', () => {
    // bronze–grigory 火场之命（arc 3）
    const r1 = newRun({ seed: 701, roster: ['bron', 'grigory', 'katya'] });
    assert.ok(r1.facts.some((f) => f.k === 'relation_open' && [f.a, f.b].sort().join() === 'bron,grigory'),
      '火场之命要开局落账');
    const key = ['bron', 'grigory'].sort().join('|');
    assert.ok((r1.state.causality?.pairArcs?.[key]?.pos || 0) >= 3, '信任弧预置 ≥3');
    // 三个互无关系的人：不落关系账（挑一组无定义关系的三人）
    const r2 = newRun({ seed: 702, roster: ['pavel', 'emil', 'zofia'] });
    assert.ok(!r2.facts.some((f) => f.k === 'relation_open'), '无定义关系不硬造');
  });

  test('关系账走 PAIR_ARC 事件：fold 回放一致', () => {
    const r = newRun({ seed: 703, roster: ['zofia', 'katya', 'marta'] });
    const replay = fold(r.events);
    const key = ['zofia', 'katya'].sort().join('|');
    assert.equal(replay.causality?.pairArcs?.[key]?.pos, r.state.causality?.pairArcs?.[key]?.pos, '回放信任弧一致');
  });

  test('开局记名钩子：每人一行「名字，职衔——题名」', () => {
    const r = newRun({ seed: 704, roster: ['anton', 'marta', 'bron'] });
    const intros = r.facts.filter((f) => f.k === 'intro');
    assert.equal(intros.length, 3, '三人三行');
    for (const f of intros) assert.ok(f.name && f.role && f.hook, '名字/职衔/题名齐');
  });
});

describe('relationsOf：浮卡的关系面', () => {
  test('双向点名 + 弧档词（过命/信任/有旧怨）', () => {
    const r = newRun({ seed: 705, roster: ['bron', 'grigory', 'katya'] });
    const s = r.state;
    const b = relationsOf(s, PACK, 'bron');
    const g = relationsOf(s, PACK, 'grigory');
    assert.ok(b.some((x) => x.id === 'grigory' && x.label === '火场之命' && /过命/.test(x.arcWord)), 'bron 侧看到 grigory·火场之命·过命');
    assert.ok(g.some((x) => x.id === 'bron'), '双向');
    const k = relationsOf(s, PACK, 'katya');
    assert.ok(k.length === 0 || k.every((x) => PACK.charMap[x.id]), '缺席者不出现');
  });
});

describe('人物梗：重复即记忆', () => {
  test('按种子日程轻触：跨 12 天至少 2 梗、同日不超 1 梗、每人句有变体', () => {
    let total = 0, perDay = {};
    const lines = new Set();
    for (let day = 4; day <= 16; day++) {
      const { state } = newRun({ seed: 710, roster: ['anton', 'marta', 'bron'] });
      state.day = day;
      const ctx = new Ctx(state, PACK, [], []);
      tickThreads(ctx);
      const gs = ctx.facts.filter((f) => f.k === 'gesture');
      perDay[day] = gs.length;
      assert.ok(gs.length <= 1, `一日至多一梗（D${day} 出 ${gs.length}）`);
      total += gs.length;
      for (const g of gs) lines.add(g.line);
    }
    assert.ok(total >= 2, `12 天里梗至少出现 2 次（实际 ${total}）`);
    // 跨种子：同一人同一梗有不同句
    const l2 = new Set();
    for (let seed = 1; seed <= 12; seed++) {
      const { state } = newRun({ seed, roster: ['anton', 'marta', 'bron'] });
      state.day = 9;
      const ctx = new Ctx(state, PACK, [], []);
      tickThreads(ctx);
      for (const g of ctx.facts.filter((f) => f.k === 'gesture')) l2.add(g.line);
    }
    assert.ok(l2.size >= 2, '同梗不同周目不同句');
  });
});
