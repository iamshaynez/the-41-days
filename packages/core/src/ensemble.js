// 堂屋系统（人物血肉计划 PR2）：同住一屋檐的三个人，该有堂屋的戏。
// 铁律：内核裁决在前——谁进场、说什么话题、这场戏落在哪个结局拍、心情与信任怎么走，
// 全部在场景创建时定死（种子随机，fold 镜像）；LLM 只领台词本（server 侧 ensemble 角色，
// prompts/ensemble.md），离线/越界时 renderEnsembleDirect 用 persona 直读拼装——堂屋永远开演。
import { aliveChars } from './state.js';
import { bumpPairArc } from './causality.js';
import { Rng, hashStr } from './rng.js';

const PAIR_COOLDOWN = 5;     // 同一对子 5 天不连场
const IDLE_CHANCE = 0.3;     // 无债可评的清晨，三成概率出一场随机场
const SHADOW_THRESHOLD = 2;  // 暗账翻过两页，就有人要翻旧账
const BACKLOG_LIMIT = 2;     // 评史债攒过两笔，别的场都得让路

// 正典最硬的几个秘密（封印未开，LLM 说了即废稿；输入侧本就不注入，这是输出侧的闸）
export const ENS_CANON_BAN = ['更籍', '素伯', '白翎', '白衣渡江', '糜芳'];

// 对子键规范化（顺序无关）；堂屋随机走独立派生流（seed+日），
// 不碰主 RNG 游标——晨抽/主线择日/袭击的骰点不受堂屋开演影响。
const pairKeyOf = (ids) => (ids.length >= 2 ? [ids[0], ids[1]].sort().join('|') : null);
const ethicsDist = (a, b) => {
  const ks = ['stealCiv', 'killCiv', 'killEnemy', 'help'];
  return ks.reduce((t, k) => t + Math.abs((a.ethics?.[k] ?? 1) - (b.ethics?.[k] ?? 1)), 0) / ks.length;
};

/** 破晓钩子（toDawn 尾、mainlineTick 后）：一日至多一场 */
export function ensembleTick(ctx) {
  const s = ctx.s;
  if (!ctx.pack?.mainline || s.sidestory || s.over) return;
  if (!s.ensemble) s.ensemble = { scenes: [], coveredSteps: [], pairLast: {} };
  const en = s.ensemble;
  if (en.scenes.some((x) => x.day === s.day)) return;
  const alive = aliveChars(s);
  if (alive.length < 2) return;

  const rng = new Rng(hashStr(`ens|${s.seed}|${s.day}`), 0);
  const scene = pickScene(ctx, rng, alive);
  if (!scene) return;

  // —— 先裁决：结局拍 + 心情/信任微调，此刻全部入账（演出只是把它说出来）——
  for (const [id, d] of Object.entries(scene.outcome.mood || {})) {
    const c = alive.find((x) => x.id === id);
    if (c && d) ctx.mood(c, d, '堂屋');
  }
  for (const p of scene.outcome.pair || []) {
    bumpPairArc(ctx, p.a, p.b, p.w);
    bumpPairArc(ctx, p.b, p.a, p.w); // 堂屋的走近/顶撞是相互的
  }

  en.scenes.push(scene);
  if (scene.topic.stepId) en.coveredSteps.push(scene.topic.stepId);
  const pk = pairKeyOf(scene.participants);
  if (pk) en.pairLast[pk] = s.day;
  ctx.emit('ENSEMBLE_SCENE', { scene: structuredClone(scene) });
  ctx.fact('ensemble', { sceneId: scene.id, day: scene.day, kind: scene.kind, chars: scene.participants, beat: scene.outcome.beat });
}

