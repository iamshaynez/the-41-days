// 文风圣经 lint（文风圣经-v0.1 §7）：新叙事文本（prelude/mainline/historia）的禁词零命中。
// 存量文本（narrations/events/sidestories）待批次八校订后再纳入启用范围。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripMarkers } from '../../packages/core/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const PACK_DIR = join(here, '../../content/base');

// 文风圣经 §4.2 禁词（状语与白话腔）；露布体豁免「日渐」不在表内
const BAN = /突然|渐渐地|慢慢地|悄悄地|立刻|马上|终于|已经|正在|十分地|非常地|特别地|居然|竟然|其实|几乎|简直|越来越/;

const texts = [];
const walk = (node, where) => {
  if (typeof node === 'string') texts.push([where, node]);
  else if (Array.isArray(node)) node.forEach((x, i) => walk(x, `${where}[${i}]`));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, `${where}.${k}`);
};
for (const f of ['prelude.json', 'mainline.json', 'historia.json']) {
  walk(JSON.parse(readFileSync(join(PACK_DIR, f), 'utf8')), f);
}

describe('文风圣经 · 新叙事文本', () => {
  test('禁词零命中（免状语律）', () => {
    const hits = [];
    for (const [where, raw] of texts) {
      const t = stripMarkers(raw);
      const m = t.match(BAN);
      if (m) hits.push(`${where}: ${m[0]}`);
    }
    assert.deepEqual(hits, [], '禁词命中: ' + hits.join('、'));
  });

  test('史书体步文句短（fallback ≤ 40 字净文）', () => {
    for (const st of JSON.parse(readFileSync(join(PACK_DIR, 'mainline.json'), 'utf8')).steps) {
      const plain = stripMarkers(st.fallback || '').replace(/[\s，。；、——]/g, '');
      assert.ok(plain.length <= 40, `步 ${st.id} 的 fallback 过长（${plain.length} 字）`);
    }
  });
});
