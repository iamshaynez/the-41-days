// 故事线 v2：封印注入 / 文简寻女链 / 白翎渡口窗口 / 还师 / 出江陵
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newRun, step, ch, PACK, skipDayAtHome } from '../helpers.js';
import { Ctx, drawMorningEvents, findDoc, docAvailable } from '../../packages/core/index.js';

const docOk = (s, id) => docAvailable(s, PACK, id);

describe('封印注入协议（GDD §11.4）', () => {
  test('条件不满足时真相不存在，满足即解锁且只一次', () => {
    const { state } = newRun({ seed: 51 });
    let s = state;
    assert.deepEqual(s.seals, []);
    s = step(s, [{ type: 'meta', query: '状态' }]).state;
    assert.equal(s.seals.length, 0, '开局没有任何显形真相');
    // 拿到 #007（双头征用令）→ 同纸真相解锁
    s.docsSeen.push('#007');
    const r = step(s, [{ type: 'meta', query: '状态' }]);
    s = r.state;
    assert.ok(s.seals.includes('seal_same_paper'));
    assert.ok(r.facts.some((f) => f.k === 'seal_unlock' && f.id === 'seal_same_paper'));
  });

  test('双条件封印（公证人 M.）：文档 + 知晓度缺一不可', () => {
    const { state } = newRun({ seed: 52 });
    let s = state;
    s.docsSeen.push('#059');
    s = step(s, [{ type: 'meta', query: '状态' }]).state;
    assert.ok(!s.seals.includes('seal_notary_m'), '只有文档不够');
    s.knowledge = 12;
    s = step(s, [{ type: 'meta', query: '状态' }]).state;
    assert.ok(s.seals.includes('seal_notary_m'), '文档+知晓度齐了才显形');
  });
});

describe('文简寻女链（人物圣经-v0.2 §4.1）', () => {
  test('信有门禁：答应之前死信库里没有它；答应之后能找到', () => {
    const { state } = newRun({ seed: 53, roster: ['anton', 'marta', 'bron'] });
    let s = state;
    assert.equal(docOk(s, '#062'), false, '未答应前信不存在');
    s.day = 8;
    s.activeEvent = { cardId: 'i_anton_quest' };
    s = step(s, [{ type: 'event_choice', option: 'accept' }]).state;
    assert.ok(s.eventFlags.anton_quest);
    assert.equal(docOk(s, '#062'), true, '答应之后信进入世界');
  });

  test('全链：信 → 抉择 → 三天后回来（重逢/噩耗二态）', () => {
    for (const seed of [55, 56, 57, 58]) {
      const { state } = newRun({ seed, roster: ['anton', 'marta', 'bron'] });
      let s = state;
      s.day = 8;
      s.activeEvent = { cardId: 'i_anton_quest' };
      s = step(s, [{ type: 'event_choice', option: 'accept' }]).state;
      // 找到信（走内核 findDoc 通道）
      const ctx = new Ctx(s, PACK, [], []);
      findDoc(ctx, '#062', null);
      assert.ok(s.eventFlags.anton_letter, '信落旗');
      s.activeEvent = { cardId: 'i_anton_choice' };
      s = step(s, [{ type: 'event_choice', option: 'truth' }]).state;
      assert.ok(s.eventFlags.anton_truth);
      assert.equal(s.eventFlags.anton_return_day, s.day + 3);
      // 三天后他回来
      s.day = s.eventFlags.anton_return_day;
      s.activeEvent = { cardId: 'i_anton_end' };
      s = step(s, [{ type: 'event_choice', option: 'face' }]).state;
      assert.ok(s.eventFlags.anton_reunited || s.eventFlags.anton_lost, `重逢或噩耗必居其一（seed ${seed}）`);
    }
  });

  test('棉被选项：不给他看信，就没有那条路', () => {
    const { state } = newRun({ seed: 59, roster: ['anton', 'marta', 'bron'] });
    let s = state;
    s.day = 8;
    s.eventFlags.anton_letter = true;
    s.activeEvent = { cardId: 'i_anton_choice' };
    s = step(s, [{ type: 'event_choice', option: 'hope' }]).state;
    assert.ok(s.eventFlags.anton_hope);
    assert.ok(!s.eventFlags.anton_return_day, '没有返程日，没有那场痛');
  });
});

