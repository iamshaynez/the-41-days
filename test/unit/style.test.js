// 文风圣经 lint（文风圣经-v0.1 §7）：叙事文本的禁词零命中。
// 启用顺序：prelude/mainline/historia（随批次上线即启用）→
// narrations/events/characters（文案丰满批次一改写后启用，2026-10）→
// sidestories（批次八校订后启用）；autonomy（居家与四问，0.40.0 起）。白名单：露布体卡片可豁免「日渐／已经」。
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
for (const f of ['prelude.json', 'mainline.json', 'historia.json', 'narrations.json', 'events.json', 'characters.json', 'docs.json', 'seals.json', 'sidestories.json', 'autonomy.json']) {
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

  test('史卷步文白话丰满（fallback ≤ 140 字净文，体例放开拍板 2026-10）', () => {
    for (const st of JSON.parse(readFileSync(join(PACK_DIR, 'mainline.json'), 'utf8')).steps) {
      const plain = stripMarkers(st.fallback || '').replace(/[\s，。；、——]/g, '');
      assert.ok(plain.length <= 140, `步 ${st.id} 的 fallback 过长（${plain.length} 字）`);
      assert.ok(plain.length >= 20, `步 ${st.id} 的 fallback 过短（${plain.length} 字）——说清楚`);
    }
  });
});
