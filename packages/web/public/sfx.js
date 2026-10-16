// 《第 41 天》语义音（UI设计-v0.3 §7 / v0.1 §10）：宁缺毋滥，默认关闭。
// 全部 WebAudio 合成，零音频资源。三处：叩门、更鼓、封泥碎裂。
let ctx = null;
function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
function noiseBurst(a, { dur = 0.08, freq = 1200, gain = 0.3, type = 'highpass' }) {
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = a.createBufferSource(); src.buffer = buf;
  const flt = a.createBiquadFilter(); flt.type = type; flt.frequency.value = freq;
  const g = a.createGain(); g.gain.value = gain;
  src.connect(flt).connect(g).connect(a.destination);
  src.start();
}
function thud(a, t, { from = 96, to = 55, dur = 0.22, gain = 0.42 }) {
  const o = a.createOscillator(); const g = a.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + dur * 0.6);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t); o.stop(t + dur + 0.05);
}

export const sfx = {
  enabled: false,   // 反模式 §6：声音默认关；选单「阅读 · 声音」打开
  knock() {  // 叩门：两声闷叩，隔着门板
    if (!this.enabled) return;
    try { const a = ac(); const t = a.currentTime; thud(a, t, {}); thud(a, t + 0.3, { gain: 0.3 }); } catch {}
  },
  drum() {  // 更鼓：一记远鼓，低而短
    if (!this.enabled) return;
    try { const a = ac(); thud(a, a.currentTime, { from: 74, to: 40, dur: 0.55, gain: 0.3 }); } catch {}
  },
  crack() { // 封泥碎裂：一声干脆的泥裂
    if (!this.enabled) return;
    try { const a = ac(); noiseBurst(a, { dur: 0.07, freq: 1500, gain: 0.32 }); noiseBurst(a, { dur: 0.04, freq: 3200, gain: 0.12 }); } catch {}
  },
  gong() {  // 露布落卷：一记哑锣，低频长衰减——史书落笔的分量
    if (!this.enabled) return;
    try {
      const a = ac(); const t = a.currentTime;
      for (const [f, g0, dur] of [[110, 0.22, 1.4], [164, 0.1, 1.0], [221, 0.05, 0.7]]) {
        const o = a.createOscillator(); const g = a.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(g0, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(g).connect(a.destination);
        o.start(t); o.stop(t + dur + 0.05);
      }
    } catch {}
  },
};
