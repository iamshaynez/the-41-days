// GE 守望档（§3.6）：合上兰台后 C 层隔天至多一张
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGeDirector } from '../../packages/server/ge.js';
import { loadPack, createRun, beginRun } from '../../packages/core/index.js';

const PACK = loadPack();
const proposal = (day) => ({
  title: `半块麦饼·第${day}日`, theme: PACK.ge.themeWheel[day % PACK.ge.themeWheel.length],
  anchors: [`第${day}天`, '天气:clear'],
  text: '对门的老者把半块麦饼放在门槛上，没留话。文简捡起来时饼还是热的，说明他家里今天有火。',
  options: [{ label: '收进来', mood_all: 1 }, { label: '放回去' }]
});

async function dayWithDirector(dir, s) {
  await dir.onTurn('r', s);
  await new Promise((r) => setTimeout(r, 20));
  await dir.onTurn('r', s);
}

describe('GE 守望档', () => {
  test('正常密度：连续两天都能注入；合上兰台后隔天', async () => {
    let s = beginRun(createRun(PACK, { seed: 5, roster: ['anton', 'marta', 'bron'] })).state;
    s.firedOnce = { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 }; // 手作卡已发 7 张（预取与注入同回合，预算要预先开够）
    let dayNow = 1;
    const provider = { call: async () => ({ text: JSON.stringify(proposal(dayNow)) }) };
    const d1 = createGeDirector({ pack: PACK, prompts: { playwright: '锚池 {{anchors}} 主题 {{theme}} {{world}}' }, getProvider: () => provider });
    await dayWithDirector(d1, s);
    assert.ok(s.activeEvent?.generated, '第 1 天注入');
    s.activeEvent = null; s.day = 2; dayNow = 2;
    await dayWithDirector(d1, s);
    assert.ok(s.activeEvent?.generated, '第 2 天照常注入');

    // 合上兰台的世界：隔天至多一张
    dayNow = 1;
    let s2 = beginRun(createRun(PACK, { seed: 6, roster: ['anton', 'marta', 'bron'], echoes: { closureClosed: true } })).state;
    s2.firedOnce = { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 }; // 同样开够预算，隔离守望档
    assert.ok(s2.closureClosed, '守望档状态进局');
    const d2 = createGeDirector({ pack: PACK, prompts: { playwright: '锚池 {{anchors}} 主题 {{theme}} {{world}}' }, getProvider: () => provider });
    await dayWithDirector(d2, s2);
    assert.ok(s2.activeEvent?.generated, '守望档第 1 天注入');
    s2.activeEvent = null; s2.day = 2; dayNow = 2;
    await dayWithDirector(d2, s2);
    assert.ok(!s2.activeEvent?.generated, '守望档隔天不注入');
  });
});