describe('白翎线（正典圣经-v0.2 §4）', () => {
  test('素徽夜访水门渡旧垒：听辨触发，鼓谱需先到手', () => {
    const { state } = newRun({ seed: 61, roster: ['zofia', 'marta', 'bron'] });
    let s = state;
    s.knownLocs.push('frontline');
    s = step(s, [{ type: 'advance' }]).state;
    s = step(s, [{ type: 'dusk_assign', scavenger: 'zofia', location: 'frontline', gear: [], others: {} }]).state;
    assert.equal(s.activeEvent?.cardId, 's_rhythm_hear', '素徽首访渡口必触发听辨');
    s = step(s, [{ type: 'event_choice', option: 'note' }]).state;
    assert.ok(s.eventFlags.crossing_heard);
  });

  test('停火窗口：鼓谱送出后，渡口一夜没有箭声', () => {
    const { state } = newRun({ seed: 62, roster: ['zofia', 'marta', 'bron'] });
    let s = state;
    s.eventFlags.crossing_heard = true;
    s.eventFlags.crossing_hushed_until = s.day + 1;
    s.knownLocs.push('frontline');
    s = step(s, [{ type: 'advance' }]).state;
    const r = step(s, [{ type: 'dusk_assign', scavenger: 'zofia', location: 'frontline', gear: [], others: {} }]);
    s = r.state;
    assert.ok(r.facts.some((f) => f.k === 'crossing_hushed'), '停火窗口有演出');
    assert.ok(!s.activeEvent, '窗口内没有脚本对峙——没有枪声就是演出');
  });
  test('白翎三选择：对峙卡（杀/绕/退）在听辨后出现', () => {
    // 杀：强攻有检定，落旗与心情代价
    const { state } = newRun({ seed: 85, roster: ['zofia', 'marta', 'bron'] });
    let s = state;
    s.eventFlags.crossing_heard = true;
    s.knownLocs.push('frontline');
    s = step(s, [{ type: 'advance' }]).state;
    s = step(s, [{ type: 'dusk_assign', scavenger: 'zofia', location: 'frontline', gear: [], others: {} }]).state;
    // 首访先听辨（入口卡）；选完"记下节奏"，夜访链续火即上对峙
    assert.equal(s.activeEvent?.cardId, 's_rhythm_hear');
    s = step(s, [{ type: 'event_choice', option: 'note' }]).state;
    assert.equal(s.activeEvent?.cardId, 's_rhythm_face', '听辨后，箭楼下的对峙');
    const keys = s.activeEvent ? PACK.cardMap[s.activeEvent.cardId].options.map((o) => o.key) : [];
    assert.deepEqual(keys, ['fight', 'detour', 'leave'], '杀/绕/退三选择');
    s = step(s, [{ type: 'event_choice', option: 'detour' }]).state;
    assert.ok(s.eventFlags.crossing_detour, '绕行落旗');
  });

});

