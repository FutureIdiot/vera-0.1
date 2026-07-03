// SSE 重连策略（docs/api-contract.md 四、客户端义务：断连后指数退避重连，
// 携带 since）。与 api/gateway-client.js 的单一职责分开：那边只管开一条连接，
// 这里管"连接掉了怎么办"。
//
// stream.reset 语义特别处理：gateway 发 stream.reset 后，同一条连接本身仍然
// 继续存活并推送后续实时事件（sse.js 的 subscribe 无论走重放还是 reset 分支
// 都会把订阅者注册为实时订阅者）——所以收到 stream.reset 不需要重开连接，只
// 需要调用方重新 bootstrap，并通过 resetSince() 把新的 seq 水位灌回来，供
// *以后* 万一断线时的重连使用。

import { connectEvents } from "../api/gateway-client.js";

export function createReconnectingEventStream({ initialSince, onEvent, onReset, minDelayMs = 500, maxDelayMs = 10000 } = {}) {
  let since = initialSince ?? null;
  let source = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer = null;

  function scheduleReconnect() {
    if (stopped) return;
    const delay = Math.min(maxDelayMs, minDelayMs * 2 ** attempt);
    attempt += 1;
    reconnectTimer = setTimeout(open, delay);
  }

  function open() {
    if (stopped) return;
    source?.close();
    source = connectEvents({
      since,
      onOpen: () => {
        attempt = 0;
      },
      onEvent: (envelope) => {
        if (envelope.type === "stream.reset") {
          onReset?.();
          return;
        }
        since = envelope.seq;
        onEvent?.(envelope);
      },
      onError: () => {
        source?.close();
        scheduleReconnect();
      },
    });
  }

  open();

  return {
    resetSince(newSince) {
      since = newSince;
    },
    close() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    },
  };
}
