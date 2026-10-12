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
export function openaiCompat(cfg) {
  const url = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  async function call({ system, user, json = false, stream = false, onDelta, signal, maxTokens }) {
    const body = {
      model: cfg.model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user }
      ],
      temperature: cfg.temperature ?? 0.7,
      max_tokens: maxTokens ?? cfg.maxTokens ?? 2048,
      ...(json ? { response_format: { type: 'json_object' } } : {})
    };
    if (stream) body.stream = true;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(cfg.timeoutMs || 60000)
    });
    if (!res.ok) throw new Error(`${cfg.model} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    if (stream && onDelta) {
      let text = '';
      for await (const chunk of sseChunks(res)) {
        const delta = chunk.choices?.[0]?.delta?.content || '';
        if (delta) { text += delta; onDelta(delta); }
      }
      return { text, usage: null };
    }
    const data = await res.json();
    return { text: data.choices?.[0]?.message?.content || '', usage: data.usage || null };
  }
  return { adapter: 'openai-compat', model: cfg.model, call };
}

/**
 * Anthropic 兼容适配器（GLM coding plan）
 */
export function anthropicCompat(cfg) {
  const url = cfg.baseUrl.replace(/\/$/, '') + '/messages';
  async function call({ system, user, json = false, stream = false, onDelta, signal, maxTokens }) {
    const body = {
      model: cfg.model,
      max_tokens: maxTokens ?? cfg.maxTokens ?? 2048,
      temperature: cfg.temperature ?? 0.7,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: user }]
    };
    if (stream) body.stream = true;
    const headers = { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' };
    const res = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(cfg.timeoutMs || 60000)
    });
    if (!res.ok) throw new Error(`${cfg.model} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    if (stream && onDelta) {
      let text = '';
      for await (const ev of sseEvents(res)) {
        if (ev.type === 'content_block_delta' && ev.delta?.text) { text += ev.delta.text; onDelta(ev.delta.text); }
      }
      return { text, usage: null };
    }
    const data = await res.json();
    return { text: (data.content || []).map((c) => c.text || '').join(''), usage: data.usage || null };
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
    const r = await p.call({ user: '请只回复两个字：正常', maxTokens: 16 });
    return { ok: true, provider: cfg.name || cfg.model, model: cfg.model, latencyMs: Date.now() - t0, echo: (r.text || '').slice(0, 40), usage: r.usage, at: new Date().toISOString() };
  } catch (e) {
    return { ok: false, provider: cfg.name || cfg.model, model: cfg.model, latencyMs: Date.now() - t0, error: String(e.message || e).slice(0, 300), at: new Date().toISOString() };
  }
}
