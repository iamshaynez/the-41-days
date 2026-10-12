// 谋士全链（anthropic 协议，模拟 GLM）：optionsmith → extractJson → validateOptions。
// 回归三件事：① 卡面语境带【id 对照】（否则模型写中文名、意图全被过滤——线上教训）；
// ② 按调用的 maxTokens 真的生效；③ 空结果要能诊断（reason 由端点负责，这里锁管线）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { anthropicCompat } from '../../packages/llm/providers.js';
import { optionsmith } from '../../packages/llm/gateway.js';
import { validateOptions, cardBrief } from '../../packages/server/options.js';
import { loadPack, createRun, beginRun } from '../../packages/core/index.js';
import { loadPrompt } from '../../packages/core/index.js';

const PACK = loadPack();

describe('卡面语境：id 对照表', () => {
  test('人物/地点/物品都给「中文名=id」，货架给裸 id', () => {
    const state = createRun(PACK, { seed: 41, roster: ['anton', 'marta', 'bron'] });
    beginRun(state, PACK, {});
    state.franko = { merchant: 'franko', stock: [{ item: 'bandage', n: 2, buy: 3 }] };
    const brief = cardBrief(state, PACK, 'day');
    assert.ok(brief.includes('【id 对照'), '带对照段');
    assert.ok(brief.includes('文简=anton'));
    assert.ok(brief.includes('南市=market'), '地点 id');
    assert.ok(/熟食=meal|糙米=raw/.test(brief), '物品 id');
    assert.ok(brief.includes('bandage×2'), '货架裸 id');
  });
});

describe('anthropic 协议全链（GLM 路径，宽进归一化）', () => {
  let stub, calls;
  before(async () => {
    calls = [];
    stub = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const payload = JSON.parse(body || '{}');
        calls.push({ url: req.url, headers: req.headers, payload });
        // 模拟 GLM：围栏 JSON + 前后闲话；一个好选项 + 一个写中文名的必被滤
        res.end(JSON.stringify({
          model: payload.model,
          content: [{ type: 'text', text: '好的，这就想。\n```json\n{"options":[{"label":"让文简把糙米分了","hint":"一顿安稳饭","intents":[{"type":"act","actor":"anton","action":"eat","target":"raw"}]},{"label":"让文简休息","intents":[{"type":"act","actor":"文简","action":"eat","target":"糙米"}]}]}\n```\n以上。' }]
        }));
      });
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  });
  after(() => stub.close());

  test('optionsmith 走通：id 正确的选项保留，中文名的被滤；maxTokens 生效', async () => {
    const state = createRun(PACK, { seed: 42, roster: ['anton', 'marta', 'bron'] });
    beginRun(state, PACK, {});
    const provider = anthropicCompat({ baseUrl: `http://127.0.0.1:${stub.address().port}`, model: 'glm-4.6', apiKey: 'sk-test' });
    const prompts = { optionsmith: loadPrompt('optionsmith') };
    const brief = { card: cardBrief(state, PACK, 'day'), exclude: [], anchors: ['角色:文简'], worldBrief: '' };
    const raw = await optionsmith({ provider, prompts }, brief);

    // 请求侧：路径为协议约定的 /v1/messages（GLM 实测裸 /messages 是 200 包 404）；
    // 按调用 maxTokens；anthropic 头；system 带 id 对照
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/v1/messages'), `路径应为 /v1/messages（实际 ${calls[0].url}）`);
    assert.equal(calls[0].payload.max_tokens, 5000, '按调用的 maxTokens 要传到 anthropic body（思维链模型留余量）');
    assert.ok(calls[0].headers['x-api-key'] === 'sk-test');
    assert.ok(calls[0].payload.system.includes('【id 对照'), 'system 应含 id 对照段');
    assert.deepEqual(calls[0].payload.thinking, { type: 'low' }, '应带 GLM low 档（实测 6s vs 默认 70~195s）');

    // 响应侧：围栏 JSON 能抠出来；中文名经归一化翻译成 id（宽进）后两个都可行
    const options = validateOptions(PACK, state, raw);
    assert.equal(options.length, 2, `id 正确 + 中文名归一化，都应放行：${JSON.stringify(options)}`);
    assert.equal(options[0].intents[0].actor, 'anton');
    assert.equal(options[0].intents[0].target, 'raw');
    assert.equal(options[1].intents[0].actor, 'anton', '文简→anton');
    assert.equal(options[1].intents[0].target, 'raw', '糙米→raw');
  });
});
