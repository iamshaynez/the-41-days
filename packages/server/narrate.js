// 直读叙事器 + 世界简报（技术架构 §7.2 降级路径）：把 facts 渲染成文字，与 LLM 叙事者同一输入。
import { moodLevel, HUNGER_NAMES, HARM_NAMES, SICK_NAMES, FATIGUE_NAMES, aliveChars, charById, policyOf } from '../core/index.js';

const weatherName = { clear: '晴', fog: '雾', rain: '雨', snow: '雪', cold: '严寒' };

/** 世界简报（裁判/叙事者共享的只读上下文） */
export function worldBrief(state, pack) {
  const chars = aliveChars(state).map((c) =>
    `${c.name}(${c.id})：饥饿${HUNGER_NAMES[c.hunger]}${c.wound ? `/${HARM_NAMES[c.wound]}` : ''}${c.sick ? `/${SICK_NAMES[c.sick]}` : ''}${c.fatigue ? `/${FATIGUE_NAMES[c.fatigue]}` : ''}/心情${moodLevel(c.moodPts).name}/行动力${c.ap}`
  ).join('；');
  const inv = Object.entries(state.inventory).map(([k, v]) => `${pack.itemMap[k]?.name || k}×${v}`).join('、') || '空';
  const locs = state.knownLocs.map((id) => `${pack.locMap[id]?.name || id}(${id})`).join('、');
  const ev = state.activeEvent ? `（门口有未决事件：${pack.cardMap[state.activeEvent.cardId]?.title}）` : '';
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
  return `第${state.day}天/${weatherName[state.weather]}/${state.phase === 'day' ? '白天' : state.phase === 'dusk' ? '黄昏' : state.phase === 'night' ? '深夜' : '破晓'}${state.winterActive ? '/冬季' : ''}。队伍：${chars}。库存：${inv}。已知地点：${locs}。${polTxt}${state.franko ? '船牙鲁舟在门外的渡口边摆摊。' : ''}${ev}${night}${sealNote}${dirTxt}`;
}

/** 直读渲染：facts → 模板文（每条 fact 至少一行；缺模板时用通用行） */
export function renderDirect(state, facts, pack) {
  const t = pack.narrations;
  const lines = [];
  const name = (id) => charById(state, id)?.name || id;
  for (const f of facts) {
    switch (f.k) {
      case 'run_started': lines.push(`第 1 天。${t.dawn.header.replace('{{day}}', 1).replace('{{weather}}', '围城第 9 天')}——你们住进了橘里九号。${f.chars}，三个名字写在了门后的墙上。`); break;
      case 'prologue_start': lines.push('在这一切之前——降卒进城的那天。'); break;
      case 'prologue_beat': lines.push(`——${f.title}——`); break;
      case 'prologue_end': lines.push('序章读完。从今天起，每一天都是你们的了。'); break;
      case 'in_prologue': lines.push('（先把这一拍读完，再选。）'); break;
      case 'phase_day': lines.push(`天亮了。第 ${f.day} 天，${weatherName[f.weather]}。该干的活，等着人。`); break;
      case 'phase_dusk': lines.push(t.phase.to_dusk); break;
      case 'eat': lines.push(t.eat[f.item === 'meal' ? 'meal' : 'raw'].replace('{{name}}', name(f.char))); break;
      case 'cook': lines.push(t.cook); break;
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
      case 'night_search_hit': lines.push(t.night.search_hit.replace('{{loot}}', (f.items || []).map((g) => `${pack.itemMap[g.item]?.name || g.item}×${g.n}`).join('、'))); break;
      case 'night_no': lines.push(f.msg ? `（${f.msg}）` : '……'); break;
      case 'night_unlock': lines.push(f.quiet ? '锁簧轻轻让开了。' : '撬棍闷响一声，锁开了。'); break;
      case 'night_noise_alert': lines.push(t.night.noise); break;
      case 'lockpick_broke': lines.push('拨针断在锁眼里。'); break;
      case 'night_drop': lines.push(`背不动了，${pack.itemMap[f.item]?.name || f.item}被留在了原地。`); break;
      case 'night_end': lines.push(`天边泛灰，该回去了。背回来了 ${f.carried} 件东西。`); break;
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
      case 'option_unavailable': lines.push('（做不到——条件不够）'); break;
      // —— v2 管家与决策点 ——
      case 'auto_day_start': lines.push('他们没有等你一一吩咐。新的一天，各忙各的去了。'); break;
      case 'policy_set': {
        const txt = f.key === 'rationing' ? (f.value ? '记下了：以后省着吃，先紧着真正饿的人。' : '记下了：恢复正常吃饭，别让人饿着。')
          : f.key === 'nightApproach' ? (f.value === 'cautious' ? '记下了：夜里小心些，不出声。' : f.value === 'bold' ? '记下了：夜里放手干。' : '记下了：夜里照常。')
          : f.key === 'feeding' ? (f.value === 'manual' ? '记下了：吃饭的事你亲自管。' : '记下了：吃饭的事他们自己张罗。')
          : '记下了。';
        lines.push(txt); break;
      }
      case 'night_fork': lines.push(f.text || '前面有个岔子，等你拿主意。'); break;
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
  }
  return lines.filter(Boolean).join('\n');
}

function raidLine(f, t, name) {
  const lost = (f.stolen || []).length ? `丢的东西：${f.stolen.join('、')}` : '';
  if (f.quiet) return `${t.raid.theft.replace('{{lost}}', '一些东西')}（夜里来的人手很轻）`;
  if (f.band === 'repelled') return t.raid.repelled;
  if (f.band === 'repelled_hurt') return t.raid.repelled_hurt;
  if (f.band === 'theft') return `${t.raid.theft.replace('{{lost}}', lost)}`;
  return `${t.raid.bad.replace('{{lost}}', lost).replace('{{hurt}}', (f.hurt || []).map(name).join('、') || '有人')}`;
}
