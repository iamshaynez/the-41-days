// LLM Provider 层（技术架构 §7.1）：两个适配器覆盖 DeepSeek 与 GLM（开放平台 / coding plan）。
// 全部走 fetch，无 SDK 依赖；key 只在服务端使用。
export const PRESETS = {
  deepseek: {
    name: 'DeepSeek', adapter: 'openai-compat', baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat', chatPath: '/chat/completions', apiKeyHint: 'sk-...'
  },
  glm: {
    name: 'GLM 开放平台', adapter: 'openai-compat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash', chatPath: '/chat/completions', apiKeyHint: '*****.*****'
  },
  glm_coding: {
    name: 'GLM Coding Plan', adapter: 'anthropic-compat', baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-4.6', chatPath: '/messages', apiKeyHint: 'sk-...'
  }
};

/**
 * OpenAI 兼容适配器（DeepSeek / GLM 开放平台 / 任意兼容端点）
 * cfg: {baseUrl, model, apiKey, temperature?, maxTokens?, timeoutMs?}
 */

/** 带超时与一次自动重试的 fetch（参考 gb-pmo：超时重试覆盖瞬时抖动；其余错误不重试）。
 *  两次超时后抛中文指引——GLM 思维链模型动辄 60s+，默认上限 120s（gb-pmo 同款）。 */
async function fetchWithRetry(url, init, timeoutMs) {
  const attempt = () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    return fetch(url, { ...init, signal: init.signal || ctl.signal }).finally(() => clearTimeout(timer));
  };
  try {
    return await attempt();
  } catch (e) {
    if (e?.name !== 'AbortError') throw e;
    try {
      return await attempt();
    } catch (e2) {
      if (e2?.name !== 'AbortError') throw e2;
      throw new Error(`LLM 响应超时（已自动重试一次，每次上限 ${timeoutMs}ms）：思维链模型可能想得太久——可在供应商参数里调大 timeoutMs`);
    }
  }
}

/**
 * 流式文本净化（线上教训："让辛夷��素徽说话"式乱码）：
 * 1. 剥 U+FFFD——上游流设施把多字节字符截断后送来的替换符，进了正文就成了永久的墨点；
 *    本作正文是中文散文，U+FFFD 永远不合法，剥掉比留着一个方框好。
 * 2. 代理对 holdback——上游把一个增广平面的字拆在两个 delta JSON 里时，
 *    先扣住结尾的孤立高代理，等下一个 delta 拼齐再放行；流结束仍凑不齐就丢弃半个字。
 *    onDelta 的每个消费者拿到的永远是完整字符。
 */
export function makeDeltaFilter() {
  let pendingHigh = '';
  return {
    push(raw) {
      let t = pendingHigh + String(raw).replace(/\ufffd/g, '');
      pendingHigh = '';
      const last = t.charCodeAt(t.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) { // 结尾是孤立高代理：扣住
        pendingHigh = t.slice(-1);
        t = t.slice(0, -1);
      }
      return t;
    },
    flush() { // 流结束：凑不齐的半个字丢弃——永不让孤立代理入文
      pendingHigh = '';
      return '';
    }
  };
}

function cleanText(t) { return String(t || '').replace(/\ufffd/g, ''); }

export function openaiCompat(cfg) {
  const url = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  async function call({ system, user, json = false, stream = false, onDelta, signal, maxTokens, maxTimeout, thinking }) {
    const body = {
      model: cfg.model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user }
      ],
      temperature: cfg.temperature ?? 0.7,
      max_tokens: maxTokens ?? cfg.maxTokens ?? 2048,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      ...(thinking ? { thinking } : {}) // GLM 开放平台原生档位：low/high/max（不可关闭）
    };
    if (stream) body.stream = true;
    const timeoutMs = maxTimeout ?? cfg.timeoutMs ?? 120000;
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` };
    const post = (b) => fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(b), signal }, timeoutMs);
    let res = await post(body);
    if (res.status === 400 && (json || thinking)) {
      // GLM 等端点对 response_format 无官方承诺、thinking 档位各家不一：去参重试一次（gb-pmo 同款）
      delete body.response_format;
      delete body.thinking;
      res = await post(body);
    }
    if (!res.ok) throw new Error(`${cfg.model} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    if (stream && onDelta) {
      let text = '';
      const df = makeDeltaFilter();
      for await (const chunk of sseChunks(res)) {
        const delta = df.push(chunk.choices?.[0]?.delta?.content || '');
        if (delta) { text += delta; onDelta(delta); }
      }
      df.flush();
      return { text, usage: null };
    }
    const data = await res.json();
    // 有些网关用 HTTP 200 包错误对象（无 choices）——空正文按错误处理
    if (!Array.isArray(data.choices) || !data.choices.length) {
      throw new Error(`${cfg.model} 响应无 choices：${JSON.stringify(data).slice(0, 160)}`);
    }
    return { text: cleanText(data.choices?.[0]?.message?.content || ''), usage: data.usage || null };
  }
  return { adapter: 'openai-compat', model: cfg.model, call };
}

