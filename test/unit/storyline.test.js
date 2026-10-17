// 结局复盘与回忆录（CY-33/EPI-01/N-02）：storyline 提取、直读渲染、事实校验闸。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK, skipDayAtHome } from '../helpers.js';
import { buildStoryline, renderMemoirDirect, memoirLint } from '../../packages/core/src/storyline.js';

/** 打一小局：烧书 + 拒助 + 医治 + 守夜，让因果账厚一点 */
function playedRun(seed = 31) {
  const { state } = newRun({ seed });
  let s = state;
  s.facilities.stove = 1;
  s.doorLevel = 3; // 顶格防御排除袭击随机性，夹具只关心因果
  // 居家自主（0.40.0）：收尾时角色会翻家里没翻的角落——本夹具只要因果账，把家里的角落先翻空
  for (const r of PACK.locMap.home.rooms || []) { s.house.opened[r.id] = true; for (const ct of r.containers || []) s.house.searched[ct.id] = true; }
  // D1：烧书做饭 + 拒助（清空可食物，避免 deny_food 噪声）
  s.inventory = { raw: 1, book: 1 };
  s = step(s, [{ type: 'act', actor: 'bron', action: 'cook' }]).state;
  s.activeEvent = { cardId: 'n_meds' };
  s = step(s, [{ type: 'event_choice', option: 'refuse' }]).state;
  s = skipDayAtHome(s);
  // D2：吃掉昨晚的饭（避免 deny_food 噪声）+ 医治 + 布罗守夜
  ch(s, 'anton').wound = 2;
  s.inventory.bandage = 1;
  s = step(s, [
    { type: 'act', actor: 'marta', action: 'eat', target: 'meal' },
    { type: 'act', actor: 'marta', action: 'treat', target: 'bandage', patient: 'anton' }
  ]).state;
  s = step(s, [{ type: 'advance' }]).state;
  s = step(s, [{ type: 'dusk_assign', scavenger: null, others: { bron: 'guard' } }]).state;
  return s;
}

describe('故事线提取（CY-33）', () => {
  test('节拍按天排序、每句都有出处、拒助/烧书/医治都在', () => {
    const story = buildStoryline(playedRun(), PACK);
    assert.ok(story.beats.length >= 3, `至少三拍（实际 ${story.beats.length}）`);
    const texts = story.beats.map((b) => b.text).join('\n');
    assert.match(texts, /炉/); // 烧书
    assert.match(texts, /不行/); // 拒助
    assert.match(texts, /换了药/); // 医治
    const days = story.beats.map((b) => b.day);
    assert.deepEqual([...days].sort((a, b) => a - b), days, '节拍按天升序');
    for (const b of story.beats) assert.ok(b.day <= story.days, 'N-02：不得超出本局');
  });

  test('人的账：辛夷无法释怀拒助，文简刺痛烧简，石大有守夜账', () => {
    let s = playedRun();
    // 补夜前把随机晨抽池关闸（夹具只关心因果——门板顶格排除袭击同款思路）：
    // 内容包加新卡会挪动种子下的晨抽流，别让「收留逃兵」这类临时卡挤掉账目断言
    for (const c of PACK.cards) if (c.kind === 'knock' || c.kind === 'internal') s.eventCooldowns[c.id] = 999;
    // 再补两夜守卫，凑过"守夜账"的显形阈值（3 夜）
    for (let i = 0; i < 2 && !s.over; i++) {
      if (s.activeEvent) s = step(s, [{ type: 'event_choice', option: PACK.cardMap[s.activeEvent.cardId]?.options?.[0]?.key || 'refuse' }]).state;
      s = step(s, [{ type: 'advance' }]).state;
      if (s.phase === 'dusk') s = step(s, [{ type: 'dusk_assign', scavenger: null, others: { bron: 'guard' } }]).state;
    }
    const story = buildStoryline(s, PACK);
    const martaTop = story.chains.marta?.[0];
    assert.ok(martaTop, '玛尔塔有账');
    assert.match(martaTop.text, /不行/);
    assert.equal(martaTop.read, '无法释怀'); // refuse_help -1.5×1.5(help)×2(敏感)×1.5w ≈ -6.75
    assert.ok(story.chains.anton?.some((e) => /炉/.test(e.text)), '安东的账里有那本书');
    const guardLine = story.charLines.find((l) => l.includes('守了'));
    assert.ok(guardLine?.includes('石大'), '石大的守夜应被看见');
  });

  test('全灭局也有完整复盘（群体墓志铭的素材）', () => {
    const { state } = newRun({ seed: 33 });
    let s = state;
    for (const c of s.chars) { c.wound = 3; c.hunger = 0; }
    // 强行推进到全员死亡
    for (let i = 0; i < 12 && !s.over; i++) s = skipDayAtHome(s);
    assert.ok(s.over, '应已终局');
    const story = s.ending.storyline;
    assert.ok(story, 'ending 携带 storyline');
    assert.equal(story.epilogues.filter((e) => e.direction === 'fallen').length, 3, '全员 fallen');
    assert.ok(story.beats.some((b) => b.verb === 'witness_death'), '死亡在故事线里');
  });
});

describe('直读回忆录（LLM 离线演出层）', () => {
  test('四段俱全：故事线/人的账/后日谈/卷尾', () => {
    const story = buildStoryline(playedRun(), PACK);
    const text = renderMemoirDirect(story, PACK);
    for (const sec of ['故事线', '人的账', '后日谈', '卷尾']) assert.ok(text.includes(sec), `缺 ${sec}`);
    assert.match(text, /橘里九号/);
    assert.match(text, /辛夷/);
  });

  test('连日挨饿塌缩成一拍，不刷版', () => {
    const { state } = newRun({ seed: 37 });
    let s = state;
    s.doorLevel = 3;
    s.inventory.canned = 9; // 一直有粮，一直不吃
    for (let i = 0; i < 6; i++) s = skipDayAtHome(s);
    const story = buildStoryline(s, PACK);
    const denies = story.beats.filter((b) => b.verb === 'deny_food');
    assert.ok(denies.length <= 2 && denies.every((b) => b.ranged), `应塌缩为少量 range 拍（实际 ${denies.length} 拍）`);
    assert.match(denies[0].text, /一直在饿/);
    const text = renderMemoirDirect(story, PACK);
    assert.doesNotMatch(text, /第 \d+ 次了/g, '定稿里没有刷屏计数');
  });
});

describe('N-02 事实校验闸（memoirLint）', () => {
  const story = buildStoryline(playedRun(), PACK);
  test('合格的回忆录通过', () => {
    const good = `第 1 天，文简、辛夷、石大住进了橘里九号。炉火第一次舔着锅底的时候，文简没有说话。
第 2 天，你对门口的人说了"不行"。辛夷夜里起来了，没人看见她去了哪里。石大把门查了三遍。
后来，文简的生日账上少了一个名字。辛夷记得那一天，石大也记得。战争结束的时候，他们都活着。`;
    assert.ok(memoirLint(good, story, PACK));
  });
  test('幻觉天数被拒', () => {
    const bad = `第 1 天，文简、辛夷到了。第 87 天，他们看见了海。辛夷哭了。这是一段足够长的文字，用来通过长度检查，继续继续继续继续继续。`;
    assert.equal(memoirLint(bad, story, PACK), false);
  });
  test('跑题（无队员名）与过短被拒', () => {
    assert.equal(memoirLint('战争结束了。' + '很长'.repeat(60), story, PACK), false);
    assert.equal(memoirLint('太短', story, PACK), false);
    assert.equal(memoirLint(null, story, PACK), false);
  });
});
