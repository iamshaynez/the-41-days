// 跨周目回响（长线体验-v0.2 §3.3 EC 系）：档案馆读侧/写侧的纯函数化封装。
// 从 index.js 抽出以便单测：collectEchoes 负责"新局开局装配"，archiveOutcome 负责"局终入档"。
import { missedPoolLocs } from '../core/index.js';

/** 开局装配：档案馆里有什么，新局就从什么里长出来（含遗愿递减副作用） */
export function collectEchoes(db, userId) {
  const arch = db.archiveAll(userId);
  const echoes = {};
  if (arch.find((e) => e.kind === 'echo' && e.key === 'join_table_dark')) echoes.joinTableDark = true;
  const capsules = arch.filter((e) => e.kind === 'capsule').map((e) => ({ key: e.key, ...e.data }));
  if (capsules.length) echoes.capsules = capsules;
  // 遗愿（EC-03）：新局开启占一格额度；三局未清偿 → 入档「未完成」
  const wish = arch.find((e) => e.kind === 'wish' && e.data.status === 'active');
  if (wish) {
    const left = (wish.data.runsLeft ?? 3) - 1;
    if (left < 0) db.archivePut(userId, 'wish', wish.key, { ...wish.data, status: 'expired' }, wish.first_run_id);
    else {
      db.archivePut(userId, 'wish', wish.key, { ...wish.data, runsLeft: left }, wish.first_run_id);
      echoes.wish = { key: wish.key, charId: wish.data.charId, charName: wish.data.charName };
    }
  }
  if (arch.some((e) => e.kind === 'closure' && e.key === 'closed')) echoes.closureClosed = true;
  // 或然亲和（v0.3.1）：完结过的周目折算成新局的"读城"底子——开局知晓度+2/局，
  // 杠杆卡的知晓度门槛-2/局（上限 3 局）。档案馆的记忆就是玩家的记忆。
  const done = db.listRuns(userId).filter((r) => r.status === 'ended').length;
  if (done > 0) echoes.boon = Math.min(done, 3);
  // 池回声（城市扩展后续）：最新一局说了算——它没去成的池成员，牵引新局补缺；
  // 它走全了（或旧版档没有池账），牵引就翻篇。只认池内成员，脏数据在 pickLocPools 处拦。
  const lastRun = [...arch].reverse().find((e) => e.kind === 'run_memory');
  const lastMissed = Array.isArray(lastRun?.data.missedLocs) ? lastRun.data.missedLocs.filter(Boolean) : [];
  if (lastMissed.length) echoes.missedLocs = lastMissed;
  return Object.keys(echoes).length ? echoes : null;
}

