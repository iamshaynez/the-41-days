// 变更上下文（技术架构 §4.1）：所有状态变更的唯一通道——改草稿 + 发事件，二者同源。
// fold.js 是其镜像 reducer，属性测试保证二者一致。
import { Rng, clamp } from './rng.js';
import { moodLevel } from './state.js';
import { recordCausal } from './causality.js';

export class Ctx {
  /**
   * @param {object} state 草稿（会被就地修改）
   * @param {object} pack 内容包
   * @param {Array} events 事件数组（就地追加）
   * @param {Array} facts 叙事事实（就地追加）
   */
  constructor(state, pack, events = [], facts = []) {
    this.s = state;
    this.pack = pack;
    this.events = events;
    this.facts = facts;
    this.rng = new Rng(state.seed, state.rngCursor);
    // 管家标记：resolve 执行自动展开（auto_day/auto_night）的意图时置位，
    // facts 与因果账条目随之带上 delegated ——复盘要能分清"你下的令"与"你立的规矩"。
    this.delegated = false;
  }
  /** 结束一批变更：写回游标 */
  done() {
    this.s.rngCursor = this.rng.cursor;
    return { state: this.s, events: this.events, facts: this.facts };
  }
  emit(t, d = {}) {
    this.events.push({ i: this.events.length, day: this.s.day, t, d });
  }
  fact(k, d) { this.facts.push(this.delegated ? { k, ...d, delegated: true } : { k, ...d }); }

  // —— 物品（守恒律：一切流动记账）——
  addItem(item, n = 1, why = 'gain') {
    if (n === 0) return;
    this.s.inventory[item] = (this.s.inventory[item] || 0) + n;
    if (this.s.inventory[item] <= 0) delete this.s.inventory[item];
    this.emit('ITEM_MOVED', { item, delta: n, why });
  }
  hasItem(item, n = 1) { return (this.s.inventory[item] || 0) >= n; }
  takeItem(item, n = 1, why = 'use') {
    if (!this.hasItem(item, n)) return false;
    this.addItem(item, -n, why);
    return true;
  }
  inventoryValue() {
    let v = 0;
    for (const [id, n] of Object.entries(this.s.inventory)) v += (this.pack.itemMap[id]?.value || 0) * n;
    return v;
  }

  // —— 角色 ——
  char(id) { return this.s.chars.find((c) => c.id === id && c.alive) || null; }
  setHunger(c, to) {
    const from = c.hunger; if (from === to) return;
    c.hunger = clamp(to, 0, 4);
    this.emit('HUNGER_CHANGED', { char: c.id, from, to: c.hunger });
  }
  setWound(c, to) {
    const from = c.wound; if (from === to) return;
    c.wound = clamp(to, 0, 3);
    this.emit('WOUND_CHANGED', { char: c.id, from, to: c.wound });
  }
  setSick(c, to) {
    const from = c.sick; if (from === to) return;
    c.sick = clamp(to, 0, 3);
    this.emit('SICK_CHANGED', { char: c.id, from, to: c.sick });
  }
  setFatigue(c, to) {
    const from = c.fatigue; if (from === to) return;
    c.fatigue = clamp(to, 0, 2);
    this.emit('FATIGUE_CHANGED', { char: c.id, from, to: c.fatigue });
  }
  /** 心情事件（M-02/M-03/M-10）：base 基值，ethicsKey 可选伦理类别 */
  mood(c, base, reason, opts = {}) {
    if (!c || !c.alive || base === 0) return 0;
    const n = (c.moodCounts[reason] = (c.moodCounts[reason] || 0) + 1);
    this.emit('MOOD_COUNT', { char: c.id, reason, n });
    let delta = base;
    if (opts.ethics && c.ethics?.[opts.ethics] !== undefined) delta *= c.ethics[opts.ethics];
    if (opts.helpMul && c.ethics) delta *= c.ethics.help;
    delta *= Math.max(0.3, Math.pow(0.8, n - 1)); // M-03 钝化
    delta = Math.round(delta);
    if (delta === 0) return 0;
    this.moodRaw(c, delta, reason);
    return delta;
  }
  moodRaw(c, delta, reason) {
    const from = c.moodPts;
    const lvlFrom = moodLevel(from).key;
    c.moodPts = clamp(c.moodPts + delta, -18, 15);
    const lvlTo = moodLevel(c.moodPts).key;
    this.emit('MOOD_DELTA', { char: c.id, delta, reason, pts: c.moodPts });
    if (lvlFrom !== lvlTo) {
      this.emit('MOOD_LEVEL', { char: c.id, from: lvlFrom, to: lvlTo });
      if (lvlTo === 'breakdown' && !c.breakdown) { c.breakdown = { stage: 1 }; this.emit('BREAKDOWN_START', { char: c.id }); }
      this.fact('mood_level', { char: c.id, level: lvlTo });
    }
  }
  moodAll(base, reason, opts = {}) {
    for (const c of this.s.chars.filter((x) => x.alive)) this.mood(c, base, reason, opts);
  }
  spendAp(c, n) {
    if (n <= 0) return;
    c.ap = Math.max(0, c.ap - n);
    this.emit('AP_SPENT', { char: c.id, n, left: c.ap });
  }
  /** 检定（JD-01）：记录骰点（透明模式/UI 用） */
  check(name, mod) {
    const r = this.rng.check(mod);
    this.emit('ROLL_MADE', { check: name, ...r });
    return r;
  }
  die(c, cause) {
    if (!c.alive) return;
    c.alive = false;
    this.s.deathDays = { ...(this.s.deathDays || {}), [c.id]: this.s.day };
    this.emit('CHAR_DIED', { char: c.id, cause, day: this.s.day });
    this.fact('death', { char: c.id, cause });
    // CY-04 重事：死亡是灭失级以下最重的账，在场者人人有份（外出者之死，家人天亮即知）
    recordCausal(this, 'witness_death', { actor: 'world', target: c.id, note: cause });
  }
  addDeed(actor, type, target) {
    this.s.deeds.push({ day: this.s.day, actor, type, target });
    this.emit('DEED', { actor, type, target });
  }
  /** 知晓度（Q-01） */
  addKnowledge(n, why) {
    this.s.knowledge += n;
    this.emit('KNOWLEDGE', { to: this.s.knowledge, why });
  }
  /** 声望/恶名（EC-01 数据层） */
  reputation(key, delta) {
    this.s.reputation[key] = (this.s.reputation[key] || 0) + delta;
    this.emit('REPUTATION', { key, to: this.s.reputation[key] });
  }
  notoriety(delta) {
    this.s.notoriety = Math.max(0, this.s.notoriety + delta);
    this.emit('NOTORIETY', { to: this.s.notoriety });
  }
  /** 通用标量位（fold 镜像用）：state 顶层的散标量变更走这里 */
  setFlag(key, val) {
    this.s[key] = val;
    this.emit('FLAG', { key, val });
  }
  /** 角色身上的散标量 */
  setCharFlag(c, key, val) {
    c[key] = val;
    this.emit('CHAR_FLAG', { char: c.id, key, val });
  }
}
