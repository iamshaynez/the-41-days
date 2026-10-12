// 确定性随机源（RND-06）：mulberry32，游标持久化于 state.rngCursor。
export class Rng {
  constructor(seed, cursor = 0) {
    this.seed = seed >>> 0;
    this.cursor = cursor | 0;
  }
  _next() {
    this.cursor++;
    let t = (this.seed + this.cursor * 0x9e3779b1) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** [0,n) 整数 */
  int(n) { return Math.floor(this._next() * n); }
  /** 从数组取一个 */
  pick(arr) { return arr[this.int(arr.length)]; }
  /** 加权取：entries=[{w, ...}]（w>0） */
  weighted(entries) {
    const total = entries.reduce((s, e) => s + (e.w || 0), 0);
    let r = this._next() * total;
    for (const e of entries) { r -= (e.w || 0); if (r <= 0) return e; }
    return entries[entries.length - 1];
  }
  /** 概率 */
  chance(p) { return this._next() < p; }
  /** [min,max] 闭区间整数 */
  range(min, max) { return min + this.int(max - min + 1); }
  /** 2d6 掷骰（JD-01），记录 a/b 供透明模式 */
  roll2d6() { return { a: 1 + this.int(6), b: 1 + this.int(6) }; }
  /** 检定：2d6+mod → outcome: fail(2-6) | cost(7-9) | pass(10+)（难度带固定） */
  check(mod = 0) {
    const { a, b } = this.roll2d6();
    const sum = a + b + mod;
    const outcome = sum >= 10 ? 'pass' : (sum >= 7 ? 'cost' : 'fail');
    return { a, b, mod, sum, outcome };
  }
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 按 id 语义散列成 32 位种子（run seed 派生用） */
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
