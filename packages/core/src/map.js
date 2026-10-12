// 舆图视图（叙事双轴-v0.1 §3）：三态地点（未闻不显/已知淡/今夜亮）＋走向＋留痕层。
// 纯视图：server 现算，不入账；留痕触发全部来自既有旗标/文档/主线索，不新造状态。
import { charById } from './state.js';

function traceOk(state, t) {
  const s = state, w = t.when || {};
  if (w.mlStep && !s.firedOnce?.['ml_' + w.mlStep]) return false;
  if (w.flag && !s.eventFlags?.[w.flag]) return false;
  if (w.anyFlag && !w.anyFlag.some((f) => s.eventFlags?.[f])) return false;
  if (w.doc && !(s.docsSeen || []).includes(w.doc)) return false;
  if (w.winter === true && !s.winterActive) return false;
  if (w.minDay && s.day < w.minDay) return false;
  if (w.weather && s.weather !== w.weather) return false;
  if (w.franko && s.franko?.merchant !== 'franko') return false;
  if (w.guardNights && (s.causality?.entries || []).filter((e) => e.verb === 'guard_night').length < w.guardNights) return false;
  return true;
}

/**
 * 舆图视图：{ places, traces, tonight, route, winter, rain, gates }
 * tonight：外出者所在地点与姓名（黄昏未指派/在家为 null）；route：home → 目的地（走向虚线）。
 */
export function mapView(state, pack) {
  const m = pack.map;
  if (!m || state.sidestory) return null;
  const s = state;
  const outTonight = s.night && !s.night.home ? s.night.locId : null;
  const who = outTonight ? (charById(s, s.night.charId)?.name || null) : null;
  const places = (m.places || []).map((p) => {
    const known = p.id === 'home' || (s.knownLocs || []).includes(p.id);
    if (!known) return { id: p.id, state: 'unknown' };
    const tonight = outTonight === p.id;
    return { id: p.id, name: p.name, x: p.x, y: p.y, kind: p.kind, state: tonight ? 'tonight' : 'known', who: tonight ? who : null };
  });
  const traces = (m.traces || []).filter((t) => traceOk(s, t))
    .map((t) => ({ id: t.id, icon: t.icon, x: t.x, y: t.y, label: t.label }));
  return {
    base: m.base || { viewBox: [0, 0, 100, 100], paths: [] },
    places,
    traces,
    gates: m.base?.gates || [],
    tonight: outTonight ? { loc: outTonight, who } : null,
    route: outTonight ? { from: 'home', to: outTonight } : null,
    winter: !!s.winterActive,
    rain: s.weather === 'rain'
  };
}
