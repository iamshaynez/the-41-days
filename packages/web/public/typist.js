// 流式分句引擎（可测纯逻辑，无 DOM）：LLM 的 SSE 增量逐段到达，
// 引擎跨增量缓冲，只释放到终止标点为止的完整句——增量边界落在「字」与「。」
// 之间时不再丢标点（线上教训：句子粘连「笃定三人」、段尾裸奔「压手」）。
// 供 app.js 的 Typist 使用；node 单测直接 import。

/** 逐字切句：终止标点永远随句（含连续标点）；纯标点不会成为独立碎片被丢 */
export function splitSentences(text) {
  const out = [];
  let buf = '';
  for (const ch of String(text)) {
    buf += ch;
    if ('。！？；…'.includes(ch)) {
      while (buf.length > 80) { // 超长句在逗号处预切，保持浮现颗粒
        let cut = -1;
        for (let i = 60; i < buf.length; i++) if ('，、'.includes(buf[i])) { cut = i + 1; break; }
        if (cut < 0) cut = 80;
        out.push(buf.slice(0, cut)); buf = buf.slice(cut);
      }
      out.push(buf); buf = '';
    }
  }
  if (buf) out.push(buf);
  const merged = []; // 太碎的碎片并入前一句
  for (const s of out) { if (merged.length && s.length < 3) merged[merged.length - 1] += s; else merged.push(s); }
  return merged;
}

/** 句缓冲：feed(增量) → drain 出 {0(段界)|句子}；flush() 清尾 */
export class SentenceBuffer {
  constructor() { this.buf = ''; }
  feed(text) {
    this.buf += text;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? ''; // 未完尾段（无换行）留在缓冲
    const out = [];
    parts.forEach((line, i) => {
      if (i > 0) out.push(0); // 换行 = 段界
      if (line) out.push(...splitSentences(line));
    });
    if (parts.length) out.push(0); // 行尾换行也是段界（buf 是下一段的开头）
    // 缓冲里只释放「已完结」的句子（到最近终止标点），未完尾句等下个增量
    const m = this.buf.match(/^[\s\S]*[。！？；…]/);
    if (m) {
      const released = m[0];
      this.buf = this.buf.slice(released.length);
      out.push(...splitSentences(released));
    }
    return out;
  }
  flush() {
    const rest = this.buf; this.buf = '';
    return rest ? splitSentences(rest) : [];
  }
}