/** 局终入档：run_memory + 史册格野史 + 回响（出江陵）+ 遗愿生成/兑现 */
export function archiveOutcome(db, userId, runId, st, pack = null) {
  db.archivePut(userId, 'run_memory', runId, {
    day: st.day, ending: st.ending?.type || 'wiped',
    survivors: st.chars.filter((c) => c.alive).map((c) => c.name),
    fallen: st.chars.filter((c) => !c.alive).map((c) => c.name),
    threeThings: st.ending?.threeThings || [], docs: st.docsSeen, knowledge: st.knowledge,
    storyline: st.ending?.storyline || null, memoir: st.ending?.memoir || null,
    // 池回声：这一世没去成的（落选在前、失约在后）——下一世补缺与旧梦风闻的原料
    ...(pack ? { missedLocs: missedPoolLocs(st, pack) } : {})
  }, runId);
  // 史册格·野史栏（EPI-06）：或然/叠加结局的一页野史入馆
  for (const a of st.ending?.storyline?.annals || []) {
    db.archivePut(userId, 'annal', a.ending, { ...a, day: st.day }, runId);
  }
  // 信史墙（史实共振）：本局亲历的正史引文入馆——跨局集史源，key=步 id 天然去重合并。
  // 档案馆集齐一幕的引文点亮一幕之印（见 web 档案馆「信史墙」）
  if (pack?.mainline) {
    const stepMap = Object.fromEntries((pack.mainline.steps || []).map((x) => [x.id, x]));
    for (const m of st.mainline || []) {
      const stp = m.stepId ? stepMap[m.stepId] : null;
      if (stp?.cite) {
        db.archivePut(userId, 'cite', stp.id, {
          text: stp.cite.text, src: stp.cite.src, gloss: stp.cite.gloss || null,
          title: stp.title, track: stp.track || null, act: stp.act || null, day: m.day,
          seenRuns: [runId]
        }, runId);
      }
    }
  }
  // 别传通关册（CH-03）：本地记录，不攀比
  if (st.sidestory) {
    db.archivePut(userId, 'sidestory', st.sidestory.id, {
      title: st.sidestory.title, ending: st.ending?.storyline?.title || '', day: st.day
    }, runId);
  }
  // 回响：出江陵记——商路从此认得你
  if (st.ending?.type === 'join_table') {
    db.archivePut(userId, 'echo', 'join_table_dark', { text: '船还给你留着。' }, runId);
  }
  // 遗愿兑现先于生成：这一局有人替他送到了，就不再开新的一张
  if (st.eventFlags?.wish_fulfilled) {
    const w = db.archiveAll(userId).find((e) => e.kind === 'wish' && e.data.status === 'active');
    if (w) db.archivePut(userId, 'wish', w.key, { ...w.data, status: 'fulfilled', fulfilledRun: runId }, w.first_run_id);
  }
  // 遗愿生成：角色死亡且非全灭，且没有在办遗愿 → 一张（同时至多一张在办）
  if ((st.ending?.type || 'wiped') !== 'wiped') {
    const fallen = st.chars.filter((c) => !c.alive);
    const activeWish = db.archiveAll(userId).find((e) => e.kind === 'wish' && e.data.status === 'active');
    if (fallen.length && !activeWish) {
      const c = fallen[0];
      db.archivePut(userId, 'wish', `${c.id}@${runId}`, {
        charId: c.id, charName: c.name,
        text: `${c.name}没寄出的信，还在驿亭的死信库里。`,
        status: 'active', runsLeft: 3
      }, runId);
    }
  }
}

// ——— 守望期两件（长线体验-v0.2 §3.6 + EX-01）：合上兰台 与 回忆录成册 ———

/** 谢幕条件（§3.6）：文档全收集 + 《还师》与《出江陵记》各一次 + 回忆录 ≥10 章 */
export function closureStatus(entries, pack) {
  const docs = entries.filter((e) => e.kind === 'doc').length;
  const runs = entries.filter((e) => e.kind === 'run_memory').map((e) => e.data);
  const endings = new Set(runs.map((r) => r.ending));
  const memoirs = runs.filter((r) => r.memoir).length;
  const total = pack.docs.length;
  const available = docs >= total && endings.has('lighthouse') && endings.has('join_table') && memoirs >= 10;
  const done = entries.some((e) => e.kind === 'closure' && e.key === 'closed');
  return { available, done, progress: { docs, total, memoirs, lighthouse: endings.has('lighthouse'), joinTable: endings.has('join_table') } };
}

/** 回忆录成册（EX-01 导出）：档案馆里的回忆录按时间装订成一本纯文本小书 */
export function composeMemoirBook(entries, playerName) {
  const runs = entries.filter((e) => e.kind === 'run_memory' && e.data.memoir)
    .map((e) => ({ at: e.at, ...e.data }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const lines = [];
  lines.push('《我的江陵》');
  lines.push(`——${playerName} 的第 41 天回忆录`);
  lines.push('');
  lines.push(`共 ${runs.length} 章。每一章都是一局，每一句都真发生过。`);
  lines.push('');
  runs.forEach((r, i) => {
    lines.push(`—— 第 ${i + 1} 章 · ${r.day} 天的一局 ——`);
    lines.push('');
    lines.push(String(r.memoir).trim());
    lines.push('');
  });
  lines.push('（兰台装订。江陵会记得。）');
  return lines.join('\n');
}
