// 环境声基底（UI设计-v0.3 §7「白噪基底」首次落地）：雨 / 风雪 / 远水三条床，
// WebAudio 全合成、零音频资源（零依赖宪法）。按 天气×季节×夜访地点 自动淡入淡出；
// 宁缺毋滥——非冬的晴天，城里的安静是留白。默认关（选单「阅读 · 环境声」）。

/** 场景 → 床响度（0~1）。纯函数：调音逻辑在此钉死，引擎只管照着淡变。 */
export function sceneTargets({ weather, winter, phase, locId } = {}) {
  const t = { rain: 0, wind: 0, water: 0 };
  // 雨：霖雨接管城市——雨声盖过一切细响；冬雨偏冷峻（稍收）
  if (weather === 'rain') t.rain = winter ? 0.55 : 0.7;
  // 风：严寒风最紧，雪天风缓，冬晴只剩微风；夏秋无风
  if (winter) t.wind = weather === 'cold' ? 0.8 : weather === 'snow' ? 0.4 : 0.15;
  // 夜访地点的底色：城濠水窦的濠水、水门渡的江声；北津台上风不拘冬夏
  if (locId === 'sewer') t.water = 0.55;
  else if (locId === 'frontline') t.water = 0.3;
  if (locId === 'beacon') t.wind = Math.max(t.wind, 0.5);
  // 深夜整体收一档（人定之后，世界也该低声）
  if (phase === 'night' || phase === 'dusk') {
    t.rain *= 0.85; t.wind *= 0.9; t.water *= 0.9;
  }
  for (const k of Object.keys(t)) t[k] = Math.round(t[k] * 100) / 100;
  return t;
}

/* —— 合成引擎：三条循环噪声床 + 缓变增益（setTargetAtTime 交叉淡化） —— */
const BED_DEFS = {
  rain: { type: 'bandpass', freq: 1500, q: 0.6, gain: 0.16, lfo: { rate: 0.22, depth: 0.18 } },   // 雨幕：宽带嘶声带轻拍
  wind: { type: 'lowpass', freq: 420, q: 0.8, gain: 0.2, lfo: { rate: 0.07, depth: 0.5 } },       // 风：低频涌，阵风缓起缓落
  water: { type: 'bandpass', freq: 640, q: 1.1, gain: 0.12, lfo: { rate: 0.6, depth: 0.3 } }      // 远水：窄带流水的咕涌
};
const MASTER = 0.5;        // 床总闸——垫在阅读下面，不抢字
const FADE = 0.9;          // 淡变时间常数（秒）

export const ambience = {
  enabled: false,
  _ctx: null, _master: null, _beds: null, _pending: null, _resumeBound: null,

  /** 开关。开启时若 AudioContext 被浏览器挂起（无手势），等首次点击再起声 */
  setEnabled(on) {
    this.enabled = !!on;
    if (on) this._start();
    else this._stop();
  },

  /** 场景变化：照 sceneTargets 的响度把三条床淡过去 */
  scene(s = {}) {
    this._pending = s;
    this._applyTargets();
    // 调试/验收钩子：床响度写在根属性上（也供未来的 UI 指示用）
    if (typeof document !== 'undefined') {
      const t = sceneTargets(s);
      document.documentElement.dataset.ambience = `r${t.rain}|w${t.wind}|a${t.water}`;
    }
  },

  _start() {
    if (typeof window === 'undefined') return;
    try {
      if (!this._ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this._ctx = new AC();
        this._master = this._ctx.createGain();
        this._master.gain.value = MASTER;
        this._master.connect(this._ctx.destination);
        this._beds = {};
        for (const [name, def] of Object.entries(BED_DEFS)) this._beds[name] = this._mkBed(def);
        this._resumeBound = () => { this._ctx?.resume().then(() => this._applyTargets()).catch(() => {}); };
      }
      if (this._ctx.state === 'suspended') {
        window.addEventListener('pointerdown', this._resumeBound, { once: true });
        this._ctx.resume().then(() => this._applyTargets()).catch(() => {});
      }
      this._applyTargets();
    } catch { /* 无声环境（老浏览器/无 AudioContext）静默降级：游戏照玩 */ }
  },

  _stop() {
    if (!this._ctx) return;
    const now = this._ctx.currentTime;
    for (const b of Object.values(this._beds || {})) b.gain.gain.setTargetAtTime( 0, now, FADE );
    if (this._resumeBound && typeof window !== 'undefined') window.removeEventListener('pointerdown', this._resumeBound);
  },

  _applyTargets() {
    if (!this.enabled || !this._ctx || this._ctx.state !== 'running' || !this._beds) return;
    const t = sceneTargets(this._pending || {});
    const now = this._ctx.currentTime;
    for (const [name, bed] of Object.entries(this._beds)) {
      bed.gain.gain.setTargetAtTime((t[name] || 0) * bed.defGain, now, FADE);
    }
    if (typeof document !== 'undefined') document.documentElement.dataset.ambienceOn = '1'; // 验收钩子：引擎确已起声（无头环境安全跳过）
  },

  /** 一条床 = 循环白噪 → 滤波 → 增益（LFO 轻拍增益做呼吸感） */
  _mkBed(def) {
    const a = this._ctx;
    const secs = 3;
    const buf = a.createBuffer(1, Math.ceil(a.sampleRate * secs), a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = a.createBufferSource();
    src.buffer = buf; src.loop = true;
    const flt = a.createBiquadFilter();
    flt.type = def.type; flt.frequency.value = def.freq; flt.Q.value = def.q;
    const gain = a.createGain(); gain.gain.value = 0;
    if (def.lfo) { // 呼吸/阵风：LFO 摆动床增益
      const lfo = a.createOscillator(); lfo.frequency.value = def.lfo.rate;
      const lg = a.createGain(); lg.gain.value = def.lfo.depth * def.gain;
      lfo.connect(lg).connect(gain.gain);
      lfo.start();
    }
    src.connect(flt).connect(gain).connect(this._master);
    src.start(Math.random() * secs); // 错开起点，三条床不同相
    return { gain, defGain: def.gain }; // defGain 随床走——应用响度时乘的是它
  }
};

// 调试出口（验收/排障用）：只读视角看引擎内部
if (typeof window !== 'undefined') window.__amb = ambience; // 调试出口（浏览器验收用；无头环境安全跳过）
