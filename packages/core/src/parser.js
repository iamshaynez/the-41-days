// 直读模式解析器（LLM 离线时的意图管线 + 测试桩同构）。
// 语法见 README「直读语法」；所有产出与裁判 LLM 共用同一套意图 schema。
import { aliveChars, moodLevel } from './state.js';

const CHAR_ALIAS = {
  文简: 'anton', 塾师: 'anton', 辛夷: 'marta', 药婆: 'marta', 石大: 'bron', 火铺: 'bron',
  白简: 'katya', 学徒: 'katya', 阿走: 'pavel', 驿卒: 'pavel', 老甑: 'emil', 庖厨: 'emil',
  素徽: 'zofia', 琴师: 'zofia', 大柯: 'grigory', 梓匠: 'grigory', 阿禾: 'yura', 少年: 'yura',
  薄姑: 'vera', 仓曹: 'vera', 江鳅: 'danilo', 逄灶: 'alexey', 烽卒: 'alexey'
};
// 注意：多字词须排在单字词之前（"肉脯"先于"肉"，"蜜水"先于"蜜"），靠 includes 命中
const ITEM_ALIAS = {
  糙米: 'raw', 彘肩: 'meat', 肉: 'meat', 肉脯: 'canned', 熟食: 'meal', 葵菜: 'veg', 水: 'water', 饴蜜: 'sugar',
  裹创布: 'bandage', 良药: 'meds', 汤药: 'herbmed', 草药: 'herb',
  艾条: 'cigs', 艾草: 'tobacco', 蜜水: 'coffee', 浊酒: 'moonshine', 酒: 'moonshine',
  板材: 'wood', 木板: 'wood', 木头: 'wood', 杂件: 'parts', 铁件: 'comp', 铜件: 'elec', 硝石: 'powder',
  薪柴: 'firewood', 柴火: 'firewood', 膏油: 'fuel', 简册: 'book', 书: 'book',
  珠玑: 'jewel', 醇醪: 'wine', 蜀锦: 'brocade',
  拨针: 'lockpick', 铁撬: 'crowbar', 锸: 'shovel', 锯: 'saw', 斧: 'axe', 环首刀: 'knife', 刀: 'knife',
  手弩: 'pistol', 强弩: 'rifle', 弩箭: 'bullet'
};
export const LOC_ALIAS = {
  南市: 'market', 里社: 'church', 医棚: 'hospital', 驿亭: 'post', 宅区: 'villas', 水门渡: 'frontline', 旧垒: 'frontline', 前线: 'frontline', 水窦: 'sewer', 城濠: 'sewer', 北津台: 'beacon', 烽台: 'beacon', 家: 'home'
};
const RECIPE_ALIAS = { 艾条: 'make_cigs', 汤药: 'make_herbmed', 拨针: 'make_lockpick', 环首刀: 'make_knife', 斧: 'make_axe', 浊酒: 'make_moonshine', 酒: 'make_moonshine', 弩箭: 'make_bullet' };
const FAC_ALIAS = {
  床: 'bed', 炉灶: 'stove', 火盆: 'heater', 铁炉: 'heater_iron', 工作台: 'workbench', 二级工作台: 'workbench2', 三级工作台: 'workbench3',
  铁砧: 'metal', 集雨器: 'rain', 捕鼠笼: 'trap', 药圃: 'garden', 葵菜园: 'garden_veg', 蒸馏器: 'distill', 烽鼓具: 'radio', 琴: 'piano', 门: 'door'
};

function findChar(state, text) {
  for (const [k, v] of Object.entries(CHAR_ALIAS)) if (text.includes(k)) return aliveChars(state).find((c) => c.id === v) || null;
  return null;
}
function findItem(text) {
  for (const [k, v] of Object.entries(ITEM_ALIAS)) if (text.includes(k)) return v;
  return null;
}
function findLoc(text) {
  for (const [k, v] of Object.entries(LOC_ALIAS)) if (text.includes(k)) return v;
  return null;
}
function firstFree(state, pred = () => true) {
  return aliveChars(state).find((c) => c.ap > 0 && pred(c)) || null;
}