/**
 * Anthropic 兼容适配器（GLM coding plan）
 */
export function anthropicCompat(cfg) {
  // Anthropic 协议约定：POST {baseUrl}/v1/messages（GLM/Anthropic 同规；
  // 实测 open.bigmodel.cn 对裸 /messages 回 HTTP200 包 404——空正文极难排查）
  const base = cfg.baseUrl.replace(/\/$/, '');
  const url = /\/v\d+$/.test(base) ? base + '/messages' : base + '/v1/messages';
  async function call({ system, user, json = false, stream = false, onDelta, signal, maxTokens, maxTimeout, thinking }) {
    const body = {
      model: cfg.model,
      max_tokens: maxTokens ?? cfg.maxTokens ?? 2048,
      temperature: cfg.temperature ?? 0.7,
      ...(system ? { system } : {}),
      ...(thinking ? { thinking } : {}), // GLM 思维链模型：budget_tokens 是唯一能压时长的开关（实测有效）
      messages: [{ role: 'user', content: user }]
    };
    if (stream) body.stream = true;
    const headers = { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' };
    const timeoutMs = maxTimeout ?? cfg.timeoutMs ?? 120000;
    const post = (b) => fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(b), signal }, timeoutMs);
    let res = await post(body);
    if (res.status === 400 && thinking) {
      // thinking 参数并非所有 anthropic 兼容端点都认：400 时去参重试一次
      delete body.thinking;
      res = await post(body);
    }
    if (!res.ok) throw new Error(`${cfg.model} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    if (stream && onDelta) {
      let text = '';
      const df = makeDeltaFilter();
      for await (const ev of sseEvents(res)) {
        if (ev.type === 'content_block_delta' && ev.delta?.text) {
          const delta = df.push(ev.delta.text);
          if (delta) { text += delta; onDelta(delta); }
        }
      }
      df.flush();
      return { text, usage: null };
    }
    const data = await res.json();
    // 思维链模型可能把 max_tokens 全烧在 thinking 块上——空正文按错误处理，别静默吞
    const text = cleanText((data.content || []).map((c) => c.text || '').join(''));
    if (!text.trim()) {
      throw new Error(`${cfg.model} 空正文（stop=${data.stop_reason ?? '?'}——若是思维链模型，max_tokens 可能被 thinking 烧尽）`);
    }
    return { text, usage: data.usage || null };
  }
  return { adapter: 'anthropic-compat', model: cfg.model, call };
}

export function makeProvider(cfg) {
  if (cfg.adapter === 'anthropic-compat') return anthropicCompat(cfg);
  return openaiCompat(cfg);
}

/** SSE 流解析：data: {...} 行 */
async function* sseLines(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}
async function* sseChunks(res) {
  for await (const line of sseLines(res)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    try { yield JSON.parse(payload); } catch { /* 忽略半包 */ }
  }
}
async function* sseEvents(res) {
  for await (const ev of sseChunks(res)) yield ev;
}

/** 连通性测试（技术架构 §7.4）：小 prompt 实调，报告延迟与回显 */
export async function healthCheck(cfg) {
  const t0 = Date.now();
  try {
    const p = makeProvider(cfg);
    // 预算必须留足：思维链模型（GLM-5.3-Flash 实测）会把小预算烧在 thinking 块上，
    // 正文一个字没出就 stop=max_tokens，空正文守卫把好端点误报成故障
    const r = await p.call({ user: '请只回复两个字：正常', maxTokens: 512 });
    return { ok: true, provider: cfg.name || cfg.model, model: cfg.model, latencyMs: Date.now() - t0, echo: (r.text || '').slice(0, 40), usage: r.usage, at: new Date().toISOString() };
  } catch (e) {
    return { ok: false, provider: cfg.name || cfg.model, model: cfg.model, latencyMs: Date.now() - t0, error: String(e.message || e).slice(0, 300), at: new Date().toISOString() };
  }
}
