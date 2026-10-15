// 断线重连（页内恢复）的纯逻辑：退避节奏、轮次善终判定、心跳阈值。
// 不碰 DOM/Fetch——app.js 负责接线，这里只装可测的决策（测试即设计，
// 见 test/unit/reconnect.test.js；协议依据见 test/e2e/reconnect.test.js）。

// 服务端 SSE 心跳周期（index.js 默认同值；测试用 sseHeartbeatMs 压短）
export const HEARTBEAT_MS = 15000;
// 断流看门狗阈值：漏 4 拍（60s）才判线断——LLM 长思考期间合法地没有事件，
// 余量按「心跳周期的 4 倍」取，单拍丢失不误伤
export const SSE_STALL_MS = HEARTBEAT_MS * 4;

// 重连退避：1s→3s→7s→15s→30s 封顶，之后恒 30s。
// 确定性（不引随机）：单玩家自用服务，无需抖动
const DELAYS = [1000, 3000, 7000, 15000, 30000];
export function reconnectDelayMs(attempt) {
  return DELAYS[Math.min(Math.max(0, attempt), DELAYS.length - 1)];
}

/** 轮次善终判定：一轮输入见到 done 事件才算走完——
 *  流被掐断/服务器中途出错/头都没拿到，都不是善终，前端要重新对账（页内重连）。
 *  服务端权威且落库先行：重连=GET 重铺书页，而不是重放输入。 */
export function createTurnWatch() {
  const seen = new Set();
  return {
    saw(ev) { seen.add(ev); },
    get complete() { return seen.has('done'); }
  };
}
