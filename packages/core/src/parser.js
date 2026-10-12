// 直读模式解析器（LLM 离线时的意图管线 + 测试桩同构）。
// 语法见 README「直读语法」；所有产出与裁判 LLM 共用同一套意图 schema。
import { aliveChars } from './state.js';

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
const LOC_ALIAS = {
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

  // 事件选项：选A/选1/A/1/选项share
  if (state.activeEvent) {
    const card = pack.cardMap[state.activeEvent.cardId];
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
  // 长期策略（"以后省着吃"——说出口的话沉淀成规矩）
  if (/省着|省点|配给/.test(text)) return { intents: [{ type: 'policy', key: 'rationing', value: true }] };
  if (/正常吃|别饿着|吃饱/.test(text)) return { intents: [{ type: 'policy', key: 'rationing', value: false }] };
  if (/夜里?小心|夜里?谨慎|悄悄的|别出声/.test(text)) return { intents: [{ type: 'policy', key: 'nightApproach', value: 'cautious' }] };
  if (/大胆|冒险|放手干/.test(text)) return { intents: [{ type: 'policy', key: 'nightApproach', value: 'bold' }] };
  if (/自己喂|我来喂|饭我来管/.test(text)) return { intents: [{ type: 'policy', key: 'feeding', value: 'manual' }] };
  if (/你看着喂|自动喂|喂饭交给你/.test(text)) return { intents: [{ type: 'policy', key: 'feeding', value: 'auto' }] };

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