/** 泛指执行者：策略级输入里的「人/谁/有人」——不是角色名，绝不猜名，
 *  归一化时清掉交给内核选可行动的解（实测伤：「派人出门找吃的」→ actor「人」→ NO_CHAR 死胡同） */
const GENERIC_ACTOR = /^(人|谁|有人|个人|别人|某人|随便谁|随便|谁谁|派人|人们)$/;
/** 内核最优人选（与 planDusk 同一准绳：走得动 > 心态能出门 > 背包 > 战斗）——纯函数，parser 不 import delegate（防环） */
export function pickScavengerOf(state) {
  return aliveChars(state)
    .filter((c) => c.wound < 3 && c.sick < 3)
    .sort((a, b) => (Number(['depressed', 'breakdown'].includes(moodLevel(a.moodPts).key)) - Number(['depressed', 'breakdown'].includes(moodLevel(b.moodPts).key)))
      || (b.backpack - a.backpack) || ((b.combat || 0) - (a.combat || 0)))[0] || null;
}

/**
 * 把直读命令解析为意图数组。
 * @returns {{intents: Array, clarify?: string}}
 */
export function parseDirect(state, pack, input) {
  const text = (input || '').trim();
  if (!text) return { intents: [] };
  const t = text.toLowerCase();

  // 元指令
  if (/^(状态|库存|帮助|查看)/.test(text)) return { intents: [{ type: 'meta', query: 'status' }] };

  // 事件选项：选A/选1/A/1/选项share（内容包卡 + run 级 GE 生成卡）
  if (state.activeEvent) {
    const card = pack.cardMap[state.activeEvent.cardId] || state.geCards?.[state.activeEvent.cardId];
    const m = text.match(/^选?([a-zA-Z0-9]+)/);
    if (m) {
      const k = m[1];
      const byKey = card?.options?.find((o) => o.key.toLowerCase() === k.toLowerCase());
      const byIndex = card?.options?.[Number(k) - 1];
      if (byKey) return { intents: [{ type: 'event_choice', option: byKey.key }] };
      if (byIndex) return { intents: [{ type: 'event_choice', option: byIndex.key }] };
    }
    for (const o of card?.options || []) if (text.includes(o.label.slice(0, 4))) return { intents: [{ type: 'event_choice', option: o.key }] };
  }

  // 推进阶段
  if (/^(天黑|天黑吧|进入黄昏|下一阶段|睡觉吧|过)/.test(text) && !/搜/.test(text)) {
    return { intents: [{ type: 'advance' }] };
  }
  // 日常委托（v2 决断意志模型）："照常过吧"→ 管家执行今日；"继续"在夜里 → 自动探索
  if (/^(继续|接着)/.test(text) && state.phase === 'night' && state.night && !state.night.home) {
    return { intents: [{ type: 'auto_night' }] };
  }
  if (/^继续|^接着/.test(text)) {
    return { intents: [{ type: 'advance' }] };
  }
  if (/照常|自己看着办|你们自己|看着办|自己安排|开始今天|开始这一天|让他们自己|张罗|按常理/.test(text) && state.phase === 'day') {
    return { intents: [{ type: 'auto_day' }] };
  }
  // 托管出门（策略级输入，闭环纪律的解析面）：出门是夜里的活——
  // 白天说它 = 收卷今天交给管家，黄昏方案照派；黄昏说它（未点名）= 内核选人选路。
  // 绝不把「人/谁」猜成角色名（实测伤：actor「人」→ NO_CHAR「这个人不在」死胡同）
  if (/(派|让|叫|找|要)[^，。]*出(门|去)|出去/.test(text) && !findChar(state, text) && !/不出去|别出|不出门|不用出/.test(text)) {
    if (state.phase === 'day') return { intents: [{ type: 'auto_day' }] };
    if (state.phase === 'dusk') {
      const loc = findLoc(text);
      if (loc) { // 点了地方没点人：内核选人去那里
        const scav = pickScavengerOf(state);
        const others = {};
        for (const c of aliveChars(state)) if (!scav || c.id !== scav.id) others[c.id] = /守/.test(text) && text.includes(c.name) ? 'guard' : 'sleep';
        const gear = [];
        const gm = text.match(/带(.+)$/);
        if (gm) for (const [k, v] of Object.entries(ITEM_ALIAS)) if (gm[1].includes(k) && !gear.includes(v)) gear.push(v);
        return { intents: [{ type: 'dusk_assign', scavenger: scav?.id || null, location: loc, gear, others }] };
      }
      // 没点地方：内核最优方案（dusk_auto 由 resolve 展开成 planDusk 首方案）
      return { intents: [{ type: 'dusk_auto', rest: /休|睡/.test(text) && !/守/.test(text) }] };
    }
  }
  // 长期策略（"以后省着吃"——说出口的话沉淀成规矩）
  if (/省着|省点|配给/.test(text)) return { intents: [{ type: 'policy', key: 'rationing', value: true }] };
  if (/正常吃|别饿着|吃饱/.test(text)) return { intents: [{ type: 'policy', key: 'rationing', value: false }] };
  if (/夜里?小心|夜里?谨慎|悄悄的|别出声/.test(text)) return { intents: [{ type: 'policy', key: 'nightApproach', value: 'cautious' }] };
  if (/大胆|冒险|放手干/.test(text)) return { intents: [{ type: 'policy', key: 'nightApproach', value: 'bold' }] };
  if (/自己喂|我来喂|饭我来管/.test(text)) return { intents: [{ type: 'policy', key: 'feeding', value: 'manual' }] };
  if (/你看着喂|自动喂|喂饭交给你/.test(text)) return { intents: [{ type: 'policy', key: 'feeding', value: 'auto' }] };

  // 念头（v3 命运导演）：教/鼓励/惦记 某人某事——不是动作，是种进心里的方向。
  // 保守规则：仅限明确的引导动词（"让/叫/带"太容易与命令混淆，留给 LLM 裁判分辨）
  {
    const dm = text.match(/^(?:以后|往后|常常|常)?(教|鼓励|提醒|叮嘱|盼着|惦记)(.{0,40})$/);
    const who = dm ? findChar(state, dm[2]) : null;
    if (dm && who) return { intents: [{ type: 'direction', subject: who.id, text: text.slice(0, 60) }] };
  }

  // 黄昏指派：今晚A去B带C和D / 今晚谁都不出去 / 今晚B守夜
  if (/今晚|今夜/.test(text) && state.phase === 'dusk') {
    const scav = findChar(state, text.replace(/带.*$/, '').replace(/守夜.*$/, ''));
    const loc = findLoc(text);
    const others = {};
    for (const c of aliveChars(state)) {
      if (scav && c.id === scav.id) continue; // 外出的人不再被误标成守夜
      const isGuard = (text.includes(c.name) || text.includes(roleAlias(c.id))) && /守/.test(text);
      if (isGuard) others[c.id] = 'guard'; else others[c.id] = 'sleep';
    }
    if (/不出|不出去|都在家/.test(text) || (!scav && !loc)) {
      return { intents: [{ type: 'dusk_assign', scavenger: null, location: null, gear: [], others }] };
    }
    const gear = [];
    const gm = text.match(/带(.+)$/);
    if (gm) for (const [k, v] of Object.entries(ITEM_ALIAS)) if (gm[1].includes(k) && !gear.includes(v)) gear.push(v);
    return { intents: [{ type: 'dusk_assign', scavenger: scav?.id || null, location: loc, gear, others }] };
  }

  // 夜间动作
  if (state.phase === 'night' && state.night && !state.night.home) {
    const loc = pack.locMap[state.night.locId];
    if (/撤|退|回去|回家/.test(text)) return { intents: [{ type: 'night', action: 'retreat' }] };
    if (/不理|不打扰|绕开|别管他/.test(text)) {
      const npc = findNpc(loc, text);
      return { intents: [{ type: 'night', action: 'ignore', target: npc?.id }] };
    }
    if (/再搜|接着搜|再摸/.test(text)) return { intents: [{ type: 'night', action: 'push_on' }, { type: 'auto_night' }] };
    if (/观察|看看|查看房间/.test(text)) return { intents: [{ type: 'night', action: 'observe' }] };
    if (/背刺/.test(text)) {
      const npc = findNpc(loc, text);
      return { intents: [{ type: 'night', action: 'backstab', target: npc?.id }] };
    }
    if (/攻击|打|动手|杀/.test(text)) {
      const npc = findNpc(loc, text);
      return { intents: [{ type: 'night', action: 'attack', target: npc?.id }] };
    }
    if (/和.*说话|对话|问/.test(text)) {
      const npc = findNpc(loc, text);
      return { intents: [{ type: 'night', action: 'dialogue', target: npc?.id }] };
    }
    if (/清|铲/.test(text)) {
      const room = findRoom(loc, text, state);
      return { intents: [{ type: 'night', action: 'clear', target: room }] };
    }
    if (/锯/.test(text)) {
      const room = findRoom(loc, text, state);
      return { intents: [{ type: 'night', action: 'bars', target: room }] };
    }
    if (/撬|开锁/.test(text)) {
      const room = findRoom(loc, text, state);
      const cont = findContainer(loc, text);
      return { intents: [{ type: 'night', action: 'open', target: cont || room }] };
    }
    if (/搜|翻/.test(text)) {
      const cont = findContainer(loc, text);
      return { intents: [{ type: 'night', action: 'search', target: cont }] };
    }
    if (/去|进入|到/.test(text)) {
      const room = findRoom(loc, text, state);
      return { intents: [{ type: 'night', action: 'move', target: room }] };
    }
  }

  // 交易：用2木板和1零件换1绷带 / 买罐头 / 卖珠宝
  if (state.franko && state.phase === 'day' && /(用|换|买|卖)/.test(text)) {
    const give = {}, get = {};
    const segs = text.split(/[，,、和]/).map((x) => x.trim()).filter(Boolean);
    let mode = 'give';
    for (const seg of segs) {
      const m = seg.match(/(\d+)\s*个?\s*([^\d用换买卖]+)/) || seg.match(/买\s*([^\d]+)/) || seg.match(/卖\s*([^\d]+)/);
      if (/换|买/.test(seg) && !/用/.test(seg)) mode = 'get';
      const mm = seg.match(/(\d+)?\s*个?\s*([\u4e00-\u9fa5A-Za-z]+)$/);
      if (!mm) continue;
      const n = Number(mm[1] || 1);
      const item = findItem(mm[2]);
      if (!item) continue;
      if (/买/.test(seg)) get[item] = (get[item] || 0) + n;
      else if (/卖/.test(seg)) give[item] = (give[item] || 0) + n;
      else if (mode === 'give') give[item] = (give[item] || 0) + n;
      else get[item] = (get[item] || 0) + n;
    }
    if (Object.keys(give).length || Object.keys(get).length) return { intents: [{ type: 'trade_op', give, get }] };
  }

  // 白天动作
  if (state.phase === 'day') {
    const actor = findChar(state, text) || null;
    if (/吃/.test(text)) {
      const item = findItem(text);
      return { intents: [{ type: 'act', actor: actor?.id || aliveChars(state)[0]?.id, action: 'eat', target: item }] };
    }
    if (/做饭|烹饪|做饭|煮/.test(text)) {
      const c = actor || firstFree(state, (x) => x.traits?.cook) || firstFree(state);
      return { intents: [{ type: 'act', actor: c?.id, action: 'cook' }] };
    }
    if (/制造|做一把|做/.test(text) && /刀|斧|锁|弩|箭|酒|艾条|汤药/.test(text)) {
      const r = RECIPE_ALIAS[Object.keys(RECIPE_ALIAS).find((k) => text.includes(k))];
      const c = actor || firstFree(state);
      return { intents: [{ type: 'act', actor: c?.id, action: 'craft', target: r }] };
    }
    if (/建造|建|修|加固/.test(text)) {
      const facKey = Object.keys(FAC_ALIAS).find((k) => text.includes(k));
      if (facKey) {
        const c = actor || firstFree(state);
        return { intents: [{ type: 'act', actor: c?.id, action: 'build', target: FAC_ALIAS[facKey] }] };
      }
    }
    if (/治疗|包扎|换药/.test(text)) {
      const med = /绷带/.test(text) ? 'bandage' : /草药/.test(text) ? 'herbmed' : 'meds';
      // 患者 = 名字第二出现者；简化：行动者之外的伤/病者
      const c = actor || firstFree(state, (x) => x.traits?.healer) || firstFree(state);
      const patient = aliveChars(state).find((x) => x.id !== c?.id && (med === 'bandage' ? x.wound >= 1 : x.sick >= 1));
      return { intents: [{ type: 'act', actor: c?.id, action: 'treat', target: med, patient: patient?.id }] };
    }
    if (/交谈|聊天|谈谈|安慰/.test(text)) {
      const c = actor || firstFree(state);
      const other = aliveChars(state).find((x) => x.id !== c?.id);
      return { intents: [{ type: 'act', actor: c?.id, action: 'talk', target: other?.id }] };
    }
    if (/守卫|守夜/.test(text)) {
      const c = actor || firstFree(state);
      return { intents: [{ type: 'act', actor: c?.id, action: 'guard' }] };
    }
    if (/听.*更鼓|看榜|露布/.test(text)) {
      const c = actor || firstFree(state);
      return { intents: [{ type: 'act', actor: c?.id, action: 'listen_radio' }] };
    }
    if (/宽心汤|熬.*汤|安神汤/.test(text)) {
      const healer = aliveChars(state).find((c) => c.traits?.healer) || actor || firstFree(state);
      return { intents: [{ type: 'act', actor: healer?.id, action: 'comfort_soup' }] };
    }
    if (/撬开|打开|清开/.test(text)) {
      const room = { 地窖: 'cellar', 柴房: 'garage', 阁楼: 'attic', 卧室: 'bedroom', 后院: 'yard' }[Object.keys({ 地窖: 1, 柴房: 1, 阁楼: 1, 卧室: 1, 后院: 1 }).find((k) => text.includes(k)) || ''];
      if (room) {
        const c = actor || firstFree(state);
        return { intents: [{ type: 'act', actor: c?.id, action: 'open_room', target: room }] };
      }
    }
    if (/搜/.test(text)) {
      const c = actor || firstFree(state);
      const room = { 地窖: 'cellar', 柴房: 'garage', 阁楼: 'attic', 卧室: 'bedroom', 后院: 'yard' }[Object.keys({ 地窖: 1, 柴房: 1, 阁楼: 1, 卧室: 1, 后院: 1 }).find((k) => text.includes(k)) || ''];
      return { intents: [{ type: 'act', actor: c?.id, action: 'search_home', target: room }] };
    }
    if (/劈|拆/.test(text)) {
      const c = actor || firstFree(state);
      return { intents: [{ type: 'act', actor: c?.id, action: 'chop' }] };
    }
    if (/读书|看书/.test(text)) {
      const c = actor || firstFree(state);
      return { intents: [{ type: 'act', actor: c?.id, action: 'read' }] };
    }
    if (/鼓琴|弹琴|抚琴|演奏/.test(text)) {
      return { intents: [{ type: 'act', actor: 'zofia', action: 'play_piano' }] };
    }
  }

  return { intents: [], clarify: '这句话我没读懂。可以试试：「石大吃熟食」「建造炉灶」「今晚阿走去南市带铁撬」「搜房间」或「帮助」。' };
}

