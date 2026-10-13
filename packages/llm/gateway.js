// LLM 网关与两个角色：裁判（意图解析）与叙事者（GDD §11.1 四角色中的两个可测核心）。
// 铁律：LLM 输出仅作建议；结构校验失败走修复链，再失败回退直读模式（技术架构 §7.2/7.3）。
import { makeProvider } from './providers.js';

// GLM-5.x 思维链档位（官方报错原文：该模型始终思考，请使用 low、high 或 max）。
// low 实测：完整谋士提示词 6s 出结果（默认档 70~195s）。真 Anthropic 端点不认此档
// 会 400——适配器降参重试兜底，各回各家。
const THINKING_LOW = { type: 'low' };

/** 从模型输出里抠 JSON（容忍 ```json 包裹与前后闲话） */
export function extractJson(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.search(/[{[]/);
  if (start < 0) return null;
  const openCh = t[start];
  const closeCh = openCh === '{' ? '}' : ']';
  const end = t.lastIndexOf(closeCh);
  if (end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

const validIntent = (it) => it && typeof it === 'object' && typeof it.type === 'string';

/** 裁判：自然语言 → 意图列表。修复链：解析失败→带错误重试一轮→仍失败→直读解析器兜底 */
export async function referee({ provider, prompts, worldBrief, dayActions, duskActions, nightScene, merchant }, input, fallbackParser) {
  const system = prompts.referee
    .replace('{{world}}', worldBrief)
    .replace('{{day_actions}}', dayActions || '')
    .replace('{{dusk_actions}}', duskActions || '')
    .replace('{{night_scene}}', nightScene || '（无）')
    .replace('{{merchant}}', merchant || '（无）');
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = attempt === 0
      ? input
      : `上一次你的输出无法解析（${lastErr}）。请严格只输出一个 JSON 对象：{"intents":[...],"clarify":null,"say":null}。玩家输入：${input}`;
    try {
      const r = await provider.call({ system, user, json: true, temperature: 0.1, maxTokens: 4000, thinking: THINKING_LOW });
      const parsed = extractJson(r.text);
      if (!parsed || typeof parsed !== 'object') throw new Error('输出不是 JSON 对象');
      const intents = Array.isArray(parsed.intents) ? parsed.intents.filter(validIntent) : [];
      if (!intents.length && !parsed.clarify && !parsed.say && !parsed.echo) throw new Error('intents 为空且无 clarify/say/echo');
      return { ok: true, intents, clarify: parsed.clarify || null, say: parsed.say || null, echo: parsed.echo || null, raw: r.text, usage: r.usage };
    } catch (e) {
      lastErr = String(e.message || e);
    }
  }
  // 降级：直读解析器（与 LLM 同一套意图 schema）
  if (fallbackParser) {
    const fb = fallbackParser(input);
    return { ok: true, intents: fb.intents, clarify: fb.clarify || null, say: null, degraded: true };
  }
  return { ok: false, error: lastErr };
}

/** 叙事者：facts → 散文（流式回调可选）。离线时由调用方走直读模板。 */
export async function narrator({ provider, prompts, worldBrief }, facts, onDelta, recap = null) {
  // recap（ME-3 前情钩子）：昨日两段书页的开头——行文要承接前情、避开同款句式（防复读）
  const recapTxt = (recap && recap.length)
    ? `\n# 前情（昨日书页的开头，仅供衔接：不许复述、不许续写、开头句式不得与之相同）\n${recap.join('\n')}`
    : '';
  const system = prompts.narrator.replace('{{world}}', worldBrief).replace('{{facts}}', JSON.stringify(facts, null, 1)).replace('{{recap}}', recapTxt);
  const r = await provider.call({ system, user: '请渲染。', temperature: 0.85, maxTokens: 4000, stream: !!onDelta, onDelta, thinking: THINKING_LOW });
  return { text: r.text, usage: r.usage };
}

/** 回忆录作者：结局 storyline → 文学复盘（EPI-02；N-02 校验由调用方 memoirLint 执行） */
export async function memoirist({ provider, prompts }, storyline, onDelta) {
  const system = prompts.memoirist.replace('{{story}}', JSON.stringify(storyline, null, 1));
  const r = await provider.call({ system, user: '请撰写。', temperature: 0.8, maxTokens: 5000, stream: !!onDelta, onDelta, thinking: THINKING_LOW });
  return { text: r.text, usage: r.usage };
}

/** 史官（叙事双轴 §4.5）：主线日步骨架 → 当日大事条目（史书体 ≤120 字）。
 *  校验（锚点零改动／标记合法／文风禁词／字数）由调用方执行，违规回落 fallback。 */
export async function annalist({ provider, prompts }, brief) {
  const system = prompts.annalist
    .replace('{{anchor}}', brief.anchor || '')
    .replace('{{surface}}', brief.surface || '')
    .replace('{{undertow}}', brief.undertow || '（无）')
    .replace('{{pens}}', (brief.pens || []).join('\n') || '（无）')
    .replace('{{digest}}', brief.digest || '（无）')
    .replace('{{prev}}', (brief.prev || []).join('\n') || '（无）')
    .replace('{{names}}', brief.names || '');
  const r = await provider.call({ system, user: '写这一日。', temperature: 0.85, maxTokens: 600, thinking: THINKING_LOW });
  return { text: (r.text || '').trim(), usage: r.usage };
}

/** 演员：NPC 对话（价格带内浮动由提示词约束，越带由内核驳回） */
export async function actor({ provider, prompts }, { npcName, npcCard, priceBand, history, playerSay }) {
  const system = prompts.actor
    .replace('{{npc_name}}', npcName)
    .replace('{{npc_card}}', npcCard)
    .replace('{{price_band}}', priceBand || '（非交易场景）')
    .replace('{{history}}', (history || []).slice(-6).map((h) => `${h.who}: ${h.text}`).join('\n') || '（开场）')
    .replace('{{player_say}}', playerSay);
  const r = await provider.call({ system, user: playerSay, temperature: 0.8, maxTokens: 256 });
  return { text: r.text.trim() };
}

/** 网关：按用途路由 + 主备降级（§7.2）。providers: {referee, narrator, actor}（已构造的 provider 或 null） */
/** 编剧（内核 §8.8 GE-01）：提案一个 C 层微事件，JSON 走白名单校验（核心在 core/ge.js）。
 *  v3 命运导演：brief.arc 可携带命运弧（皮肤自由、包络住数据）；文学性四约束见提示词。 */
export async function playwright({ provider, prompts }, brief) {
  const arcTxt = brief.arc
    ? `\n# 本卡所属命运弧（写这张卡，不写别的）\n${brief.arc.brief}\n输出 JSON 增加 "arc": "${brief.arc.id}"；允许落的旗标键：${(brief.arc.flags || []).join('、')}（选项可用 "flag": {"键": true}）`
    : '';
  const system = prompts.playwright
    .replace('{{theme}}', brief.theme || '')
    .replace('{{arc}}', arcTxt)
    .replace('{{anchors}}', (brief.anchors || []).join('、'))
    .replace('{{items}}', brief.itemLegend || '')
    .replace('{{world}}', brief.worldBrief || '');
  const r = await provider.call({ system, user: '提案一个微事件。只输出 JSON。', json: true, temperature: 0.9, maxTokens: 6000, thinking: THINKING_LOW });
  return extractJson(r.text);
}

/** 谋士（统一交互面）：为停问卡补情境选项——皮肤自由，意图载荷由内核逐项验证。
 *  输出经服务端 validateOptions 过滤（形状/可行性/禁词），点不动的不会渲染。 */
export async function optionsmith({ provider, prompts }, brief) {
  const system = prompts.optionsmith
    .replace('{{card}}', brief.card || '')
    .replace('{{exclude}}', (brief.exclude || []).join('；') || '（无）')
    .replace('{{anchors}}', (brief.anchors || []).join('、'))
    .replace('{{world}}', brief.worldBrief || '');
  const r = await provider.call({ system, user: '给这张卡补 1~3 个新选项。只输出 JSON。', json: true, temperature: 0.9, maxTokens: 5000, thinking: THINKING_LOW });
  return extractJson(r.text);
}


/** 舞台导演（stage-play 双轨的戏文轨）：接住内核之外的玩家动作——
 *  写一段当场戏文 + 可选白名单微效果（内核照常裁决，越界即弃）。 */
export async function stagedirector({ provider, prompts }, brief) {
  const system = prompts.stage
    .replace('{{world}}', brief.worldBrief || '');
  const r = await provider.call({ system, user: `玩家这一拍：${brief.move}`, json: true, temperature: 0.9, maxTokens: 2500, thinking: THINKING_LOW });
  return extractJson(r.text);
}

/** 堂屋导演（人物血肉计划 PR2）：内核已定的话题+结局拍 → 角色台词。
 *  输出经服务端 validateEnsemble 校验（归属/句数/封印禁词），越界走 persona 直读拼装。 */
export async function ensemble({ provider, prompts }, brief) {
  const system = prompts.ensemble
    .replace('{{scene}}', JSON.stringify(brief.scene, null, 1))
    .replace('{{world}}', brief.worldBrief || '');
  const r = await provider.call({ system, user: '写这场堂屋戏。只输出 JSON。', json: true, temperature: 0.9, maxTokens: 2500, thinking: THINKING_LOW });
  return extractJson(r.text);
}

/** 史官列传（人物血肉计划 PR3）：内核 timeline/direction → 每人一段史书列传。
 *  输出经 biographyLint 逐人校验（长度/日数/节拍引用/禁词），不过即直读模板。 */
export async function biographer({ provider, prompts }, brief) {
  const system = prompts.biographer
    .replace('{{bios}}', JSON.stringify(brief.bios, null, 1))
    .replace('{{ending}}', JSON.stringify(brief.ending));
  const r = await provider.call({ system, user: '为每个人写列传。只输出 JSON。', json: true, temperature: 0.85, maxTokens: 5000, thinking: THINKING_LOW });
  return extractJson(r.text);
}

export function makeGateway({ providers, log = () => {} }) {
  async function call(purpose, fn) {
    const primary = providers[purpose];
    const fallback = providers[purpose + ':fallback'] || null;
    const t0 = Date.now();
    if (primary) {
      try {
        const out = await fn(primary);
        log({ purpose, provider: primary.model, ms: Date.now() - t0, ok: true });
        return { ...out, via: primary.model };
      } catch (e) {
        log({ purpose, provider: primary.model, ms: Date.now() - t0, ok: false, error: String(e.message || e).slice(0, 200) });
      }
    }
    if (fallback) {
      try {
        const out = await fn(fallback);
        log({ purpose, provider: fallback.model, ms: Date.now() - t0, ok: true, fallback: true });
        return { ...out, via: fallback.model };
      } catch (e) {
        log({ purpose, provider: fallback.model, ms: Date.now() - t0, ok: false, error: String(e.message || e).slice(0, 200) });
      }
    }
    return { degraded: true };
  }
  return { call };
}
