// 结局复盘（因果引擎-v0.1 §5/CY-33、人物设计 §6/EPI-01）：
// 从因果账提取"这一局的完整故事线 + 人的账"，供回忆录 LLM 展开或直读模板渲染。
// 铁律（N-02）：这里的每个字都必须能在 entries/deeds 里找到出处——内核只整理事实。
import { aliveChars, charById } from './state.js';
import { VERBS, valenceOf, charArc, pairStage, stageOf, alienated, STAGE_NAMES } from './causality.js';

const NPC_NAMES = {
  neighbor: '门口的人', deserter: '那个逃兵', priest: '守藏吏', tamara: '杜仲',
  m_looter: '南市的溃兵', franko: '鲁舟', yura: '阿禾', home: '这个家',
  player: '你们', world: '战争', stranger: '陌生人'
};

function nameOf(state, pack, id) {
  if (!id) return '没人';
  const c = state.chars.find((x) => x.id === id);
  if (c) return c.name;
  if (NPC_NAMES[id]) return NPC_NAMES[id];
  return pack.locMap[id]?.name || id;
}

/** 节拍文本（BEAT）：一条因果 → 一句可以进回忆录的话 */
function beatText(state, pack, e, nth) {
  const actor = nameOf(state, pack, e.actor);
  const target = nameOf(state, pack, e.target);
  switch (e.verb) {
    case 'deny_food': return `柜子里还有粮，${target}却饿着${nth > 1 ? `——第 ${nth} 次了` : ''}。`;
    case 'burn_book': return '一册书进了炉子。';
    case 'heal': return `${actor}给${target}换了药。`;
    case 'comfort': return `${actor}陪${target}坐了一会儿。`;
    case 'help': return e.target === 'deserter' ? '你收留了那个逃兵。' : `你帮了${target}。`;
    case 'donate': return `你把药给了${target}。`;
    case 'refuse_help': return `你对${target}说了"不行"。`;
    case 'kill_civ': return `${e.via ? nameOf(state, pack, e.via) : actor}杀了${target}。屋里的人后来都知道了。`;
    case 'kill_enemy': return `${e.via ? nameOf(state, pack, e.via) : actor}结果了${target}。`;
    case 'steal_civ': return `你拿了${target}的东西。`;
    case 'volunteer': return `${actor}去了${target}。`;
    case 'play_music': return `琴响了，是${actor}鼓的。`;
    case 'trade_evidence': return '一份纸换成了物资。鲁舟的收价高得反常。';
    case 'witness_death': return `${target}死了${e.note ? `（${e.note}）` : ''}。`;
    case 'launch_lighthouse': return '你把真相送上了北津台的烽火。';
    case 'join_table': return '你收下了符传。沉默有了价格。';
    case 'refuse_table': return '鲁舟的提议被你退了回去。';
    case 'guard_night': return `${actor}守了一夜。`;
    case 'listen_radio': return null; // 太轻，不进故事线
    case 'feed': return null;
    default: return null;
  }
}

/** 连日复发的塌缩文案： range 拍自带天数，渲染时不再加前缀 */
function rangedText(state, pack, b) {
  const joinNames = (ids) => {
    const names = ids.map((id) => nameOf(state, pack, id));
    return names.length === 2 ? names.join('和') : names.join('、');
  };
  switch (b.verb) {
    case 'deny_food': return `第 ${b.day}～${b.dayEnd} 天，柜子里一直是有粮的，${joinNames(b.targets)}一直在饿。`;
    case 'volunteer': return `第 ${b.day}～${b.dayEnd} 天，${joinNames(b.targets)}，去的人都是同一个。`;
    case 'guard_night': return `第 ${b.day}～${b.dayEnd} 天，守夜的都是同一个人。`;
    default: return `第 ${b.day}～${b.dayEnd} 天，${b.text || ''}（一连 ${b.count} 天）`;
  }
}

/** 读数 → 人话（CY-40：复盘不报数，报感受） */
function readWord(score) {
  if (score >= 3) return '铭记';
  if (score >= 1) return '感激';
  if (score > -1) return '掠过';
  if (score > -3) return '刺痛';
  return '无法释怀';
}