function pickScene(ctx, rng, alive) {
  const s = ctx.s, en = s.ensemble;
  const cooldownOk = (ids) => { const pk = pairKeyOf(ids); return !pk || (en.pairLast[pk] || -99) < s.day - PAIR_COOLDOWN; };
  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = rng.int(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  /** 领衔对子从冷对里挑：shuffle 切片可能把昨天那对原样切回来（两人局无替补时无解，
   *  有第三人却连日顶同一对是调度漏洞）——先在全员里找一对不在冷却里的做前两位，
   *  余下的人跟在后面；全员皆热（对子用尽）才允许回退原序。 */
  function pickColdPairFirst(rng, en, alive, n, day) {
    const ids = shuffle(alive).map((c) => c.id);
    const cold = (a, b) => (en.pairLast[[a, b].sort().join('|')] || -99) < day - PAIR_COOLDOWN;
    const lead = [];
    for (const a of ids) {
      const b = ids.find((x) => x !== a && cold(a, x));
      if (b) { lead.push(a, b); break; }
    }
    // 三人局的数学极限：三对全在冷却里，无从避让——打上 pairForced，
    // 让"连日同对"从隐性巧合变成显式豁免（测试与演出层都能识别）
    if (!lead.length) return { ids: ids.slice(0, n), forced: true };
    const rest = ids.filter((x) => !lead.includes(x));
    return { ids: [...lead, ...rest].slice(0, Math.max(n, 2)), forced: false };
  }
  const beat = (kind) => {
    const pool = ctx.pack.ensembleTemplates?.beats?.[kind];
    if (!pool?.length) return '话说了，日子照旧。';
    // 近两场用过的拍子先让位（一周目实测：同一结局拍 34 场里出现 7 次，连看三天出戏）；
    // 池子本来就小，滤空了再用全池——节奏让位于确定性
    const recent = en.scenes.slice(-2).map((x) => x.outcome.beat);
    const fresh = pool.filter((b) => !recent.includes(b));
    return (fresh.length ? fresh : pool)[rng.int((fresh.length ? fresh : pool).length)];
  };
  const stepBacklog = (s.mainline || []).filter((m) => m.stepId && !en.coveredSteps.includes(m.stepId));

  // 1 暗面场：暗账过阈的人，旧账要被翻（可压过评史——夜的伤口比朝的新闻急）
  const dark = alive.filter((c) => (s.causality?.shadowTouched?.[c.id] || 0) >= SHADOW_THRESHOLD);
  if (dark.length && stepBacklog.length < BACKLOG_LIMIT) {
    const exposed = dark[0];
    const others = shuffle(alive.filter((c) => c.id !== exposed.id));
    if (others.length && cooldownOk([exposed.id, others[0].id])) {
      const participants = [exposed.id, others[0].id];
      if (others[1] && rng.chance(0.3)) participants.push(others[1].id);
      const heavy = exposed.persona?.shadow?.grade === 'heavy';
      return {
        id: `en_${s.day}_${en.scenes.length + 1}`, day: s.day, kind: 'shadow', participants,
        topic: { exposed: exposed.id },
        outcome: {
          beat: beat('shadow'),
          mood: { [exposed.id]: heavy ? -2 : -1 },
          pair: [{ a: exposed.id, b: others[0].id, w: -0.5 }]
        }
      };
    }
  }

  // 2 交心场：崩溃链上/心绪见底的人，得有人陪（+2 救急——堂屋的心情账救急不添堵）
  const low = alive.find((c) => c.breakdown || (c.moodPts ?? 0) <= -12);
  if (low && stepBacklog.length < BACKLOG_LIMIT) {
    // 陪的人优先挑冷对（刚同过场的两人次日又面对面，避让不开才退回第一位）
    const cand = shuffle(alive.filter((c) => c.id !== low.id));
    const partner = cand.find((c) => cooldownOk([low.id, c.id])) || cand[0];
    if (partner) {
      return {
        id: `en_${s.day}_${en.scenes.length + 1}`, day: s.day, kind: 'bond',
        participants: [low.id, partner.id],
        topic: { low: low.id },
        outcome: { beat: beat('bond'), mood: { [low.id]: 2 }, pair: [{ a: low.id, b: partner.id, w: 1 }] }
      };
    }
  }

  // 3 评史场：欠下的主线步，必有人评（一日一步，攒过两笔别的场让路）
  if (stepBacklog.length) {
    const entry = stepBacklog[stepBacklog.length - 1];
    const n = alive.length >= 3 && rng.chance(0.4) ? 3 : Math.min(2, alive.length);
    const pick = pickColdPairFirst(rng, en, alive, n, s.day);
    const participants = pick.ids;
    return {
      id: `en_${s.day}_${en.scenes.length + 1}`, day: s.day, kind: 'comment', participants, pairForced: pick.forced,
      topic: { stepId: entry.stepId, stepDay: entry.day },
      outcome: {
        beat: beat('comment'),
        mood: {},
        pair: participants.length >= 2 ? [{ a: participants[0], b: participants[1], w: 0.5 }] : []
      }
    };
  }

  // 4~5 随机场：三成概率开张
  if (rng.chance(IDLE_CHANCE)) {
    // 4 伦理争执：两种活法顶到一处（如江鳅×薄姑）
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        if (ethicsDist(a, b) > 0.3 && cooldownOk([a.id, b.id])) {
          return {
            id: `en_${s.day}_${en.scenes.length + 1}`, day: s.day, kind: 'friction',
            participants: [a.id, b.id],
            topic: { clash: [a.id, b.id] },
            // 争执只伤落败的一方（rng 定输家）——两人都塌，堂屋就成了塌方现场
            outcome: { beat: beat('friction'), mood: { [rng.chance(0.5) ? a.id : b.id]: -1 }, pair: [{ a: a.id, b: b.id, w: -0.5 }] }
          };
        }
      }
    }
    // 5 闲话场
    if (rng.chance(0.6)) {
      const n = alive.length >= 3 && rng.chance(0.5) ? 3 : Math.min(2, alive.length);
      const pick = pickColdPairFirst(rng, en, alive, n, s.day);
      const participants = pick.ids;
      const lucky = participants[rng.int(participants.length)];
      return {
        id: `en_${s.day}_${en.scenes.length + 1}`, day: s.day, kind: 'idle', participants, pairForced: pick.forced,
        topic: {},
        outcome: {
          beat: beat('idle'),
          mood: { [lucky]: 1 },
          pair: participants.length >= 2 ? [{ a: participants[0], b: participants[1], w: 0.5 }] : []
        }
      };
    }
  }
  return null;
}

