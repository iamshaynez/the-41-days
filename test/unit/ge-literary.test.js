// GE 文学性四约束的验证器落地（命运导演 P1.5 / P2b）：
// ① 选项互质（效果签名不得重复——无优势选项的结构保证）
// ② 锚引用（特指战胜泛化：正文/选项至少引用一个具体的人或地点）
// ③ 旗标白名单（LLM 只能从注册过的旗标键里点菜）
// ④ 命运弧 adherence（提案必须长在指派的弧上，弧外旗标无效）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadPack, createRun, beginRun } from '../../packages/core/index.js';
import { validateProposal, proposalToCard } from '../../packages/core/src/ge.js';

const PACK = loadPack();

function stateAt(day = 20) {
  const state = createRun(PACK, { seed: 3, roster: ['anton', 'marta', 'bron'] });
  beginRun(state, PACK, {});
  state.day = day;
  return state;
}

/** 金样本：锚定文简与南市、三选项效果互异、措辞避开禁词 */
const GOLDEN = (day) => ({
  title: '门槛上的半块麦饼',
  theme: PACK.ge.themeWheel[day % PACK.ge.themeWheel.length],
  anchors: [`第${day}天`, '角色:文简', '地点:南市'],
  text: '文简清早去南市口打听粮价，回来时身后跟了个不说话的孩子。他放下半块麦饼，站在门边看你。',
  options: [
    { label: '收下饼，让孩子进门', mood_all: 1, outcomeText: '孩子坐在灶边，很久没说话。' },
    { label: '把饼还回去', mood_char: { name: '文简', n: -1 } },
    { label: '收下饼，问他家里还有谁', items_cost: { canned: 1 } }
  ]
});

describe('验证器：文学性约束', () => {
  test('金样本通过（锚定+互异+禁词干净）', () => {
    const s = stateAt(20);
    const anchors = ['第20天', '角色:文简', '地点:南市', '角色:辛夷', '角色:石大', '天气:雨'];
    const v = validateProposal(PACK, s, GOLDEN(20), { anchors });
    assert.deepEqual(v.reasons || [], [], `不应有拒绝理由：${(v.reasons || []).join('、')}`);
    assert.ok(v.ok);
  });

  test('选项同质被拒：两个选项效果签名相同（无优势选项的结构保证）', () => {
    const s = stateAt(20);
    const p = GOLDEN(20);
    p.options[1] = { label: '把饼分成两半', mood_all: 1 };
    p.options[0] = { label: '收下饼，道声谢', mood_all: 1 };
    const v = validateProposal(PACK, s, p, { anchors: ['第20天', '角色:文简'] });
    assert.ok(!v.ok);
    assert.ok(v.reasons.some((r) => r.includes('同质')), `应拒同质：${v.reasons.join('、')}`);
  });

  test('两个纯无视选项也算同质被拒（至多一个零效果选项）', () => {
    const s = stateAt(20);
    const p = GOLDEN(20);
    p.options = [
      { label: '收下饼，让孩子进门', mood_all: 1 },
      { label: '当没看见' },
      { label: '转身进屋' }
    ];
    const v = validateProposal(PACK, s, p, { anchors: ['第20天', '角色:文简'] });
    assert.ok(!v.ok && v.reasons.some((r) => r.includes('同质')));
  });

  test('锚引用被拒：通篇不提任何具体的人与地（特指胜过泛化）', () => {
    const s = stateAt(20);
    const p = GOLDEN(20);
    p.text = '有人放下一点吃的就走了。门边很安静，像什么都没发生过一样。';
    p.title = '一点心意';
    p.anchors = ['第20天', '天气:雨'];
    for (const o of p.options) o.label = o.label.replace(/文简|孩子|南市/g, '有人');
    const v = validateProposal(PACK, s, p, { anchors: ['第20天', '角色:文简', '地点:南市', '天气:雨'] });
    assert.ok(!v.ok && v.reasons.some((r) => r.includes('锚引用')), `应拒泛化：${v.reasons.join('、')}`);
  });

  test('锚池里没有可引用的人物/地点时跳过锚引用检查', () => {
    const s = stateAt(20);
    const p = GOLDEN(20);
    p.text = '有人放下一点吃的就走了。';
    const v = validateProposal(PACK, s, p, { anchors: ['第20天', '天气:雨'] });
    assert.ok(!v.reasons.some((r) => r.includes('锚引用')), `无可引锚时应跳过：${v.reasons.join('、')}`);
  });
});

describe('验证器：旗标白名单与命运弧', () => {
  const ARC = { id: 'late_paper', tier: 2, at: 'dusk', theme: '失物', flags: ['fate_paper_chased', 'fate_paper_ignored'] };

  const arcProposal = (flag = 'fate_paper_chased') => ({
    title: '一页写着你家名字的纸',
    theme: '失物',
    arc: 'late_paper',
    anchors: ['第36天', '角色:文简'],
    text: '文简在门缝里看见对面当铺的伙计把一页纸收进匣子。那页纸上有你们家的名字。',
    options: [
      { label: '今晚摸黑去取回来', risk: true, flag: { fate_paper_chased: true } },
      { label: '用半袋糙米赎回来', item_cost: { raw: 2 } },
      { label: '由它去', flag: { fate_paper_ignored: true } }
    ]
  });

  test('弧旗标在白名单内：通过；落进 eventFlags 通道', () => {
    const s = stateAt(36);
    const v = validateProposal(PACK, s, arcProposal(), { anchors: ['第36天', '角色:文简'], arc: ARC });
    assert.ok(v.ok, `应通过：${(v.reasons || []).join('、')}`);
    const card = proposalToCard(PACK, s, arcProposal(), { arc: ARC });
    assert.equal(card.at, 'dusk');
    const opt = card.options.find((o) => o.key === 'g0');
    assert.deepEqual(opt.effects.flags, { fate_paper_chased: true });
  });

  test('未注册的旗标键被拒（LLM 只能点菜，不能发明）', () => {
    const s = stateAt(36);
    const p = arcProposal();
    p.options[0].flag = { emperor_pardon: true };
    const v = validateProposal(PACK, s, p, { anchors: ['第36天', '角色:文简'], arc: ARC });
    assert.ok(!v.ok && v.reasons.some((r) => r.includes('旗标')), `应拒未注册旗标：${v.reasons.join('、')}`);
  });

  test('弧外提案冒充弧被拒（adherence）', () => {
    const s = stateAt(36);
    const p = arcProposal();
    p.arc = 'two_children';
    const v = validateProposal(PACK, s, p, { anchors: ['第36天', '角色:文简'], arc: ARC });
    assert.ok(!v.ok && v.reasons.some((r) => r.includes('弧')), `应拒冒名弧：${v.reasons.join('、')}`);
  });

  test('无弧模式下旗标一律被拒（T0 微光卡不许落旗标）', () => {
    const s = stateAt(20);
    const p = GOLDEN(20);
    p.options[0].flag = { fate_children_fed: true };
    const v = validateProposal(PACK, s, p, { anchors: ['第20天', '角色:文简'] });
    assert.ok(!v.ok && v.reasons.some((r) => r.includes('旗标')), `应拒无弧旗标：${v.reasons.join('、')}`);
  });
});