/**
 * 提取结局复盘。
 * @returns {{days, title, beats[], chains, pairLines, charLines, epilogues, stats}}
 */
export function buildStoryline(state, pack) {
  const s = state, cz = s.causality || { entries: [], pairArcs: {}, charArcs: {} };
  const roster = s.chars.map((c) => c.id);

  // —— 故事线节拍：先按"动词+对象"把连日复发塌缩成 range 拍，再按天落轴 ——
  // （塌缩只动呈现：天数、次数、人名全部来自 entries，N-02 不变形）
  const raw = [];
  const prologue = []; // 序章拍（围城头九天）：不进按天塌缩，单独成段
  const nthMap = new Map(); // deny_food 累计次数（"第 n 次"）
  for (const e of cz.entries) {
    const key = `${e.verb}|${e.target}`;
    nthMap.set(key, (nthMap.get(key) || 0) + 1);
    const text = beatText(s, pack, e, nthMap.get(key));
    if (!text || e.weight < 1) continue;
    if (e.tags?.includes('prologue')) { prologue.push({ day: e.day, verb: e.verb, text }); continue; }
    raw.push({ day: e.day, verb: e.verb, target: e.target, actor: e.actor, text, weight: e.weight });
  }
  // 连日复发检测：同动词（deny_food 跨角色合并）连续 ≥3 天 → 一拍
  const MERGE_TARGETS = new Set(['deny_food']);
  const groups = new Map();
  for (const b of raw) {
    const gk = MERGE_TARGETS.has(b.verb) ? b.verb : `${b.verb}|${b.target}`;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(b);
  }
  const ranged = [], singles = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.day - b.day);
    let run = [];
    const flushRun = () => {
      if (run.length >= 3) {
        const days = [...new Set(run.map((b) => b.day))];
        ranged.push({
          day: days[0], dayEnd: days[days.length - 1], verb: run[0].verb,
          targets: [...new Set(run.map((b) => b.target))], actor: run[0].actor,
          count: run.length, ranged: true, weight: Math.max(...run.map((b) => b.weight))
        });
      } else singles.push(...run);
      run = [];
    };
    for (const b of list) {
      if (run.length && b.day - run[run.length - 1].day > 1) flushRun();
      run.push(b);
    }
    flushRun();
  }
  for (const r of ranged) r.text = rangedText(s, pack, r);
  const all = [...singles, ...ranged].sort((a, b) => a.day - b.day || b.weight - a.weight);
  const byDayCapped = [];
  const dayCount = new Map();
  for (const b of all) {
    const n = dayCount.get(b.day) || 0;
    if (n >= 2 && !b.ranged) continue;
    dayCount.set(b.day, n + 1);
    byDayCapped.push(b);
  }
  const capped = byDayCapped.slice(0, 26); // 篇幅阀

  // —— 人的账（chains）：每人最重的三条 + 他读作什么 ——
  const chains = {};
  for (const id of roster) {
    const cname = s.chars.find((x) => x.id === id)?.name || id;
    const mine = cz.entries
      .filter((e) => (e.witnesses.includes(id) || e.target === id || e.actor === id || e.via === id)
        && e.weight >= 1 && beatText(s, pack, e, 1))
      .map((e) => {
        const c = s.chars.find((x) => x.id === id);
        const read = valenceOf(pack, c, e) * e.weight * (e.target === id ? 1.5 : 1);
        let text = beatText(s, pack, e, 1);
        // 死亡的措辞因人而异：自己的账停了，别人的死是"你在场"
        if (e.verb === 'witness_death' && e.target === id) text = '账停在了这一天。';
        else if (e.verb === 'witness_death') text = `${nameOf(s, pack, e.target)}死的那天，${cname}在。`;
        return { day: e.day, text, read: readWord(read), score: Math.abs(read), death: e.verb === 'witness_death', verbKey: e.verb };
      })
      .sort((a, b) => b.score - a.score);
    // 死亡至多一条；同动词不重复——沉重与单调都不该把别的账挤出去
    const picked = [];
    for (const m of mine) {
      if (m.death && picked.some((p) => p.death)) continue;
      if (picked.some((p) => p.verbKey === m.verbKey)) continue;
      picked.push(m);
      if (picked.length >= 3) break;
    }
    chains[id] = picked;
  }

  // —— 弧线终态 ——
  const pairLines = [];
  const seen = new Set();
  for (const [k, arc] of Object.entries(cz.pairArcs)) {
    const [a, b] = k.split('|');
    if (seen.has([b, a].join('|')) || !pack.charMap[a] || !pack.charMap[b]) continue;
    const stage = Math.max(pairStage(s, a, b), pairStage(s, b, a));
    if (stage >= 2) {
      pairLines.push(`${nameOf(s, pack, a)}与${nameOf(s, pack, b)}：${STAGE_NAMES[stage]}。`);
      seen.add(k);
    }
  }
  const charLines = [];
  for (const c of s.chars) {
    const arc = charArc(s, c.id);
    const lines = [];
    const guards = cz.entries.filter((e) => e.verb === 'guard_night' && e.actor === c.id).length;
    if (guards >= 3) lines.push(`${c.name}守了 ${guards} 个夜。`);
    const outs = cz.entries.filter((e) => e.verb === 'volunteer' && e.actor === c.id).length;
    if (outs >= 3) lines.push(`${c.name}出了 ${outs} 次门。`);
    const stage = stageOf(arc.pos);
    if (c.alive && alienated(s, c.id)) lines.push(`${c.name}不再把心里话给你。（离心）`);
    else if (stage >= 2) lines.push(`${c.name}信你。（${STAGE_NAMES[stage]}）`);
    if (c.antonStruck) lines.push('文简的生日账上，没有你的名字。');
    if ((arc.privateLedger || []).length) lines.push(`${c.name}的私人账本：${arc.privateLedger.length} 条。`);
    charLines.push(...lines);
  }

  // —— 后日谈种子（EPI-01：方向 + 最强链 + 人格锚点）——
  const DEED_W = { kill_civ: -6, steal_civ: -3, kill_enemy: -2, help: 3, donate: 4 };
  const epilogues = s.chars.map((c) => {
    const deeds = s.deeds.filter((d) => d.actor === c.id);
    let score = 0;
    for (const d of deeds) score += DEED_W[d.type] || 0;
    const stage = stageOf(charArc(s, c.id).pos);
    const top = chains[c.id]?.[0];
    const dir = !c.alive ? 'fallen'
      : score <= -6 ? 'haunted'
      : stage >= 2 && score >= 0 ? 'honored'
      : 'survived';
    return {
      id: c.id, name: c.name, alive: c.alive, direction: dir,
      epithet: c.persona?.epithet || '', knot: c.persona?.knot || '',
      topChain: top ? `第 ${top.day} 天，${top.text}` : null,
      deathDay: !c.alive ? (s.deeds.find((d) => d.actor === c.id && d.type === 'died')?.day ?? s.day) : null
    };
  });

  const title = { ceasefire: '开城', maicheng: '开城 · 麦城得脱', pyrrhic: '惨胜', alt_both: '另一种三国', contract_end: '交割日', lighthouse: '还师', join_table: '出江陵记' }[s.war.endingType] || '无人幸免';
  // 野史页（正典圣经-v0.2 §8.5 文体规范：史书体、冷、短，批注=老年阿禾）
  const ANNALS = {
    maicheng: { text: '建安二十四年十二月，羽自麦城走房陵，得脱。吴尽得荆州。', note: '你救下的不是荆州，是一个人的命。这座城的交割一天都没有推迟。' },
    pyrrhic: { text: '建安二十四年闰十月，吕蒙围江陵，六日不拔。关羽还师击之，吴人退。是岁，江陵大饥。', note: '守住的城和开过的城，账本不一样，死人一样多。' },
    alt_both: { text: null, note: '那年秋天，门没有开，将军没有死。后来他们还是死了——不过，是后来的事。' }
  };
  const annals = ANNALS[s.war.endingType] ? [{ ...ANNALS[s.war.endingType], ending: s.war.endingType }] : [];
  return {
    days: s.day, title, annals,
    arrival: `第 1 天，${s.chars.map((c) => c.name).join('、')}住进了橘里九号。`,
    prologue,
    beats: capped,
    chains, pairLines, charLines, epilogues,
    // 已显形的真相（封印注入协议：只有解锁的才进回忆录上下文）
    seals: (s.seals || []).map((id) => pack.sealMap?.[id]).filter(Boolean).map((x) => ({ layer: x.layer, text: x.text })),
    stats: {
      entries: cz.entries.length, docs: s.docsSeen.length, knowledge: s.knowledge,
      guards: cz.entries.filter((e) => e.verb === 'guard_night').length,
      helps: cz.entries.filter((e) => e.verb === 'help' || e.verb === 'donate').length,
      refusals: cz.entries.filter((e) => e.verb === 'refuse_help').length,
      // 管家代执行的账目：玩家没逐句吩咐，但规矩是他立的
      delegated: cz.entries.filter((e) => e.delegated).length
    }
  };
}

