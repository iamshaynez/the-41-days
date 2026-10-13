// 高亮标注协议（叙事双轴-v0.1 §6）：解析、registry 校验、内容包全量标记合法（标不出即不存在）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PACK } from '../helpers.js';
import { parseMarkers, stripMarkers, validateTextMarkers } from '../../packages/core/index.js';

describe('标注协议 · 解析', () => {
  test('七类标记可解析、可剥净', () => {
    const t = '[[人|关羽]]围[[地|樊城]]，手里有[[物|#039]]，这是[[事|大胜]]，他在[[决|交割]]前埋了[[伏|断弦的琴]]，记住[[要|白天别出门]]。';
    const ms = parseMarkers(t);
    assert.equal(ms.length, 7);
    assert.deepEqual(ms.map((m) => m.type), ['人', '地', '物', '事', '决', '伏', '要']);
    const plain = stripMarkers(t);
    assert.ok(!plain.includes('[['));
    assert.ok(plain.includes('关羽') && plain.includes('#039') && plain.includes('白天别出门'));
  });

  test('registry 拒绝表外名词；「要」是排版指令，任意文本免查', () => {
    assert.equal(validateTextMarkers('[[人|赵子龙]]单骑救主', PACK).length, 1, '表外人名即非法');
    assert.equal(validateTextMarkers('[[人|关羽]]在此', PACK).length, 0);
    assert.equal(validateTextMarkers('[[地|不存在的城]]', PACK).length, 1);
    assert.equal(validateTextMarkers('[[要|随便什么话都行]]', PACK).length, 0, '要点朱批不走 registry');
  });
});

describe('标注协议 · 内容包全量合法', () => {
  const texts = [];
  const walk = (node, where) => {
    if (typeof node === 'string') texts.push([where, node]);
    else if (Array.isArray(node)) node.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, `${where}.${k}`);
  };
  walk(PACK.prelude, 'prelude');
  walk(PACK.mainline, 'mainline');
  walk(PACK.historia, 'historia');
  walk(PACK.narrations, 'narrations');
  walk(PACK.events, 'events');
  walk(PACK.docs, 'docs');
  walk(PACK.seals, 'seals');
  walk(PACK.sidestories, 'sidestories');
  walk(PACK.items, 'items');

  test('全部手作文本的标记都在 registry 内', () => {
    const bad = [];
    for (const [where, t] of texts) {
      for (const m of validateTextMarkers(t, PACK)) bad.push(`${where}: [[${m.type}|${m.name}]]`);
    }
    assert.deepEqual(bad, [], '非法标记: ' + bad.join('、'));
  });

  test('闲笔人物池的名字都在人物表内（含正史名将）', () => {
    const reg = new Set(PACK.historia.persons);
    for (const f of PACK.historia.figures) assert.ok(reg.has(f.name), `闲笔 ${f.id} 的名字 ${f.name} 未入 persons 表`);
  });
});
