// 落幕 · 案语（内容包 0.32.0）：每个分支结局都要有足够厚重的史源纵深——
// 三国志与三国演义的前因后果，扣回正典而非自说自话。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, PACK } from '../helpers.js';
import { buildEnding } from '../../packages/core/index.js';

const ENDINGS = ['ceasefire', 'maicheng', 'pyrrhic', 'alt_both', 'lighthouse', 'join_table', 'hostage', 'wiped', 'contract_end'];

function endedAs(type) {
  const { state } = newRun({ seed: 31 });
  state.war.ended = true;
  state.war.endingType = type;
  state.over = true;
  return state;
}

describe('落幕 · 案语（内容契约）', () => {
  test('九结局每结局至少三条案语，条条有史源、引文与案', () => {
    const notes = PACK.mainline.endingNotes;
    assert.ok(notes, 'endingNotes 在包里');
    for (const t of ENDINGS) {
      const list = notes[t] || [];
      assert.ok(list.length >= 3, `${t} 案语只有 ${list.length} 条——前因后果要成对成套`);
      for (const n of list) {
        assert.ok(/《.+》/.test(n.src || ''), `${t} 案语缺史源：${JSON.stringify(n).slice(0, 30)}`);
        assert.ok(n.text && n.text.length >= 10 && n.text.length <= 96, `${t} 案语引文 10~96 字：${n.text?.slice(0, 16)}`);
        assert.ok(n.tie && n.tie.length >= 10 && n.tie.length <= 96, `${t} 案语之案 10~96 字：${n.tie?.slice(0, 16)}`);
      }
    }
  });

  test('史源成色：每结局至少两处不同史源；全卷志书与演义都成体系', () => {
    const notes = PACK.mainline.endingNotes;
    let zhiji = 0, yanyi = 0;
    for (const t of ENDINGS) {
      const srcs = new Set((notes[t] || []).map((n) => n.src));
      assert.ok(srcs.size >= 2, `${t} 的案语史源少于两种——单源不成案`);
      assert.ok((notes[t] || []).some((n) => /三国志/.test(n.src)), `${t} 至少一处《三国志》`);
    }
    for (const list of Object.values(notes)) for (const n of list) {
      if (/三国志/.test(n.src)) zhiji += 1;
      if (/三国演义/.test(n.src)) yanyi += 1;
    }
    assert.ok(zhiji >= 12, `《三国志》案语 ${zhiji} 条——志书是案语的骨（≥12）`);
    assert.ok(yanyi >= 6, `《三国演义》回目案语 ${yanyi} 条——演义是案语的肉（≥6）`);
  });

  test('前因后果成对：每结局既有「之前为何」也有「之后如何」', () => {
    // 机械化可查的代理指标：案语之案里出现时序词（「之前/起/远因/从此/之后/转年/后来/两年后/正月」）
    for (const t of ENDINGS) {
      const ties = (PACK.mainline.endingNotes[t] || []).map((n) => n.tie).join('；');
      const forward = /之后|从此|此后|转年|转月|后来|两年后|次年|正月|身后/.test(ties);
      assert.ok(forward, `${t} 的案语全在说前因，没有一案说后果`);
    }
  });
});

describe('落幕 · 案语（装配）', () => {
  test('codex.notes 按结局带出，收束行原样不打架', () => {
    for (const t of ['ceasefire', 'maicheng', 'hostage']) {
      const codex = buildEnding(endedAs(t), PACK).storyline.codex;
      assert.equal(codex.notes.length, PACK.mainline.endingNotes[t].length, `${t} 案语全须全尾`);
      assert.ok(codex.lines.length >= 4, `${t} 收束行还在`);
      assert.ok(codex.annals.length >= 6, `${t} 压卷还在`);
    }
  });
});