// —— 直读回忆录（LLM 离线时的完整演出层；与 LLM 共用同一份 storyline 事实）——
export function renderMemoirDirect(story, pack) {
  const out = [];
  out.push(`—— 故事线 ——`);
  out.push(story.arrival);
  for (const b of story.prologue || []) out.push(`围城那些天，${b.text}`);
  if (story.prologue?.length) out.push('');
  for (const b of story.beats) out.push(b.ranged ? b.text : `第 ${b.day} 天，${b.text}`);
  out.push('');
  out.push('—— 人的账 ——');
  for (const ep of story.epilogues) {
    const chs = story.chains[ep.id] || [];
    for (const ch of chs.slice(0, 2)) out.push(`${ep.name}${ch.read}的：第 ${ch.day} 天，${ch.text}`);
  }
  for (const l of story.pairLines) out.push(l);
  for (const l of story.charLines) out.push(l);
  out.push('');
  out.push('—— 后日谈 ——');
  for (const ep of story.epilogues) {
    if (ep.direction === 'fallen') {
      out.push(`${ep.name}没能撑过去。第 ${ep.deathDay} 天，橘里的墙上多了一个名字。${ep.knot ? `没放下的：${ep.knot}。` : ''}`);
    } else if (ep.direction === 'haunted') {
      out.push(`${ep.name}活下来了。但有些夜晚会突然惊醒${ep.topChain ? `——${ep.topChain}` : '，手先于他摸向不存在的刀'}。`);
    } else if (ep.direction === 'honored') {
      out.push(`${ep.name}活下来了${ep.epithet ? `（${ep.epithet}）` : ''}。${ep.topChain ? `这一局最重的一笔：${ep.topChain}。` : ''}战争结束后很久，还有人敲他家的门——为了道谢。`);
    } else {
      out.push(`${ep.name}活下来了。就是活下来了。在这个年头，这四个字已经够写一整页。`);
    }
  }
  if (story.annals?.length) {
    out.push('');
    out.push('—— 野史 ——');
    for (const a of story.annals) {
      if (a.text) out.push(a.text);
      out.push(`批注：${a.note}`);
    }
  }
  out.push('');
  out.push(`—— 卷尾 ——`);
  const st = story.stats;
  out.push(`这一局 ${story.days} 天，记账 ${st.entries} 笔：帮过 ${st.helps} 次，拒绝过 ${st.refusals} 次，守夜 ${st.guards} 班。`);
  if (st.delegated > 0) out.push(`其中 ${st.delegated} 笔，你没有逐句吩咐——你立了规矩，他们照办的。账，还是你的。`);
  if (story.seals?.length) out.push(`你揭开了 ${story.seals.length} 层真相。`);
  out.push(`带走 ${st.docs} 份纸、${st.knowledge} 点知晓。兰台收录了这一切——下一局，江陵会记得。`);
  return out.join('\n');
}

// —— N-02 事实校验（回忆录 LLM 输出的底线闸）：违规即回退直读 ——
export function memoirLint(text, story, pack) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 80 || t.length > 2400) return false;
  if (t.includes('{{') || t.includes('}}')) return false;
  // 提到的天数不得超出本局（防"第 99 天"式幻觉）
  for (const m of t.matchAll(/第\s*(\d+)\s*天/g)) {
    if (Number(m[1]) > story.days) return false;
  }
  // 至少写到两名队员（防跑题）
  const names = story.epilogues.map((e) => e.name);
  if (names.filter((n) => t.includes(n)).length < Math.min(2, names.length)) return false;
  return true;
}
