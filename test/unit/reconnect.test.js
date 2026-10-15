// 断线重连（页内恢复）纯逻辑：退避节奏与轮次善终判定。
// 背景（功能修复）：SSE 断流时旧前端只落一行「刷新页面可从断点恢复」——
// 但刷新 /app 回的是卷首（选存档/新开局），断在无卡处更是彻底卡死。
// 重连逻辑必须可测：退避节奏确定（不引随机）、善终判定以 done 事件为准。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reconnectDelayMs, createTurnWatch, SSE_STALL_MS, HEARTBEAT_MS } from '../../packages/web/public/reconnect.js';

describe('重连退避：确定性的节奏', () => {
  test('按 1s→3s→7s→15s→30s 递增，之后封顶 30s', () => {
    assert.equal(reconnectDelayMs(0), 1000);
    assert.equal(reconnectDelayMs(1), 3000);
    assert.equal(reconnectDelayMs(2), 7000);
    assert.equal(reconnectDelayMs(3), 15000);
    assert.equal(reconnectDelayMs(4), 30000);
    assert.equal(reconnectDelayMs(5), 30000);
    assert.equal(reconnectDelayMs(99), 30000);
  });
});

describe('轮次善终判定：见到 done 才算走完', () => {
  test('ack→state-patch→done 是善终——不触发重连', () => {
    const t = createTurnWatch();
    t.saw('ack'); t.saw('feedback'); t.saw('state-patch'); t.saw('done');
    assert.equal(t.complete, true);
  });
  test('流断在半途（没等到 done）不算善终——要重新对账', () => {
    const t = createTurnWatch();
    t.saw('ack'); t.saw('feedback'); t.saw('state-patch');
    assert.equal(t.complete, false);
  });
  test('空流（一个事件都没到）不算善终', () => {
    assert.equal(createTurnWatch().complete, false);
  });
  test('error 事件收尾不算善终——服务端中途出错，状态存疑，也要重新对账', () => {
    const t = createTurnWatch();
    t.saw('ack'); t.saw('error');
    assert.equal(t.complete, false);
  });
});

describe('断流看门狗：心跳与阈值的配比', () => {
  test('看门狗阈值 ≥ 4 个心跳周期（漏 4 拍才算线断，LLM 长思考不误伤）', () => {
    assert.equal(typeof HEARTBEAT_MS, 'number');
    assert.ok(SSE_STALL_MS >= HEARTBEAT_MS * 4, `SSE_STALL_MS(${SSE_STALL_MS}) 应 ≥ 4×HEARTBEAT_MS(${HEARTBEAT_MS})`);
  });
});