describe('还师与出江陵（GDD-v0.2 §12.3/§12.4）', () => {
  const stubCtx = (s, pickId) => ({
    s, pack: PACK,
    rng: { chance: () => true, weighted: (arr) => arr.find((x) => x.c?.id === pickId) || arr[arr.length - 1] },
    emit() {}, fact() {}
  });

  test('还师门槛：铁证×3 + 知晓度 12 + 逄灶 + 烽鼓具，缺一不来', () => {
    const { state } = newRun({ seed: 63, roster: ['alexey', 'marta', 'bron'] });
    const s = state;
    s.day = 50; s.war.endDay = 99;
    s.knowledge = 12; s.docsSeen = ['#039', '#045', '#055'];
    s.facilities.radio = 0;
    drawMorningEvents(stubCtx(s, 't_lighthouse'));
    assert.ok(s.activeEvent?.cardId !== 't_lighthouse', '没有烽鼓具就没有还师');
    s.activeEvent = null; // 清掉上一轮（冷却同上）
    s.eventCooldowns = {};
    s.facilities.radio = 1;
    drawMorningEvents(stubCtx(s, 't_lighthouse'));
    assert.equal(s.activeEvent?.cardId, 't_lighthouse', '条件齐了还师上门');
  });

  test('启动还师后第 3 天吴船退（lighthouse 结局）', () => {
    const { state } = newRun({ seed: 64, roster: ['alexey', 'marta', 'bron'] });
    let s = state;
    s.day = 38; s.war.endDay = 99; s.knowledge = 12; s.docsSeen = ['#039', '#045', '#055']; s.facilities.radio = 1;
    // v0.2：交割日固定 D45，《还师》须 D40 前送出（正典圣经-v0.2 §8.3）
    s.activeEvent = { cardId: 't_lighthouse' };
    const d0 = s.day;
    s = step(s, [{ type: 'event_choice', option: 'launch' }]).state;
    assert.equal(s.eventFlags.lighthouse_day, d0 + 3);
    for (let i = 0; i < 4 && !s.over; i++) s = skipDayAtHome(s);
    assert.ok(s.over, '局已终');
    assert.equal(s.ending.type, 'lighthouse', '真相跑赢了交割');
    assert.equal(s.ending.storyline.title, '还师');
  });

  test('出江陵：接受 → 次日破晓解缆；拒绝 → 鲁舟不再来', () => {
    const { state } = newRun({ seed: 65, roster: ['anton', 'marta', 'bron'] });
    let s = state;
    s.day = 25; s.docsSeen = ['#033'];
    s.activeEvent = { cardId: 't_table_offer' };
    s = step(s, [{ type: 'event_choice', option: 'accept' }]).state;
    assert.ok(s.eventFlags.join_table);
    // 夹具隔离其他系统：粮弹充足、门禁森严、冬季不来
    s.inventory.canned = 80; s.inventory.bandage = 30; s.doorLevel = 3;
    s.winterStart = 999; s.winterEnd = 999;
    for (let i = 0; i < 5 && !s.over; i++) {
      const acts = s.chars.filter((c) => c.alive && c.hunger <= 2).map((c) => ({ type: 'act', actor: c.id, action: 'eat', target: 'canned' }));
      const wound = s.chars.find((c) => c.alive && c.wound >= 1);
      if (wound) acts.push({ type: 'act', actor: 'marta', action: 'treat', target: 'bandage', patient: wound.id });
      acts.push({ type: 'act', actor: 'anton', action: 'guard' });
      s = skipDayAtHome(s, acts);
    }
    assert.ok(s.over);
    assert.equal(s.ending.type, 'join_table');
    assert.ok(s.day <= 27, `次日破晓即终局（实际第 ${s.day} 天）——你活着离开了江陵，江陵没有`);

    const r2 = newRun({ seed: 66, roster: ['anton', 'marta', 'bron'] });
    let s2 = r2.state;
    s2.day = 25; s2.docsSeen = ['#033'];
    s2.franko = { merchant: 'franko', stock: [] };
    s2.activeEvent = { cardId: 't_table_offer' };
    s2 = step(s2, [{ type: 'event_choice', option: 'refuse' }]).state;
    assert.equal(s2.franko, null);
    assert.equal(s2.frankoNextDay, 9999, '渠道断绝是真实代价');
  });
});

