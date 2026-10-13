// 提示词契约（修复⑥ + AGENTS §6 提示词变更须带评测断言）：
// 裁判提示词必须写明"主语继承"与"点名不换人"——实测 LLM 局中玩家说
// "让辛夷收琴；然后教阿禾认字"被执行成阿禾收琴、阿禾教阿禾（主语错派）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const referee = readFileSync(join(here, '../../content/base/prompts/referee.md'), 'utf8');

describe('裁判提示词 · 主语解析铁律', () => {
  test('写了"后步继承前步主语"', () => {
    assert.match(referee, /继承/, '须有主语继承规则');
  });
  test('写了"玩家点名的角色不得被换掉"', () => {
    assert.match(referee, /不得因为你觉得别人更合适而擅自换成别人/, '须有点名不换人规则');
  });
  test('点名角色不可用时应追问而非静默换人', () => {
    assert.match(referee, /clarify/, '追问出口存在');
    const seg = referee.slice(Math.max(0, referee.indexOf('继承') - 200), referee.indexOf('继承') + 400);
    assert.match(seg, /clarify|追问/, '继承规则附近要落到 clarify 出口');
  });
});
