// 人物血肉计划 PR1：暗面与立场（全员 shadow/stances + shadowTouched 记账）。
// 设计意图：每个幸存者都是有暗面的人——污点可被剧情翻出来（PR2 暗面场），
// 也可被玩家推向救赎或堕落；五幕立场（stances）供堂屋评史场取材。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PACK, newRun, step, ch, skipDayAtHome } from '../helpers.js';
import { VERBS } from '../../packages/core/src/causality.js';
import { fold } from '../../packages/core/index.js';

const ACTS = ['A1', 'A2', 'A3', 'A4', 'A5'];

describe('暗面结构：十二人全员（人物血肉计划）', () => {
  test('每人都有 shadow（污点/扳机/堕落/救赎）与五幕立场，voice 至少八句', () => {
    for (const c of PACK.characters) {
      const p = c.persona || {};
      assert.ok(p.shadow, `${c.name}（${c.id}）缺 shadow`);
      assert.ok(typeof p.shadow.stain === 'string' && p.shadow.stain.length >= 10, `${c.name} 的污点不成句`);
      const trg = p.shadow.trigger?.verbs;
      assert.ok(Array.isArray(trg) && trg.length >= 1, `${c.name} 缺暗面扳机动词`);
      for (const v of trg) assert.ok(VERBS[v], `${c.name} 的扳机动词 ${v} 不在因果动词表内`);
      assert.ok((p.shadow.descent || []).length >= 2, `${c.name} 缺堕落台词（至少两句）`);
      assert.ok((p.shadow.redemption || []).length >= 1, `${c.name} 缺救赎种子`);
      if (p.shadow.trigger?.act) assert.ok(ACTS.includes(p.shadow.trigger.act), `${c.name} 的扳机幕 ${p.shadow.trigger.act} 不存在`);
      assert.ok(p.stances, `${c.name} 缺五幕立场`);
      for (const a of ACTS) assert.ok(typeof p.stances[a] === 'string' && p.stances[a].length >= 6, `${c.name} 缺 ${a} 立场`);
      assert.ok((p.voice || []).length >= 8, `${c.name} 的 voice 不足八句（现有 ${p.voice?.length}）`);
    }
  });

  test('暗面有梯度：重污点与软肋型拉开光谱，不全是好人也不全是恶人', () => {
    const by = (g) => PACK.characters.filter((c) => c.persona.shadow.grade === g);
    assert.equal(PACK.characters.length, by('heavy').length + by('mid').length + by('soft').length, 'grade 必须三档全归类');
    assert.ok(by('heavy').length >= 3, `重污点（heavy）人数不足（现 ${by('heavy').length}）`);
    assert.ok(by('soft').length >= 2, `软肋型（soft）人数不足（现 ${by('soft').length}）`);
    assert.ok(by('mid').length >= 2, `中间档（mid）人数不足（现 ${by('mid').length}）`);
  });

  test('旁传角色不强制 shadow（校验只约束主池十二人）', () => {
    // 鲁舟等 sideChars 的 persona 是精简卡；loadPack 通过即说明旁传未被误伤。
    assert.ok(PACK.charMap.luzhou, '旁传角色鲁舟应存在于 charMap');
  });
});

describe('暗面记账（shadowTouched）：扳机动词命中即累加', () => {
  test('白简见证烧简（burn_book 是他的扳机）→ 计数入账', () => {
    const { state } = newRun({ seed: 7, roster: ['katya', 'marta', 'bron'] });
    let s = state;
    s.facilities.stove = 1;
    s.inventory.raw = 1; s.inventory.book = 1;
    delete s.inventory.firewood; delete s.inventory.wood;
    s = step(s, [{ type: 'act', actor: 'bron', action: 'cook' }]).state;
    assert.ok(s.causality.entries.some((e) => e.verb === 'burn_book'), '应记 burn_book');
    assert.equal(s.causality.shadowTouched?.katya, 1, '白简的暗面被烧简翻动');
  });

  test('非扳机动词不累加（同一局里 feed 不动白简的账）', () => {
    const { state } = newRun({ seed: 7, roster: ['katya', 'marta', 'bron'] });
    let s = state;
    s.inventory.canned = 3;
    s = step(s, [{ type: 'act', actor: 'marta', action: 'eat', target: 'canned' }]).state;
    assert.equal(s.causality.shadowTouched?.katya ?? 0, 0, 'feed 不是白简的扳机');
  });

  test('扳机随见证累加：柜里有粮却饿着人，江鳅的账翻页', () => {
    const { state } = newRun({ seed: 21, roster: ['danilo', 'katya', 'bron'] });
    let s = state;
    s.inventory.canned = 3; // 柜里有粮
    s = skipDayAtHome(s);
    s = skipDayAtHome(s);
    const denies = s.causality.entries.filter((e) => e.verb === 'deny_food');
    assert.ok(denies.length >= 1, '有粮不喂应记 deny_food');
    assert.ok((s.causality.shadowTouched?.danilo ?? 0) >= 1, '江鳅的暗面被克扣翻动');
  });

  test('fold 镜像：shadowTouched 随 CAUSAL 事件重建', () => {
    const { state, events } = newRun({ seed: 7, roster: ['katya', 'marta', 'bron'] });
    state.facilities.stove = 1;
    state.inventory.raw = 1; state.inventory.book = 1;
    delete state.inventory.firewood; delete state.inventory.wood;
    const r = step(state, [{ type: 'act', actor: 'bron', action: 'cook' }]);
    const rebuilt = fold([...events, ...r.events]);
    assert.deepEqual(rebuilt.causality.shadowTouched, r.state.causality.shadowTouched);
    assert.equal(rebuilt.causality.shadowTouched.katya, 1);
  });
});

describe('内容包校验：缺暗面拒载', () => {
  test('删掉一人的 shadow → loadPack 报错', async () => {
    const { mkdtempSync, writeFileSync, readFileSync, cpSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'pack-shadow-'));
    cpSync(PACK.manifest ? join(process.cwd(), 'content/base') : '', dir, { recursive: true });
    const chars = JSON.parse(readFileSync(join(dir, 'characters.json'), 'utf8'));
    delete chars.characters[0].persona.shadow;
    writeFileSync(join(dir, 'characters.json'), JSON.stringify(chars));
    const { loadPack } = await import('../../packages/core/src/content.js');
    assert.throws(() => loadPack(dir), /shadow/);
  });
});