describe('或然结局（正典圣经-v0.2 §8 / 内核 W-04：满足即触发，无骰）', () => {
  const feedUp = (s) => { s.inventory.canned = 80; s.inventory.bandage = 30; s.doorLevel = 3; s.winterStart = 999; s.winterEnd = 999; };

  test('B《惨胜》：火线证据+里社渠道+D30 前注入；交付 → 交割推迟六日，结局惨胜+野史页', () => {
    const { state } = newRun({ seed: 71, roster: ['anton', 'marta', 'bron'] });
    let s = state;
    feedUp(s);
    s.day = 19; s.docsSeen = ['#058', '#063']; s.reputation.church = 1; s.eventFlags.fire_witness = true;
    s = skipDayAtHome(s); // D20 破晓：注入
    assert.equal(s.activeEvent?.cardId, 'alt_jiangling', '火线卡应在 D30 前注入');
    s = step(s, [{ type: 'event_choice', option: 'deliver' }]).state;
    assert.ok(s.eventFlags.alt_jiangling);
    s = skipDayAtHome(s); // D21 破晓：交割不再推迟（v0.3 铰链在 D41 一刀定）
    assert.equal(s.war.endDay, 41, '交割日不动（41）');
    s.dissolve = 0; // 军心未散：机关杠杆在 D41 生效
    s.day = 40;
    s = skipDayAtHome(s); // D41：临沮日，铰链分岔
    assert.ok(s.over, '局已终');
    assert.equal(s.ending.type, 'pyrrhic');
    assert.equal(s.ending.storyline.title, '惨胜');
    assert.match(s.ending.storyline.annals[0]?.text || '', /吕蒙弃城北渡/);
    assert.match(s.ending.storyline.annals[0]?.note || '', /军心留住了/);
  });

  test('B 门槛：缺 #063 不注入；D31 起不再注入', () => {
    const r1 = newRun({ seed: 72, roster: ['anton', 'marta', 'bron'] });
    let s = r1.state;
    feedUp(s);
    s.day = 19; s.docsSeen = ['#058']; s.reputation.church = 1;
    s = skipDayAtHome(s);
    assert.notEqual(s.activeEvent?.cardId, 'alt_jiangling', '缺手令残牍不得注入');

    const r2 = newRun({ seed: 73, roster: ['anton', 'marta', 'bron'] });
    let s2 = r2.state;
    feedUp(s2);
    s2.day = 30; s2.docsSeen = ['#058', '#063']; s2.reputation.church = 1; s2.eventFlags.fire_witness = true;
    s2 = skipDayAtHome(s2); // D31 破晓
    assert.notEqual(s2.activeEvent?.cardId, 'alt_jiangling', 'D31 起交付窗口已关');

    // 濠鼠活证（城濠水窦上线后的正典前置）：文档与渠道齐了，没人证也不注入
    const r3 = newRun({ seed: 731, roster: ['anton', 'marta', 'bron'] });
    let s3 = r3.state;
    feedUp(s3);
    s3.day = 19; s3.docsSeen = ['#058', '#063']; s3.reputation.church = 1; // 无 fire_witness
    s3 = skipDayAtHome(s3);
    assert.notEqual(s3.activeEvent?.cardId, 'alt_jiangling', '缺濠鼠活证不得注入');
  });

  test('A《麦城得脱》完整夜访链：交割前夜注入 → 黄昏指派素徽上北津台 → 三段链击鼓 → 结局 maicheng', () => {
    let flagged = 0;
    for (let seed = 74; seed <= 81; seed++) {
      const { state } = newRun({ seed, roster: ['zofia', 'alexey', 'marta'] });
      let s = state;
      feedUp(s);
      s.eventFlags.zofia_brother = true; s.knowledge = 8;
      assert.ok(s.knownLocs.includes('beacon'), '逄灶在队即识北津台');
      s.day = s.war.endDay - 2;
      s = skipDayAtHome(s); // 交割前夜之晨
      assert.equal(s.activeEvent?.cardId, 'alt_maicheng_drum', `交割前夜应注入（seed ${seed}）`);
      s = step(s, [{ type: 'event_choice', option: 'go' }]).state;
      assert.ok(s.eventFlags.alt_maicheng_attempt, '决定上台');
      // 黄昏：素徽上北津台
      s = step(s, [{ type: 'advance' }]).state;
      s = step(s, [{ type: 'dusk_assign', scavenger: 'zofia', location: 'beacon', gear: [], others: {} }]).state;
      assert.equal(s.activeEvent?.cardId, 's_beacon_1', '到台先撞台基');
      s = step(s, [{ type: 'event_choice', option: 'fix' }]).state;
      assert.equal(s.activeEvent?.cardId, 's_beacon_2', '续火：举火');
      s = step(s, [{ type: 'event_choice', option: 'fire' }]).state;
      assert.equal(s.activeEvent?.cardId, 's_beacon_3', '续火：击鼓（素徽在场）');
      s = step(s, [{ type: 'event_choice', option: 'drum' }]).state;
      const has = !!s.eventFlags.alt_maicheng;
      s = step(s, [{ type: 'night', action: 'retreat' }]).state;
      if (!s.over) { s = step(s, [{ type: 'advance' }]).state; }
      assert.ok(s.over, '交割日照常到来');
      if (has) {
        flagged++;
        assert.equal(s.ending.type, 'maicheng', '鼓响了：交割照来、麦城得脱');
        assert.equal(s.ending.storyline.title, '麦城得脱');
        assert.match(s.ending.storyline.annals[0]?.text || '', /走房陵/);
      } else {
        assert.equal(s.ending.type, 'ceasefire', '鼓没响则史实结局');
      }
    }
    assert.ok(flagged >= 1, `8 个种子里至少一次击鼓成功（实际 ${flagged}）`);
  });

  test('A 链门槛：上台的不是素徽 → 鼓认人，链断在第三拍', () => {
    const { state } = newRun({ seed: 84, roster: ['bron', 'alexey', 'marta'] });
    let s = state;
    feedUp(s);
    s.eventFlags.zofia_brother = true; s.knowledge = 8;
    s.eventFlags.alt_maicheng_attempt = true;
    s.day = s.war.endDay - 1;
    s = step(s, [{ type: 'advance' }]).state;
    s = step(s, [{ type: 'dusk_assign', scavenger: 'bron', location: 'beacon', gear: [], others: {} }]).state;
    assert.equal(s.activeEvent?.cardId, 's_beacon_1');
    s = step(s, [{ type: 'event_choice', option: 'fix' }]).state;
    s = step(s, [{ type: 'event_choice', option: 'fire' }]).state;
    assert.equal(s.activeEvent?.cardId, 's_beacon_3_fail', '石大上台：鼓认人');
    assert.ok(!s.eventFlags.alt_maicheng);
  });

  test('A 门槛：素徽线未揭示则交割前夜无卡', () => {
    const { state } = newRun({ seed: 82, roster: ['zofia', 'alexey', 'marta'] });
    let s = state;
    feedUp(s); s.knowledge = 8; // 无 zofia_brother
    s.day = s.war.endDay - 2;
    s = skipDayAtHome(s);
    assert.notEqual(s.activeEvent?.cardId, 'alt_maicheng_drum');
  });

  test('叠加《另一种三国》：两旗并立 → 最稀有的一页（此页无纪事）', () => {
    const { state } = newRun({ seed: 83, roster: ['zofia', 'alexey', 'marta'] });
    let s = state;
    feedUp(s);
    s.eventFlags.alt_jiangling = true; s.eventFlags.alt_maicheng = true;
    s.dissolve = 0; // 军心未散 + 双杠杆并立
    s.day = 40;
    s = skipDayAtHome(s); // D41 临沮日：两杆杠杆同时压住那把刀
    assert.ok(s.over);
    assert.equal(s.ending.type, 'alt_both');
    assert.equal(s.ending.storyline.title, '另一种三国');
    assert.match(s.ending.storyline.annals[0]?.text || '', /门未竟开/);
    assert.match(s.ending.storyline.annals[0]?.note || '', /野史/);
  });
});
