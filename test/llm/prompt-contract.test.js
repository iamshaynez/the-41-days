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
  test('求生自动原则：角色自己活，玩家管方向与底线（不把具体求生动作翻成意图）', () => {
    assert.match(referee, /求生是角色的本能/, '原则存在');
    assert.match(referee, /不必把「挖野菜」这类具体动作翻成意图/, '关键词咒语时代结束');
  });

  test('托管措辞有契约（派人/让人不猜名）：act 缺 actor 归内核、dusk 自选人、白天出门活收卷', () => {
    assert.match(referee, /托管措辞/, '托管契约存在');
    assert.match(referee, /不写 actor 字段/, 'act 托管 = 不写 actor');
    assert.match(referee, /绝不写"人""谁"这类不是角色 id 的词/, '泛指词禁令（「这个人不在」死胡同的源头）');
    assert.match(referee, /夜里的活 → auto_day 收卷/, '白天说夜间任务的出路');
  });
});

// —— 自由输入裁决策略（用户实测反馈：条件不绝对满足就追问+清空输入框，体验差）——
describe('裁判提示词 · 默认裁决与愿望拒绝', () => {
  test('写了"默认裁决，不追问"的总则', () => {
    assert.match(referee, /默认裁决，不追问/, '裁决总则存在');
    assert.match(referee, /宁可执行最合理的解释，也不要把问题抛回给玩家/, '裁决倾向明确');
  });
  test('追问只留给两种高危情形', () => {
    const seg = referee.slice(referee.indexOf('clarify 只留给'), referee.indexOf('clarify 只留给') + 120);
    assert.match(seg, /出人命|不可逆/, '情形一：人命/不可逆');
    assert.match(seg, /无法辨认/, '情形二：完全无法辨认');
  });
  test('语境补齐规则具体（懂医给药/厨子做饭/点名优先）', () => {
    assert.match(referee, /懂医的给药/, '配药规则');
    assert.match(referee, /厨子做饭/, '炊事规则');
    assert.match(referee, /点名者优先/, '点名优先');
  });
  test('离谱愿望走趣味拒绝（echo），且带金样本与人命关天', () => {
    assert.match(referee, /有趣的拒绝/, '拒绝轨存在');
    assert.match(referee, /人命关天/, '点题人命关天');
    assert.ok(/变身超人|超人/.test(referee) && /手枪/.test(referee), '金样本覆盖变身与手枪');
  });
});