function roleAlias(id) { return { marta: '药婆', bron: '火铺', katya: '学徒', emil: '庖厨', grigory: '梓匠', yura: '少年' }[id] || ''; }
function findNpc(loc, text) {
  return (loc.npcs || []).find((n) => text.includes(n.name) || (n.stance === 'hostile' && /守渡|军士|敌人|兵/.test(text))) || (loc.npcs || [])[0];
}
function findRoom(loc, text, state) {
  const n = state.night;
  const cur = loc.rooms.findIndex((r) => r.id === n.room);
  const byName = loc.rooms.find((r) => text.includes(r.name.replace(/（.*）/, '')));
  if (byName) return byName.id;
  return loc.rooms[cur + 1]?.id || loc.rooms[cur - 1]?.id;
}
function findContainer(loc, text) {
  for (const r of loc.rooms) for (const c of r.containers || []) if (text.includes(c.name)) return c.id;
  return null;
}


/** 意图归一化（谋士宽进严出的"宽进"）：模型写了中文名时翻成 id，再交验证。
 *  只翻"本来就不是合法 id"的字段——已是 id 的原样保留。 */
export function normalizeIntent(state, pack, intent) {
  if (!intent || typeof intent !== 'object') return intent;
  const byName = (name) => {
    if (!name || typeof name !== 'string') return name;
    if (state.chars.some((c) => c.id === name)) return name; // 已是 id
    const hit = state.chars.find((c) => c.alive && c.name === name);
    if (hit) return hit.id;
    return CHAR_ALIAS[name] ? CHAR_ALIAS[name] : name;
  };
  const item = (id) => {
    if (!id || typeof id !== 'string') return id;
    if (pack.itemMap[id]) return id; // 已是 id
    return ITEM_ALIAS[id] || id;
  };
  const loc = (id) => {
    if (!id || typeof id !== 'string') return id;
    if (pack.locMap[id]) return id; // 已是 id
    return LOC_ALIAS[id] || id;
  };
  const roomish = (id) => {
    if (!id || typeof id !== 'string') return id;
    const n = state.night;
    if (!n || n.home) return id;
    const l = pack.locMap[n.locId];
    if (!l) return id;
    const r = l.rooms.find((x) => x.id === id);
    if (r) return id; // 已是 id
    const byRoom = l.rooms.find((x) => x.name === id || x.name.includes(id));
    if (byRoom) return byRoom.id;
    const byCont = l.rooms.flatMap((x) => x.containers || []).find((c) => c.id === id || c.name === id || c.name.includes(id));
    if (byCont) return byCont.id;
    const byNpc = (l.npcs || []).find((x) => x.id === id || x.name === id || x.name.includes(id));
    if (byNpc) return byNpc.id;
    return id;
  };
  const out = { ...intent };
  if (out.type === 'act') {
    // 泛指执行者（人/谁/有人）：不是角色名——清掉交给内核选可行动的人，不猜名
    if (out.actor && GENERIC_ACTOR.test(String(out.actor).trim())) delete out.actor;
    if (out.actor) out.actor = byName(out.actor);
    if (out.patient) out.patient = byName(out.patient);
    if (out.target) {
      if (out.action === 'talk') out.target = byName(out.target);
      else if (out.action === 'eat') out.target = item(out.target);
      else if (out.action === 'treat') out.target = ({ '草药药': 'herbmed', '良药': 'meds', '绷带': 'bandage' })[out.target] || item(out.target);
      else if (out.action === 'build') out.target = FAC_ALIAS[out.target] || out.target;
      else if (out.action === 'craft') out.target = RECIPE_ALIAS[out.target] || out.target;
      else if (['open_room', 'search_home'].includes(out.action)) out.target = {cellar: 'cellar', woodshed: 'garage', attic: 'attic', bedroom: 'bedroom', backyard: 'yard'}[out.target] || out.target;
    }
  } else if (out.type === 'dusk_assign') {
    // 泛指外出者（派人/让人）：内核最优人选顶上——不猜名，也不当留守（null 是留守的语义）
    if (out.scavenger && GENERIC_ACTOR.test(String(out.scavenger).trim())) out.scavenger = pickScavengerOf(state)?.id || null;
    if (out.scavenger) out.scavenger = byName(out.scavenger);
    if (out.location) out.location = loc(out.location);
    if (Array.isArray(out.gear)) out.gear = out.gear.map(item);
    if (out.others) out.others = Object.fromEntries(Object.entries(out.others).map(([k, v]) => [byName(k), v]));
  } else if (out.type === 'night') {
    if (out.target) out.target = roomish(out.target);
  } else if (out.type === 'trade_op') {
    if (out.give) out.give = Object.fromEntries(Object.entries(out.give).map(([k, v]) => [item(k), v]));
    if (out.get) out.get = Object.fromEntries(Object.entries(out.get).map(([k, v]) => [item(k), v]));
  } else if (out.type === 'direction') {
    if (out.subject) out.subject = byName(out.subject);
  }
  return out;
}
