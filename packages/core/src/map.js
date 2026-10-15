// 舆图视图（叙事双轴-v0.1 §3）：四态地点（未闻不显/风闻灰/已知淡/今夜亮）＋走向＋道路＋留痕层。
// 纯视图：server 现算，不入账；留痕触发全部来自既有旗标/文档/主线索/地点，不新造状态。
import { charById } from './state.js';
import { heardMet, echoHeard } from './unlock.js';

function traceOk(state, t) {
  const s = state, w = t.when || {};
  if (w.mlStep && !s.firedOnce?.['ml_' + w.mlStep]) return false;
  if (w.flag && !s.eventFlags?.[w.flag]) return false;
  if (w.anyFlag && !w.anyFlag.some((f) => s.eventFlags?.[f])) return false;
  if (w.doc && !(s.docsSeen || []).includes(w.doc)) return false;
  if (w.knownLoc && !(s.knownLocs || []).includes(w.knownLoc)) return false;
  if (w.locVisited) {
    const st = s.locState?.[w.locVisited];
    if (!st || st.firstVisit !== false) return false;
  }
  if (w.winter === true && !s.winterActive) return false;
  if (w.minDay && s.day < w.minDay) return false;
  if (w.weather && s.weather !== w.weather) return false;
  if (w.franko && s.franko?.merchant !== 'franko') return false;
  if (w.guardNights && (s.causality?.entries || []).filter((e) => e.verb === 'guard_night').length < w.guardNights) return false;
  return true;
}

/**
 * 舆图视图：{ places, roads, traces, tonight, route, winter, rain, gates }
 * places 四态：unknown 连名字都不给 / heard 风闻（灰名＋锁＋提示，不可去）/ known 可去 / tonight 今夜在此。
 * roads：手绘道路层——两端至少风闻才落墨（没听过的路不存在）。
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
    if (known) {
      const tonight = outTonight === p.id;
      const loc = pack.locMap[p.id];
      return { id: p.id, name: p.name, x: p.x, y: p.y, kind: p.kind, state: tonight ? 'tonight' : 'known', who: tonight ? who : null, mark: loc?.mark || null };
    }
    const loc = pack.locMap[p.id];
    const echoOnly = loc && !heardMet(s, pack, loc) && echoHeard(s, pack, loc); // 池回声：旧梦牵引
    if (loc && (heardMet(s, pack, loc) || echoOnly)) {
      return { id: p.id, name: p.name, x: p.x, y: p.y, kind: p.kind, state: 'heard', mark: loc.mark || null,
        hint: echoOnly && !loc.heardWhen ? (loc.echoHint || loc.hint || null) : (loc.hint || null) };
    }
    return { id: p.id, state: 'unknown' };
  });
  const byId = Object.fromEntries(places.map((p) => [p.id, p]));
  const roads = (m.roads || [])
    .filter((r) => byId[r.from] && byId[r.to] && byId[r.from].state !== 'unknown' && byId[r.to].state !== 'unknown')
    .map((r) => ({ from: r.from, to: r.to, cls: r.cls || 'lane' }));
  const traces = (m.traces || []).filter((t) => traceOk(s, t))
    .map((t) => ({ id: t.id, icon: t.icon, x: t.x, y: t.y, label: t.label }));
  return {
    base: m.base || { viewBox: [0, 0, 100, 100], paths: [] },
    places,
    roads,
    traces,
    gates: m.base?.gates || [],
    tonight: outTonight ? { loc: outTonight, who } : null,
    route: outTonight ? { from: 'home', to: outTonight } : null,
    winter: !!s.winterActive,
    rain: s.weather === 'rain'
  };
}
