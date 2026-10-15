// 地点解锁与周目池（城市扩展 v0.30.0）：路要人带、门要图开、一周目去不全城。
// 纯函数：全部判定读 state（locState.firstVisit / eventFlags / docsSeen / day / locPool）。
import { Rng, hashStr } from './rng.js';

/** 夜访过此地（startNight 建档、收工落 firstVisit=false） */
export function locVisited(s, id) {
  const st = s.locState?.[id];
  return !!st && st.firstVisit === false;
}

/** 条件组判定（requires 与 heardWhen 共用）：组内各类 AND，visitedAny 内 OR */
export function condMet(s, cond = {}) {
  if (cond.minDay && s.day < cond.minDay) return false;
  if (cond.flags && !cond.flags.every((f) => s.eventFlags?.[f])) return false;
  if (cond.docs && !cond.docs.every((d) => (s.docsSeen || []).includes(d))) return false;
  if (cond.visitedAll && !cond.visitedAll.every((id) => locVisited(s, id))) return false;
  if (cond.visitedAny && !cond.visitedAny.some((id) => locVisited(s, id))) return false;
  return true;
}

/** 本局入池了吗：无池组的地点恒真；有池组的只认 locPool 里的那一个 */
export function locInPool(s, pack, id) {
  for (const p of pack.manifest.locationPools || []) {
    if (p.members.includes(id)) return s.locPool?.[p.group] === id;
  }
  return true;
}

/** 解锁条件齐了吗（含池裁剪与旧 intelUnlock 旗标口径） */
export function unlockMet(s, pack, loc) {
  if (!locInPool(s, pack, loc.id)) return false;
  if (loc.intelUnlock) return !!s.eventFlags?.[loc.intelUnlock];
  if (!loc.requires) return true;
  return condMet(s, loc.requires);
}

/** 风闻条件（上图灰名带提示，尚不可去） */
export function heardMet(s, pack, loc) {
  if (!locInPool(s, pack, loc.id)) return false;
  if (!loc.heardWhen) return false;
  return condMet(s, loc.heardWhen);
}

/** 开局掷池：每组抽 pick 个。派生种子（异或组名哈希），不耗主 rng cursor——
 *  回放与既有属性测试的随机流一寸不动。
 *  池回声：上一世错过的成员（echoes.missedLocs）确定性补位——缘分回来，换什么种子都回来。 */
export function pickLocPools(seed, manifest, echoes = null) {
  const missed = echoes?.missedLocs || [];
  const out = {};
  for (const p of manifest.locationPools || []) {
    const echoPick = missed.find((id) => p.members.includes(id));
    if (echoPick) { out[p.group] = echoPick; continue; }
    const rng = new Rng(seed ^ hashStr('pool:' + p.group));
    out[p.group] = p.members[rng.int(p.members.length)];
  }
  return out;
}

/** 局终记账：这局「没去成」的池成员——
 *  落选的（连机会都没有）排前，开了门却没去过的（失约）排后。
 *  旧档无池字段返回空（0.29 存档不算错过）。 */
export function missedPoolLocs(st, pack) {
  if (!st?.locPool) return [];
  const out = [];
  for (const p of pack.manifest.locationPools || []) {
    const picked = st.locPool[p.group];
    if (!picked || !p.members.includes(picked)) continue; // 池数据不完整（老档/手改）不记账
    for (const m of p.members) if (m !== picked) out.push(m);            // 落选之憾
    const st2 = st.locState?.[picked];
    if (!st2 || st2.firstVisit !== false) out.push(picked);              // 失约之地
  }
  return out;
}

/** 回声风闻（池回声）：上一世错过、这一世入池的，第 1 天就以旧梦上图牵引 */
export function echoHeard(s, pack, loc) {
  if (!locInPool(s, pack, loc.id)) return false;
  return (s.echoes?.missedLocs || []).includes(loc.id);
}