// —— LLM 台词校验（server 在落库前执行；三道闸：归属/句数/封印禁词） ——
export function validateEnsemble(scene, out, pack = null) {
  const reasons = [];
  if (!out || typeof out !== 'object') return { ok: false, reasons: ['输出不是对象'] };
  const lines = out.lines;
  if (!Array.isArray(lines) || lines.length < 3 || lines.length > 10) reasons.push('台词数量须在 3~10 句');
  const allowed = new Set(scene.participants);
  const byName = pack ? Object.fromEntries(Object.entries(pack.charMap).filter(([, d]) => allowed.has(d.id)).map(([, d]) => [d.name, d.id])) : {};
  const seen = new Set();
  const clean = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    if (!l || typeof l.char !== 'string' || !l.char) { reasons.push('台词缺归属'); continue; }
    const id = allowed.has(l.char) ? l.char : byName[l.char]; // id 直传或显示名都认，场外人一句不说
    if (!id) { reasons.push(`台词归属越界（${l.char}）`); continue; }
    const t = String(l.text || '').trim();
    if (t.length < 2 || t.length > 150) { reasons.push('台词长度出界'); continue; }
    if (ENS_CANON_BAN.some((w) => t.includes(w))) { reasons.push('台词触碰封印禁词'); continue; }
    seen.add(id);
    clean.push({ char: id, text: t });
  }
  for (const p of scene.participants) if (!seen.has(p)) reasons.push(`有人整场没开口（${p}）`);
  if (out.narration != null && String(out.narration).length > 160) reasons.push('旁白过长');
  return { ok: !reasons.length, reasons, lines: clean };
}

/** 直读拼装（LLM 离线/越界的兜底）：persona.voice/stances/descent 按日轮转取句，落内核定的结局拍 */
export function renderEnsembleDirect(scene, pack) {
  const defs = scene.participants.map((id) => pack.charMap[id]).filter(Boolean);
  const names = defs.map((d) => d.name).join('、');
  const step = scene.topic?.stepId ? pack.mainline?.steps.find((x) => x.id === scene.topic.stepId) : null;
  let topic = '城里的近事';
  if (step) topic = `「${step.title}」——${step.anchor}`;
  else if (scene.kind === 'bond') topic = '这些天压在心上的事';
  else if (scene.kind === 'shadow') topic = '一桩没人提过的旧账';
  else if (scene.kind === 'friction') topic = '两种活法';
  const narration = ((pack.ensembleTemplates?.open?.[scene.kind] || '{{names}}说了会儿话。')
    .replace('{{names}}', names).replace('{{topic}}', topic)) + ' ' + scene.outcome.beat;

  const lines = defs.map((d, i) => {
    const p = d.persona || {};
    let pool = p.voice || [];
    if (scene.kind === 'comment' && step?.act) pool = p.stances?.[step.act] ? [p.stances[step.act], ...(p.voice || [])] : (p.voice || []);
    if (scene.kind === 'friction') pool = [...(p.shadow?.descent || []), ...(p.voice || [])];
    if (scene.kind === 'shadow') pool = [...(p.shadow?.descent || []), ...(p.shadow?.redemption || []), ...(p.voice || [])];
    if (scene.kind === 'bond') pool = [...(p.shadow?.redemption || []), ...(p.voice || [])];
    const text = pool.length ? pool[(scene.day + i) % pool.length] : '……';
    return { char: d.id, text };
  });
  return { lines, narration };
}
