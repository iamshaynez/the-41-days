// 高亮标注协议（叙事双轴-v0.1 §6）：七类标记 [[类|词]]，registry 校验——标不出即不存在。
// 手作文本与 LLM 输出同律；server 侧史官校验与 web 渲染共用本协议。
// 「要」是排版指令（要点朱批），不是名词引用：任意文本合法，不走 registry。
const MK_RE = /\[\[([人地物事决伏要])\|([^\]|]+)\]\]/g;

/** 解析一段文本里的全部标记 */
export function parseMarkers(text) {
  const out = [];
  for (const m of String(text || '').matchAll(MK_RE)) out.push({ type: m[1], name: m[2], raw: m[0] });
  return out;
}

/** 去掉标记语法，留净文（lint/校验用） */
export function stripMarkers(text) {
  return String(text || '').replace(MK_RE, '$2');
}

/** registry：人/地/事/伏 来自 historia；物 = 文档 #id ∪ 物品名；决 = 结局名单 */
export function markerRegistry(pack) {
  const h = pack.historia || {};
  const items = new Set((pack.items || []).map((i) => i.name));
  const docs = new Set((pack.docs || []).map((d) => d.id));
  return {
    人: new Set(h.persons || []),
    地: new Set(h.places || []),
    物: docs.union ? docs.union(items) : new Set([...docs, ...items]),
    事: new Set(h.events || []),
    决: new Set(['还师', '出江陵', '惨胜', '麦城得脱', '交割', '开城']),
    伏: new Set(h.foreshadows || [])
  };
}

/** 校验一段文本：返回非法标记列表（空数组即合规；「要」为排版指令，免查） */
export function validateTextMarkers(text, pack) {
  const reg = markerRegistry(pack);
  return parseMarkers(text).filter((m) => m.type !== '要' && !reg[m.type]?.has(m.name)).map((m) => ({ type: m.type, name: m.name }));
}

/** 语法级校验：文本里一切 [[……]] 必须是七类标记之一。LLM 史笔会仿写出
 *  [[江陵|江陵]] 这类"名词|名词"的野标记——parseMarkers 的类别正则根本不认它，
 *  于是它既过 validateTextMarkers 又以裸括号漏进 UI（一周目实测 D28 起史卷成片）。
 *  返回野标记原文列表（空=过）。 */
export function markerSyntaxErrors(text) {
  // MK_RE 带 /g（matchAll 用），.test 会走 lastIndex——这里用锚定的非全局副本
  const MK_ONE = /^\[\[[人地物事决伏要]\|[^\]|]+\]\]$/;
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(/\[\[[^\]]*\]\]/g)) {
    if (!MK_ONE.test(m[0]) && !seen.has(m[0])) { seen.add(m[0]); out.push(m[0]); }
  }
  return out;
}
