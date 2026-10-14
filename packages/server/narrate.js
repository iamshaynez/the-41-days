// 直读叙事器 + 世界简报（技术架构 §7.2 降级路径）：把 facts 渲染成文字，与 LLM 叙事者同一输入。
import { moodLevel, MOOD_LEVELS, HUNGER_NAMES, HARM_NAMES, SICK_NAMES, FATIGUE_NAMES, aliveChars, charById, policyOf, validateTextMarkers, stripMarkers, optionAvailable, optionCostOk } from '../core/index.js';
import { planNightStep } from '../core/src/delegate.js';
import { markerSyntaxErrors } from '../core/src/markers.js';

const weatherName = { clear: '晴', fog: '雾', rain: '雨', snow: '雪', cold: '严寒' };

/** 事实人名化（B-4）：facts 里的 id 值（角色/物品/地点/商人代号）就地换成中文名——
 *  叙事者拿到裸 id 会现编人名（一周目实测：franko→"弗兰科"16 处、emil→"埃米尔"）。
 *  k（事实代号）保留：正文守门会拦英文照抄；值层先消掉最大风险面。纯函数。 */
export function humanFacts(state, pack, facts) {
  const alias = new Map();
  for (const c of state.chars) alias.set(c.id, c.name);
  for (const [id, def] of Object.entries(pack.charMap || {})) alias.set(id, def.name);
  for (const it of pack.items || []) alias.set(it.id, it.name);
  for (const l of pack.locations || []) alias.set(l.id, l.name);
  alias.set('franko', '鲁舟');
  alias.set('player', '你');
  alias.set('home', '家里');
  const walk = (v) => {
    if (typeof v === 'string') return alias.has(v) ? alias.get(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const mapped = (facts || []).map((f) => (f && typeof f === 'object' ? walk(f) : f));
  // 代号对照（B-2 二周目实测：war_telegraph 被叙事者直译成"电报线"）——
  // k 是内部事实代号，值层翻译管不到它；把丑话说在前头，且明确禁止具象化成器物
  mapped.push({
    k: 'note',
    text: '说明：字段 k 是事实代号（如 franko_left=船牙鲁舟离岸、franko=鲁舟、war_telegraph=交割前兆——指北边的动静变了，不是任何具体器物）。代号一律不得直译成器物或地名。正文一律用中文名，禁止把代号音译成人名，禁止出现英文与现代器物。'
  });
  // 概述日（长线体验 §4.4）：这一天已被内核一笔带过——叙事者不得虚构它的事件
  if ((facts || []).some((f) => f && f.k === 'day_overview')) {
    mapped.push({ k: 'note', text: '说明：day_overview=今天是被概述的平淡日（家里自理：吃饭/家务/管家张罗）。正文一两句带过这一天即可，不要虚构新事件。' });
  }
  return mapped;
}

/** 内部 id 的常见音译（玩家侧永远不该见到）：franko=鲁舟、emil=老甑……
 *  一周目实测 LLM 把 franko_left 的代号音译成「弗兰科」16 处——纯中文，
 *  西文守门拦不住，这里按词拦（黑名单均不在正典文本中，已核）。 */
const TRANSLIT_BAN = [
  '弗兰科', '法兰科', '弗兰克', '弗朗哥', '埃米尔', '艾米丽', '玛尔塔', '马尔塔',
  '帕维尔', '巴维尔', '索菲亚', '苏菲亚', '格里戈里', '格里高利', '卡秋莎',
  '达尼洛', '阿列克谢', '亚历克谢', '尤拉', '安东', '卡佳', '布隆', '薇拉'
];

/** 现代器物黑名单（B-2 二周目实测：手电/开枪/电报线混进了建安年间的江陵）——
 *  注意「炮」是本作正典词表内的通假（内容全卷统一使用），不在此列 */
const ANACHRON_BAN = ['手电', '电报', '开枪', '枪声', '子弹', '电话', '广播', '汽车', '火车', '飞机', '电池', '手表', '照相机', '电脑'];

/** 常见繁体字（简体正典里不该出现的字面——D36 实测「門缝」漏网） */
const TRAD_CHARS = '門們時說聽國東車馬鳥龍風雲電書長樂關髮還進遠運過當歲處帶幾後裡裏為無發從眾備複應識證據戰紙張現線讓話將與點體驗鄰銀餓飯藥傷醫燈';

/** 叙事后守门（B-4 + B-2）：中文书页不收西文串、不收野标记、不收音译名、
 *  不收现代器物、不收繁体字面、不收半角标点。返回 reasons（空=过）。 */
export function narrationLint(text, pack) {
  const reasons = [];
  const t = String(text || '');
  if (/[A-Za-z]{3,}/.test(t)) reasons.push('西文串泄漏');
  if (TRANSLIT_BAN.some((w) => t.includes(w))) reasons.push('内部代号音译');
  if (ANACHRON_BAN.some((w) => t.includes(w))) reasons.push('现代器物（时代错位）');
  for (const ch of TRAD_CHARS) { if (t.includes(ch)) { reasons.push(`繁体字面（${ch}）`); break; } }
  if (/[,.!?;:]/.test(t.replace(/\d+[.:]\d+/g, ''))) reasons.push('半角标点');
  if (markerSyntaxErrors(t).length) reasons.push('标记语法不对');
  if (validateTextMarkers(t, pack).length) reasons.push('名词不在册');
  return reasons;
}

/** 世界简报（裁判/叙事者共享的只读上下文） */
export function worldBrief(state, pack) {
  const chars = aliveChars(state).map((c) =>
    `${c.name}(${c.id})：饥饿${HUNGER_NAMES[c.hunger]}${c.wound ? `/${HARM_NAMES[c.wound]}` : ''}${c.sick ? `/${SICK_NAMES[c.sick]}` : ''}${c.fatigue ? `/${FATIGUE_NAMES[c.fatigue]}` : ''}/心情${moodLevel(c.moodPts).name}/行动力${c.ap}`
  ).join('；');
  const inv = Object.entries(state.inventory).map(([k, v]) => `${pack.itemMap[k]?.name || k}×${v}`).join('、') || '空';
  const locs = state.knownLocs.map((id) => `${pack.locMap[id]?.name || id}(${id})`).join('、');
  // 待决事件/岔路把选项摆给裁判（key=label）：只给标题时自由文本只能瞎猜 option
  // ——BAD_OPTION「没有这个选项」或解析成游离动作，答非所问就是这么来的
  const roCtx = { s: state, hasItem: (i, n = 1) => (state.inventory[i] || 0) >= n }; // 只读鸭子 ctx（与 eventOptionsView 同款）
  const evCard = state.activeEvent ? (pack.cardMap[state.activeEvent.cardId] || state.geCards?.[state.activeEvent.cardId]) : null;
  const evOptLine = (evCard?.options || [])
    .filter((o) => optionAvailable(roCtx, o) && optionCostOk(roCtx, o))
    .map((o) => `${o.key}=${o.label}`)
    .join('；');
  const ev = evCard
    ? `（门口有未决事件：《${evCard.title}》。玩家若在作答，只能选：${evOptLine || '（当前无可行选项——只能另想办法或等待）'}）`
    : '';
  const nightFork = (state.night && !state.night.home && !state.activeEvent)
    ? planNightStep(state, pack, { approach: state.night.directive?.stance })
    : null;
  const forkTxt = (nightFork?.stop && nightFork.stop.kind !== 'event')
    ? `【岔路待答】${nightFork.stop.text} 可选：${nightFork.stop.options.map((o) => o.label).join('；')}`
    : '';
  const nightScav = state.night && !state.night.home ? charById(state, state.night.charId) : null;
  const night = state.night && !state.night.home
    ? `【夜访中】${nightScav ? `${nightScav.name}独行·` : ''}${pack.locMap[state.night.locId]?.name}·当前房间${pack.locMap[state.night.locId]?.rooms.find((r) => r.id === state.night.room)?.name}·剩余火柴${state.night.slots}根`
    : '';
  const sealNote = (state.seals || []).length ? `【已显形真相 ${state.seals.length} 层】` : '';
  // 念头（v3 命运导演）：玩家种下的方向性意图——裁判/叙事者要认得它们，行文可呼应可推进
  const dirs = Object.values(state.directions || {}).filter((d) => d.alive);
  const dirTxt = dirs.length
    ? `【种下的念头】${dirs.map((d) => `${d.subject ? (charById(state, d.subject)?.name || d.subject) : '这个家'}:${d.text}`).join('；')}（说话时可呼应或推进，不必主动执行）`
    : '';
  // 玩家立下的规矩（裁判要认："省着吃"之类的话语会沉淀成这里的策略）
  const pol = policyOf(state);
  const polTxt = `【现行规矩】吃饭${pol.feeding === 'auto' ? '管家自动喂' : '玩家亲自管'}·${pol.rationing ? '省粮配给' : '正常吃饭'}·夜里${{ cautious: '谨慎不出声', bold: '大胆放手', normal: '照常' }[pol.nightApproach] || '照常'}`;
  // A-1 主语钉死（二周目实测：夜访叙事里商人鲁舟频频顶替夜访者——8+ 处）：
  // 夜已收工后叙事多发生在晨间，靠 lastScavenger 把"昨夜谁出门"写进世界简报
  const lastScav = state.lastScavenger ? (charById(state, state.lastScavenger)?.name || null) : null;
  const castTxt = lastScav
    ? `【人物分工·铁律】昨夜出门夜访的是${lastScav}，夜访段落的唯一主语；鲁舟是渡口商人，只在自己的摊上做买卖，从不替这个家出门、搜刮、办事。`
    : '';
  return `第${state.day}天/${weatherName[state.weather]}/${state.phase === 'day' ? '白天' : state.phase === 'dusk' ? '黄昏' : state.phase === 'night' ? '深夜' : '破晓'}${state.winterActive ? '/冬季' : ''}。队伍：${chars}。库存：${inv}。已知地点：${locs}。${polTxt}${state.franko ? '船牙鲁舟在门外的渡口边摆摊。' : ''}${ev}${forkTxt}${night}${castTxt}${sealNote}${dirTxt}`;
}

/** 模板变体选条（文案丰满批次一）：模板值可为字符串或数组——数组按
 *  （种子 × 日期 × 模板路径）确定性取一。纯函数：同局同日同模板必得同条（回放一致），
 *  跨日自然换条，叙事有呼吸感。 */
function pickVariants(node, state, path = '') {
  if (Array.isArray(node)) {
    if (!node.length) return node;
    let h = (state.seed || 0) ^ ((state.day || 0) * 97);
    for (const ch of path) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return node[Math.abs(h) % node.length];
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = pickVariants(v, state, path + '/' + k);
    return out;
  }
  return node;
}

/** 直读渲染：facts → 模板文（每条 fact 至少一行；缺模板时用通用行） */
export function renderDirect(state, facts, pack) {
  const t = pickVariants(pack.narrations, state);
  const lines = [];
  // 死者仍在 chars 里但 alive=false——charById 只查活人，会漏成内部 id（"bron的病"）。
  // 人名先查本局名册（含死者），再查内容包，最后才落 id。
  const name = mkName(state, pack);
  let prev = null;
  for (const f of facts) {
    const l = directFactLine(f, t, name, state, pack, prev);
    if (l) lines.push(l);
    prev = f.k;
  }
  return lines.filter(Boolean).join('\n');
}

/** 单条事实 → 一行直读文（renderDirect 与 buildBeats 共用同一张映射；无行返回 null） */
function directFactLine(f, t, name, state, pack, prevKey = null) {
  const lines = [];
  switch (f.k) {
      case 'run_started': lines.push(`第 1 天。${t.dawn.header.replace('{{day}}', 1).replace('{{weather}}', '围城第 9 天')}——你们住进了橘里九号。${f.chars}，三个名字写在了门后的墙上。`); break;
      case 'prologue_start': lines.push('在这一切之前——降卒进城的那天。'); break;
      case 'prologue_beat': lines.push(`——${f.title}——`); break;
      case 'prologue_end': lines.push('序章读完。从今天起，每一天都是你们的了。'); break;
      case 'in_prologue': lines.push('（先把这一拍读完，再选。）'); break;
      case 'phase_day': lines.push(`天亮了。交割后第 ${f.day} 天，${weatherName[f.weather]}。该干的活，等着人。`); break;
      case 'dissolve_shift': lines.push(f.n > 0
        ? '北边的军心，又松了一分——家访的簿子、家书的袖子，都在替它使劲。'
        : '有一封家书没有写"都好"。北边握矛的手，紧了一紧。'); break;
      // 概述日直落黄昏：黄昏行要说清「这一天过去了」——不然玩家以为整夜没走完
      case 'phase_dusk': lines.push(prevKey === 'day_overview' ? (t.overview?.to_dusk || t.phase.to_dusk) : t.phase.to_dusk); break;
      case 'eat': lines.push(t.eat[f.item === 'meal' ? 'meal' : 'raw'].replace('{{name}}', name(f.char))); break;
      case 'cook': lines.push(t.cook.replace('{{name}}', name(f.char))); break;
      case 'craft': lines.push(t.craft.replace('{{name}}', name(f.char))); break;
      case 'build': lines.push(t.build.replace('{{name}}', name(f.char))); break;
      case 'build_door': lines.push(`门又加了一层板子。现在是第 ${f.level} 级加固。`); break;
      case 'treat': lines.push(t.treat.replace('{{name}}', name(f.char)).replace('{{patient}}', name(f.patient))); break;
      case 'talk': lines.push(t.talk); break;
      case 'read': lines.push(`${name(f.char)} 翻开一册简，读了一会儿。简上没有战争。`); break;
      case 'guard': lines.push(`${name(f.char)} 决定今夜守在门厅。`); break;
      case 'rest': lines.push(`${name(f.char)} 躺下了。伤要养，命要省。`); break;
      case 'radio_news': lines.push(t.radio.news.replace('{{text}}', f.text) + (f.note ? `\n${t.radio.katya.replace('{{text}}', '').replace('{{note}}', f.note)}` : '')); break;
      case 'radio_weather': lines.push(`看榜的老者说明天：${weatherName[f.tomorrow]}。`); break;
      case 'radio_music': lines.push(t.radio.music); break;
      case 'radio_missing': lines.push(f.text); break;
      case 'radio_static': lines.push('只有更鼓声。'); break;
      case 'search_hit': lines.push(`翻了一阵，找到了：${(f.got || []).map((g) => `${pack.itemMap[g.item]?.name || g.item}×${g.n}`).join('、') || '一点零碎'}。`); break;
      case 'search_miss': lines.push(t.night.search_miss); break;
      case 'hidden_found': lines.push(`墙皮后面有个暗格——${f.name}。`); break;
      case 'doc_found': lines.push(`一张纸从杂物里露出来：《${f.title}》。${f.layer >= 3 ? '它烫手。' : f.layer === 2 ? '它不对劲。' : '它属于从前。'}（已入档案）`); break;
      case 'seal_unlock': lines.push(`——一层真相在你心里显形了。${f.text}（档案馆已收录）`); break;
      case 'open_room': lines.push(`${f.room} 的阻隔被清开了。`); break;
      case 'no_ap': lines.push(t.refuse.no_ap.replace('{{name}}', name(f.char))); break;
      case 'no_food': lines.push('家里没有能吃的东西了。'); break;
      case 'no_fuel': lines.push('没柴了。冷的锅，冷的胃。'); break;
      case 'no_material': lines.push(`材料不够——缺${pack.itemMap[f.item]?.name || f.item}。`); break;
      case 'no_tool': lines.push(`没有${f.tool}。`); break;
      case 'need_facility': lines.push(`得先有${f.facility}。`); break;
      case 'waste_warning': lines.push(`${name(f.char)} 已经吃饱了，再吃就是浪费。`); break;
      case 'franko_incoming': lines.push(f.dark ? t.franko.arrive_dark : t.franko.arrive); break;
      case 'franko_left': lines.push(t.franko.leave); break;
      case 'trade_done': lines.push(t.trade.deal); break;
      case 'trade_reject': lines.push(t.trade.reject); break;
      case 'trade_no_stock': lines.push('鲁舟摊摊手：没这个货。'); break;
      case 'night_arrive': lines.push(t.night.arrive.replace('{{char}}', name(f.char)).replace('{{loc}}', pack.locMap[state.night?.locId]?.name || '')); break;
      case 'night_move': lines.push(`挪进了${f.room}。`); break;
      case 'night_observe': lines.push(`看清了这间屋：${(f.containers || []).join('、') || '没有容器'}。${(f.npcs || []).length ? `还有${f.npcs.join('、')}。` : ''}`); break;
      case 'night_search_hit': lines.push(t.night.search_hit.replace('{{char}}', name(f.char)).replace('{{loot}}', (f.items || []).map((g) => `${pack.itemMap[g.item]?.name || g.item}×${g.n}`).join('、'))); break;
      case 'night_no': lines.push(f.msg ? `（${f.msg}）` : '……'); break;
      case 'night_unlock': lines.push(f.quiet ? '锁簧轻轻让开了。' : '撬棍闷响一声，锁开了。'); break;
      case 'night_noise_alert': lines.push(t.night.noise); break;
      case 'lockpick_broke': lines.push('拨针断在锁眼里。'); break;
      case 'night_drop': lines.push(`背不动了，${pack.itemMap[f.item]?.name || f.item}被留在了原地。`); break;
      case 'night_end': lines.push(f.reason === 'abort' ? `${name(f.char)}连夜退了出去。今晚就到这。` : `天边泛灰，${name(f.char)}往回走。背回来了 ${f.carried} 件东西。`); break;
      case 'night_abort': lines.push('退出去。今晚就到这。'); break;
      case 'combat_win': lines.push(t.night.combat_win); break;
      case 'combat_hurt': lines.push(t.night.combat_hurt.replace('{{char}}', name(state.lastScavenger || state.chars.find((c) => !c.bedRest)?.id))); break;
      case 'combat_flee': lines.push(t.night.combat_flee.replace('{{char}}', name(state.lastScavenger || 'bron'))); break;
      case 'combat_flee_hurt': lines.push('没打赢。连滚带爬地退了出来，东西撒了一路。'); break;
      case 'raid': lines.push(raidLine(f, t, name)); break;
      case 'raid_slumber': lines.push(`${name(f.char)} 靠着门框睡着了。他饿得没撑住——这不是他的错，你知道是谁的。`); break;
      case 'raid_none': lines.push(t.raid.quiet); break;
      case 'protest': lines.push(`${name(f.char)}：『${f.line}』`); break;
      case 'auto_marta_care': lines.push('辛夷的黑眼圈重了一层。昨夜她出去过，没人看见她去了哪里。'); break;
      case 'auto_anton_struck': lines.push('文简记账的手停了一下。有些名字，从今天起不在他的账上了。'); break;
      case 'auto_vera_ledger': lines.push('薄姑在一个小簿上写了一行字，然后把它收进了贴身的袖袋。'); break;
      case 'event': lines.push(`——${f.title}——`); break;
      case 'event_text': lines.push(f.text); break;
      case 'loc_unlocked': lines.push(t.loc_unlocked.replace('{{loc}}', f.loc)); break;
      case 'capsule_found': lines.push(`后院墙角，土比别处松。挖开来：一件旧物，一张字条。字条上写：「${f.message}」（${f.fresh ? '东西还在，拿起来了。' : '东西上次已经取走了。'}）`); break;
      case 'depressed_refuse': lines.push(`${name(f.char)} 摇了摇头，蜷回角落。（抑郁：拒绝${f.what}）`); break;
      case 'too_weak': lines.push(`${name(f.char)} 已经迈不动夜路了。`); break;
      case 'starve_sick': lines.push(`${name(f.char)} 饿得发起烧来。`); break;
      case 'cold_sick': lines.push(`${name(f.char)} 夜里冻着了，早上开始咳嗽。`); break;
      case 'infection': lines.push(`${name(f.char)} 的伤口发红了。`); break;
      case 'death': lines.push(t.death.own.replace('{{name}}', name(f.char))); break;
      case 'winter_start': lines.push('冬天来了。水在桶里结成整块的沉默。'); break;
      case 'winter_end': lines.push('天气松动了些。'); break;
      case 'war_telegraph': lines.push(t.war.telegraph); break;
      case 'run_ended': lines.push(t.war[f.type] || '没有人再从橘里九号走出来。'); break;
      case 'option_unavailable': lines.push(f.why ? `（做不到——${f.why}。）` : '（做不到——条件不够。）'); break;
      // —— v2 管家与决策点 ——
      case 'auto_day_start': lines.push('他们没有等你一一吩咐。新的一天，各忙各的去了。'); break;
      case 'policy_set': {
        const txt = f.key === 'rationing' ? (f.value ? '记下了：以后省着吃，先紧着真正饿的人。' : '记下了：恢复正常吃饭，别让人饿着。')
          : f.key === 'nightApproach' ? (f.value === 'cautious' ? '记下了：夜里小心些，不出声。' : f.value === 'bold' ? '记下了：夜里放手干。' : '记下了：夜里照常。')
          : f.key === 'feeding' ? (f.value === 'manual' ? '记下了：吃饭的事你亲自管。' : '记下了：吃饭的事他们自己张罗。')
          : f.key === 'overviewDays' ? (f.value === false ? '记下了：平淡的日子也一天一天细过。' : '记下了：平淡的日子一笔带过。')
          : '记下了。';
        lines.push(txt); break;
      }
      case 'day_overview': lines.push(overviewLine(f, t)); break;
      case 'night_fork': lines.push(f.text || '前面有个岔子，等你拿主意。'); break;
      case 'night_directive_set': lines.push(`今夜的方针定了：${f.text}（${{ cautious: '谨慎', normal: '照常', bold: '放手' }[f.stance] || '照常'}）。接下来的一夜，他自己走。`); break;
      case 'night_choice': lines.push(`按方针，他选了：${f.label}。`); break;
      case 'night_ignore': lines.push(`没去惊动${f.npc}，各走各的。`); break;
      // —— v3 念头与话语 ——
      case 'direction_set': lines.push(`这句话落进了${f.subject ? name(f.subject) : '这个家'}心里：「${f.text}」。`); break;
      case 'direction_watered': lines.push(`这事又提了一遍——${f.subject ? name(f.subject) : '这个家'}记着呢。`); break;
      case 'direction_faded': lines.push(`「${f.text}」——后来没人再提，它就淡了。`); break;
      case 'direction_echo': lines.push(`${f.char ? name(f.char) : '这个家'}还惦记着「${f.text}」这件事。`); break;
      case 'whisper_kept': lines.push('（这句话没人接。可这座城什么都听着。）'); break;
      case 'fate_passed': lines.push('门外的动静等你等到天黑。等你动身，它已经过去了。'); break;
      // —— 此前落到默认省略号的事实，逐条补上人话 ——
      case 'chop': lines.push(`${name(f.char)}劈了件家具，得些木料。`); break;
      case 'comfort_soup': lines.push(`${name(f.char)}把一撮草药滚进水里，熬了一锅安神汤。${name(f.patient)}捧着碗，手稳了一点。`); break;
      case 'nap': lines.push(`${name(f.char)}眯了一阵。`); break;
      case 'no_furniture': lines.push('能拆的家具都拆完了。'); break;
      case 'no_item': lines.push('手头没有那个东西。'); break;
      case 'no_med': lines.push('没有药。'); break;
      case 'nothing_to_search': lines.push('家里能翻的角落都翻过了。'); break;
      case 'container_refilled': lines.push(`${f.name}——不知什么时候又被谁填上了。`); break;
      case 'weak_scavenge': lines.push(`${name(f.char)}拖着这样的身子上路，你看着都揪心。`); break;
      case 'night_breach': lines.push(`火铺卒的老手艺——${f.room}的门框在他手里让开了，没出声。`); break;
      case 'night_open_container': lines.push(`${f.name}开了。`); break;
      case 'night_clear': lines.push(`瓦砾清开了，${f.room}能进了。`); break;
      case 'night_saw': lines.push(`锯刃咬过栅栏，${f.room}的路通了。`); break;
      case 'night_dialogue': lines.push(`你们说了几句话。（${f.npc}）`); break;
      case 'night_backstab': lines.push(`一刀。${f.npc}没来得及出声。`); break;
      case 'night_backstab_fail': lines.push(`刀没递到——${f.npc}察觉了！`); break;
      case 'dying_wound': lines.push(`${name(f.char)}的伤，没能熬过去。`); break;
      case 'dying_sick': lines.push(`${name(f.char)}的病，没能熬过去。`); break;
      case 'critical_wound_hold': lines.push(`${name(f.char)}还吊着一口气，伤口在发烫。`); break;
      case 'critical_sick_hold': lines.push(`${name(f.char)}还吊着一口气，烧得说胡话。`); break;
      case 'wound_worse': lines.push(`${name(f.char)}的伤恶化了。`); break;
      case 'breakdown_stage': lines.push(`${name(f.char)}的状态更不对了——得有人陪着说说话。`); break;
      case 'breakdown_recovered': lines.push(`${name(f.char)}缓过来了。人在。`); break;
      case 'night_rest': lines.push(`${name(f.char)}${f.bed ? '在床上睡了个整觉' : f.half ? '睡了后半宿' : '睡了个安稳觉'}，缓了回来。`); break;
      case 'guard_handover': lines.push(`${name(f.to)}回来接了守，${name(f.from)}总算能躺下了。`); break;
      case 'breakdown_left': lines.push(`${name(f.char)}走了。门轴响了一声，没有人追。`); break;
      case 'trap_caught': lines.push('捕鼠笼响了——有肉了。'); break;
      case 'trap_empty': lines.push('捕鼠笼空着。'); break;
      case 'garden_harvest': lines.push(`园子里有了收成：${Object.entries(f).filter(([k]) => !['k', 'delegated'].includes(k)).map(([k, v]) => `${pack.itemMap[k]?.name || k}×${v}`).join('、')}。`); break;
      case 'moonshine_ready': lines.push('蒸馏器滴完了最后一滴——浊酒成了。'); break;
      case 'shovel_returned': lines.push('借出去的锸还回来了，邻居守信。'); break;
      case 'crossing_hushed': lines.push('今夜水门渡没有箭声。鼓谱换来的安静，是真的。'); break;
      case 'doc_price_odd': lines.push('（鲁舟收纸的价高得反常——他买的不是纸。）'); break;
      case 'hospital_trade_open': lines.push('医棚的药工把抽屉拉开：药可以换，拿吃的来。'); break;
      case 'piano_broken': lines.push('琴还是断弦的——得先续。'); break;
      case 'piano_play': lines.push(f.first ? '琴声第一次响起来。走音，但完整。所有人都停下了手里的事。' : '琴声又响了一会儿。'); break;
      case 'raid_mortal': lines.push('夜里来的人下了死手。'); break;
      case 'repair_door': lines.push('门的裂缝被新板子填上了。'); break;
      case 'war_lighthouse': lines.push(t.war.lighthouse); break;
      case 'war_alt_shift': lines.push(t.war.alt_shift); break;
      case 'war_join_table': lines.push(t.war.join_table); break;
      case 'mood_level': break; // 心情档位变化由卡片剪影承载，不占正文
      case 'meta': break;
      default: lines.push('……'); break;
    }
  return lines.filter(Boolean).join('\n') || null;
}

/** 人名解析（renderDirect/buildBeats 共用）：先查本局名册（含死者），再查内容包 */
function mkName(state, pack) {
  return (id) => state.chars.find((c) => c.id === id)?.name || pack.charMap?.[id]?.name || id;
}

/** 概述日一笔（长线体验 §4.4）：连平越深字越省——deep 档连家常补笔都省了 */
function overviewLine(f, t) {
  const ov = t.overview || {};
  const streak = f.streak || 1;
  const tier = streak <= 1 ? 'first' : streak <= 3 ? 'again' : 'deep';
  let line = ov[tier] || '这一天没有什么可记的。';
  if (tier !== 'deep') {
    const notes = [];
    if (f.ate?.length) notes.push((ov.note_eat || '').replace('{{n}}', String(f.ate.length)));
    if (f.built) notes.push((ov.note_built || '').replace('{{what}}', f.built));
    if (f.searched && notes.length < 2) notes.push(ov.note_searched || '');
    line = line.replace('{{note}}', notes.filter(Boolean).join(''));
  }
  return line.replace('{{note}}', '').trim();
}

/** 节拍视图（体验批次三·原地反馈）：facts → [{k,line,char?,del?}]。
 *  与 renderDirect 同一张映射——打字机走到哪一拍，页面就在哪里动一下。 */
export function buildBeats(state, facts, pack) {
  const t = pickVariants(pack.narrations, state);
  const name = mkName(state, pack);
  const beats = [];
  let prev = null;
  for (const f of facts) {
    const line = directFactLine(f, t, name, state, pack, prev);
    if (line) beats.push({ k: f.k, line, ...(f.char ? { char: f.char } : {}), ...(f.delegated ? { del: true } : {}) });
    prev = f.k; // 与 renderDirect 同步更新——两条路径必须逐字节一致（契约测试在案）
  }
  return beats;
}

/** 反馈载荷（SSE feedback 事件 / confirm-plan JSON）：
 *  beats=逐拍行文（带行动者）；moves=物品增减账（事件流原账）；ticks=破晓刻度（指名到人）；
 *  ledger=账卡台账（物资/人物状态每一笔变动：变多少、为什么、谁的手）——落库为 role:ledger 书页行。
 *  turn={choice:{by,text}, directive}：本轮归因上下文——choice 卡头引言；directive=玩家本轮亲自定过方针
 *  （方针夜的自走步是执行你的选择，归「你」；无方针的自走才是「规矩」）。 */
export function buildFeedback(state, facts, events, pack, inputDay, turn = {}) {
  return {
    beats: buildBeats(state, facts, pack),
    moves: (events || []).filter((e) => e.t === 'ITEM_MOVED').map((e) => ({ item: e.d.item, delta: e.d.delta, why: e.d.why })),
    ticks: (events || []).filter((e) => ['HUNGER_CHANGED', 'WOUND_CHANGED', 'SICK_CHANGED', 'FATIGUE_CHANGED', 'MOOD_LEVEL', 'BREAKDOWN_START'].includes(e.t))
      .map((e) => ({ t: e.t, char: e.d.char, from: e.d.from, to: e.d.to })),
    ledger: buildLedger(state, events, pack, inputDay, turn)
  };
}

/** 账卡台账：一轮之内「家底与人」的每一笔变动，纯事件流聚合（fold 同源）。
 *  结构随 role:ledger 落库（JSON），续局重铺同一张卡——items/chars 都是人话（中文名），
 *  每行带 why 与三源徽记 tier（you=这轮你点的 / rule=你立下、管家与作息在执行的 / world=世界的手）。 */
const VITALS = {
  HUNGER_CHANGED: { k: 'hunger', label: '饥饿', names: HUNGER_NAMES, good: 'up' },
  WOUND_CHANGED: { k: 'wound', label: '伤势', names: HARM_NAMES, good: 'down' },
  SICK_CHANGED: { k: 'sick', label: '病势', names: SICK_NAMES, good: 'down' },
  FATIGUE_CHANGED: { k: 'fatigue', label: '疲劳', names: FATIGUE_NAMES, good: 'down' }
};
const MOOD_LV_NAME = Object.fromEntries(MOOD_LEVELS.map((l) => [l.key, l.name]));
// 三源判据（why 人串都是内核手写的，词表封闭可枚举）：
// 世界的手——时间、病痛、劫掠、瘾头、人心这些不归任何玩家决定的事
const WORLD_WHY = new Set([
  '过了一日', '饿出病来', '伤未医治，恶化了', '病未医治，恶化了', '伤口感染了', '冬夜受寒', '崩溃自戕', '夜里偷偷照料人',
  '劫掠者下了狠手', '劫掠者下了死手', '窃贼行凶', '击退夜袭时挂了彩', '被窃', '失窃',
  '严重饥饿拖累', '重伤拖累', '瘾头', '被袭失窃', '同伴崩溃自伤', '邻里守信', '良心'
]);
// 规矩的手——作息与既定安排的回报（破晓伤病恢复矩阵：治过、养过，账到日子才结）；
// 常设家什的自动产出与烧用（取暖/集雨/园子/捕鼠……）也是规矩在替你干活，
// 即便发生在方针夜也不归「你」——方案管夜路，不管炉子
const RULE_WHY = new Set(['卧床将养', '将养数日好了', '静养好了', '治过又静养', '治过又有人照看', '安抚见了效',
  '取暖', '化雪', '集雨', '集雪', '园子', '捕鼠', '蒸馏', '归还', '安睡将息', '睡床安睡', '半宿将息']);
/** 一笔变动的三源判定：世界词表 > 作息词表 > delegated 印（方针夜升级归你）> 你的手 */
function tierOf(rawWhy, delegated, turn) {
  if (rawWhy && (rawWhy.startsWith('ml_') || WORLD_WHY.has(rawWhy))) return 'world';
  if (rawWhy && RULE_WHY.has(rawWhy)) return 'rule';
  if (delegated) return turn?.directive ? 'you' : 'rule';
  return 'you';
}
export function buildLedger(state, events, pack, inputDay, turn = {}) {
  const cname = (id) => state.chars.find((c) => c.id === id)?.name || pack.charMap?.[id]?.name || id;
  // why 人话化：内容包默认码兜底；事件卡 id → 《卡名》；ml_<stepId> → 城事步题
  const whyTxt = (why) => {
    if (!why || why === 'gain') return '得物';
    if (why === 'use') return '用掉';
    if (pack.cardMap?.[why]?.title) return `《${pack.cardMap[why].title}》`;
    if (why.startsWith('ml_')) {
      const st = (pack.mainline?.steps || []).find((x) => 'ml_' + x.id === why);
      if (st) return `城事：${st.title}`;
    }
    return why;
  };
  // —— 家底：同物同因聚成一笔（异因分开；先来先排）——
  const items = [];
  const itemIx = new Map();
  for (const e of events || []) {
    if (e.t !== 'ITEM_MOVED') continue;
    const key = e.d.item + '\u0000' + (e.d.why || '');
    let row = itemIx.get(key);
    if (!row) {
      row = { item: e.d.item, name: pack.itemMap?.[e.d.item]?.name || e.d.item, delta: 0, why: whyTxt(e.d.why), tier: tierOf(e.d.why, e.d.delegated, turn) };
      itemIx.set(key, row); items.push(row);
    }
    row.delta += e.d.delta;
  }
  // —— 人：刻度逐笔（同刻度相邻合并，异源并笔不落徽），心情按人聚因，崩溃单列 ——
  const chars = [];
  const charIx = new Map();
  const charRow = (id) => {
    let row = charIx.get(id);
    if (!row) { row = { char: id, name: cname(id), rows: [] }; charIx.set(id, row); chars.push(row); }
    return row;
  };
  const moodAcc = new Map(); // id -> { parts: [{raw, delta}], lvFrom, lvTo }
  const moodOf = (id) => {
    let m = moodAcc.get(id);
    if (!m) { m = { parts: [], lvFrom: null, lvTo: null }; moodAcc.set(id, m); }
    return m;
  };
  for (const e of events || []) {
    const d = e.d || {};
    if (VITALS[e.t]) {
      const def = VITALS[e.t];
      const rows = charRow(d.char).rows;
      const tier = tierOf(d.why, d.delegated, turn);
      const prev = rows[rows.length - 1];
      // 相邻同刻度合并：吃饱又消化（同轮两次饥饿变动）并成一行，why 用「、」连；
      // 两笔不同源时行不落徽——账不硬归一方
      if (prev && prev.k === def.k) {
        prev.to = def.names[d.to] ?? String(d.to);
        prev.whys.push(whyTxt(d.why));
        prev.why = prev.whys.join('、');
        prev.tiers = new Set([...prev.tiers, tier]);
        prev.tier = prev.tiers.size === 1 ? tier : undefined;
        prev.dir = def.names[d.to] === prev.from ? 'flat' : (d.to > d.from ? 'up' : 'down') === def.good ? 'good' : 'bad';
      } else {
        const dir = d.to > d.from ? 'up' : 'down';
        rows.push({
          k: def.k, label: def.label,
          from: def.names[d.from] ?? String(d.from), to: def.names[d.to] ?? String(d.to),
          whys: [whyTxt(d.why)], why: whyTxt(d.why),
          tiers: new Set([tier]), tier,
          dir: dir === def.good ? 'good' : 'bad'
        });
      }
    } else if (e.t === 'MOOD_DELTA') {
      const m = moodOf(d.char);
      let part = m.parts.find((p) => p.raw === d.reason);
      if (!part) { part = { raw: d.reason, delta: 0, delegated: !!d.delegated }; m.parts.push(part); }
      part.delta += d.delta;
      part.delegated = part.delegated && !!d.delegated;
    } else if (e.t === 'MOOD_LEVEL') {
      const m = moodOf(d.char);
      if (!m.lvFrom) m.lvFrom = MOOD_LV_NAME[d.from] || d.from;
      m.lvTo = MOOD_LV_NAME[d.to] || d.to;
    } else if (e.t === 'BREAKDOWN_START') {
      charRow(d.char).rows.push({ k: 'breakdown', label: '崩溃', to: '崩溃了', why: '', tier: 'world', dir: 'bad' });
    } else if (e.t === 'BREAKDOWN_RECOVERED') {
      charRow(d.char).rows.push({ k: 'calm', label: '崩溃', to: '缓过来了', why: '安抚见了效', tier: 'rule', dir: 'good' });
    }
  }
  for (const [id, m] of moodAcc) {
    const total = m.parts.reduce((a, p) => a + p.delta, 0);
    if (!total && !m.lvTo) continue;
    // 徽记随最大一笔的原因（点数大头是谁的账，徽就是谁的）
    const top = [...m.parts].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    const reasons = m.parts.map((p) => whyTxt(p.raw));
    charRow(id).rows.push({
      k: 'mood', label: '心情',
      ...(m.lvFrom && m.lvTo ? { from: m.lvFrom, to: m.lvTo } : {}),
      delta: total, reasons, why: reasons.join('、'),
      ...(top ? { tier: tierOf(top.raw, top.delegated, turn) } : {}),
      dir: total < 0 ? 'bad' : 'good'
    });
  }
  for (const c of chars) for (const row of c.rows) { delete row.whys; delete row.tiers; if (row.tier === undefined) delete row.tier; } // 内部记账字段不落库；混合源行不落徽
  return { day: inputDay ?? state.day, ...(turn?.choice ? { choice: turn.choice } : {}), items, chars };
}

function raidLine(f, t, name) {
  const lost = (f.stolen || []).length ? `丢的东西：${f.stolen.join('、')}` : '';
  if (f.quiet) return `${t.raid.theft.replace('{{lost}}', '一些东西')}（夜里来的人手很轻）`;
  if (f.band === 'repelled') return t.raid.repelled;
  if (f.band === 'repelled_hurt') return t.raid.repelled_hurt;
  if (f.band === 'theft') return `${t.raid.theft.replace('{{lost}}', lost)}`;
  return `${t.raid.bad.replace('{{lost}}', lost).replace('{{hurt}}', (f.hurt || []).map(name).join('、') || '有人')}`;
}

