// 环境声基底（UI设计-v0.3 §7「白噪基底」首次落地）：目标响度的纯函数——
// 哪个天气/季节/地点，开哪条床、开多响。合成引擎在浏览器实测，这里钉死调音逻辑。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sceneTargets } from '../../packages/web/public/ambience.js';

describe('环境声：场景 → 床响度', () => {
  test('雨天开雨床（雨声盖过一切细响）', () => {
    const t = sceneTargets({ weather: 'rain', winter: false, phase: 'day', locId: 'home' });
    assert.ok(t.rain > 0.5, `雨床应显著：${JSON.stringify(t)}`);
    assert.equal(t.wind, 0);
    assert.equal(t.water, 0);
  });
  test('冬雨：雨为主，风垫底', () => {
    const t = sceneTargets({ weather: 'rain', winter: true, phase: 'night', locId: 'home' });
    assert.ok(t.rain > 0 && t.wind > 0, `冬雨是雨风两层：${JSON.stringify(t)}`);
  });
  test('严寒风最紧，雪天风缓，冬晴只剩微风', () => {
    const cold = sceneTargets({ weather: 'cold', winter: true, phase: 'night', locId: 'home' });
    const snow = sceneTargets({ weather: 'snow', winter: true, phase: 'night', locId: 'home' });
    const clear = sceneTargets({ weather: 'clear', winter: true, phase: 'day', locId: 'home' });
    assert.ok(cold.wind > snow.wind && snow.wind > clear.wind && clear.wind > 0, `风强排序 严寒>雪>冬晴：${JSON.stringify({ cold, snow, clear })}`);
  });
  test('非冬晴天：全静（城里的安静是留白，不是缺货）', () => {
    const t = sceneTargets({ weather: 'clear', winter: false, phase: 'day', locId: 'home' });
    assert.deepEqual(t, { rain: 0, wind: 0, water: 0 });
    const fog = sceneTargets({ weather: 'fog', winter: false, phase: 'night', locId: 'home' });
    assert.deepEqual(fog, { rain: 0, wind: 0, water: 0 });
  });
  test('夜访临水地：远水床起（城濠水窦最响，水门渡次之）', () => {
    const sewer = sceneTargets({ weather: 'clear', winter: false, phase: 'night', locId: 'sewer' });
    const front = sceneTargets({ weather: 'clear', winter: false, phase: 'night', locId: 'frontline' });
    const market = sceneTargets({ weather: 'clear', winter: false, phase: 'night', locId: 'market' });
    assert.ok(sewer.water > 0.4, `水窦应听见濠水：${JSON.stringify(sewer)}`);
    assert.ok(front.water > 0 && front.water < sewer.water);
    assert.equal(market.water, 0, '市集不临水');
  });
  test('烽台夜访：高处风紧（不拘冬夏）', () => {
    const beacon = sceneTargets({ weather: 'clear', winter: false, phase: 'night', locId: 'beacon' });
    assert.ok(beacon.wind > 0.3, `台上应有风：${JSON.stringify(beacon)}`);
  });
});

/* —— 引擎（无头）：stub AudioContext，钉死「起声/挂起恢复/床增益」链路 —— */
class MockParam {
  constructor() { this._v = 0; this.calls = []; }
  setTargetAtTime(v, t, tc) { this.calls.push([Math.round(v * 1000) / 1000, t, tc]); this._v = v; }
  get value() { return this._v; } set value(v) { this._v = v; }
}
class MockAC {
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; this.made = { src: 0, osc: 0 }; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  createBufferSource() { this.made.src++; return { buffer: null, loop: false, connect(n) { return n; }, start() {} }; }
  createBiquadFilter() { return { type: '', frequency: { value: 0 }, Q: { value: 0 }, connect(n) { return n; } }; }
  createGain() { return { gain: new MockParam(), connect(n) { return n; } }; }
  createOscillator() { this.made.osc++; return { frequency: { value: 0 }, connect(n) { return n; }, start() {} }; }
}

describe('环境声引擎：床的生死与淡变', () => {
  test('开启即起三条床，按场景淡到目标响度', async () => {
    globalThis.window = { AudioContext: MockAC, addEventListener() {}, removeEventListener() {} };
    const { ambience } = await import('../../packages/web/public/ambience.js');
    ambience._ctx = null; ambience._beds = null; // 单例复位（前例污染隔离）
    ambience.setEnabled(true);
    await Promise.resolve();
    assert.equal(ambience._ctx.state, 'running', 'ctx 应在跑');
    assert.equal(Object.keys(ambience._beds).length, 3, '三条床：雨/风/水');
    ambience.scene({ weather: 'rain', winter: false, phase: 'day', locId: 'home' });
    const rain = ambience._beds.rain.gain.gain;
    const last = rain.calls.at(-1);
    assert.ok(last && last[0] > 0.05, `雨床应有响度：${JSON.stringify(rain.calls)}`);
    assert.equal(ambience._beds.water.gain.gain.calls.filter((c) => c[0] > 0).length, 0, '晴雨无水床目标');
  });
  test('挂起的 ctx：恢复后才铺目标（浏览器无手势挂起场景）', async () => {
    globalThis.window = { AudioContext: MockAC, addEventListener() {}, removeEventListener() {} };
    const { ambience } = await import('../../packages/web/public/ambience.js');
    ambience._ctx = null; ambience._beds = null;
    ambience.setEnabled(true);
    ambience._ctx.state = 'suspended'; // 模拟浏览器无手势挂起
    ambience.scene({ weather: 'snow', winter: true, phase: 'night', locId: 'home' });
    assert.equal(ambience._beds.wind.gain.gain.calls.filter((c) => c[0] > 0).length, 0, '挂起中不该铺增益');
    ambience._ctx.state = 'running'; // 手势到位
    ambience._applyTargets();
    const last = ambience._beds.wind.gain.gain.calls.at(-1);
    assert.ok(last && last[0] > 0.03, `雪夜风床应有响度：${JSON.stringify(last)}`);
  });
  test('关闭：所有床淡到零', async () => {
    globalThis.window = { AudioContext: MockAC, addEventListener() {}, removeEventListener() {} };
    const { ambience } = await import('../../packages/web/public/ambience.js');
    ambience._ctx = null; ambience._beds = null;
    ambience.setEnabled(true);
    ambience.scene({ weather: 'rain', winter: false, phase: 'day', locId: 'home' });
    ambience.setEnabled(false);
    for (const [name, bed] of Object.entries(ambience._beds)) {
      const last = bed.gain.gain.calls.at(-1);
      assert.equal(last[0], 0, `${name} 床应淡到零`);
    }
    delete globalThis.window;
  });
});
