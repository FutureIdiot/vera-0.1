// SSE 通道：全局单流，环形缓冲 + 单调 seq + since/Last-Event-ID 重放 + stream.reset。
// docs/api-contract.md 四、SSE 事件流。
//
// createEventHub 是纯逻辑（不依赖 node:http），方便单测；handleSseRequest 是
// 挂在 node:http 上的适配层。

// initialSeq：起始 seq（重启时由 server 从持久化水位 + 跳跃算出）；
// onSeqAdvance：每次 publish 后回调最新 seq（server 接到 store 回写水位）。
export function createEventHub({ bufferSize = 2000, pingIntervalMs = 25000, initialSeq = 0, onSeqAdvance = null } = {}) {
  let seq = initialSeq;
  const buffer = []; // { seq, type, ts, data }
  const subscribers = new Set(); // { write(frameString) }

  function frameFor(envelope) {
    return `id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`;
  }

  function publish(type, data) {
    seq += 1;
    const envelope = { seq, type, ts: new Date().toISOString(), data };
    buffer.push(envelope);
    if (buffer.length > bufferSize) buffer.shift();
    const frame = frameFor(envelope);
    for (const sub of subscribers) sub.write(frame);
    onSeqAdvance?.(seq);
    return envelope;
  }

  function currentSeq() {
    return seq;
  }

  function oldestBufferedSeq() {
    return buffer.length ? buffer[0].seq : null;
  }

  // 缓冲是否已经滚过 sinceSeq（即 sinceSeq 之后到最旧缓冲之间存在缺口）。
  // sinceSeq 超前于当前 seq（来自 gateway 上一世、水位防抖丢失时可能出现）
  // 同样算缺口：客户端状态与本世对不上，必须 reset。
  function hasGap(sinceSeq) {
    if (sinceSeq > seq) return true;
    if (sinceSeq === seq) return false;
    const oldest = oldestBufferedSeq();
    if (oldest === null) return sinceSeq < seq;
    return sinceSeq < oldest - 1;
  }

  function replaySince(sinceSeq) {
    return buffer.filter((envelope) => envelope.seq > sinceSeq);
  }

  // 订阅：sinceSeq 非空时先重放或发 stream.reset，再转入实时推送。
  // 返回取消订阅函数。
  function subscribe(sub, { sinceSeq } = {}) {
    if (sinceSeq !== null && sinceSeq !== undefined && Number.isFinite(sinceSeq)) {
      if (hasGap(sinceSeq)) {
        const resetEnvelope = { seq: currentSeq(), type: "stream.reset", ts: new Date().toISOString(), data: {} };
        sub.write(frameFor(resetEnvelope));
      } else {
        for (const envelope of replaySince(sinceSeq)) sub.write(frameFor(envelope));
      }
    }
    subscribers.add(sub);
    return () => subscribers.delete(sub);
  }

  return {
    publish,
    subscribe,
    currentSeq,
    oldestBufferedSeq,
    hasGap,
    replaySince,
    subscriberCount: () => subscribers.size,
  };
}

export function handleSseRequest(hub, req, res, { pingIntervalMs = 25000 } = {}) {
  const url = new URL(req.url, "http://localhost");
  const sinceParam = url.searchParams.get("since");
  const lastEventId = req.headers["last-event-id"];
  const sinceRaw = sinceParam ?? lastEventId;
  const sinceSeq = sinceRaw !== undefined && sinceRaw !== null ? Number(sinceRaw) : null;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();

  const sub = { write: (frame) => res.write(frame) };
  const unsubscribe = hub.subscribe(sub, {
    sinceSeq: Number.isFinite(sinceSeq) ? sinceSeq : null,
  });

  const pingTimer = setInterval(() => {
    res.write(": ping\n\n");
  }, pingIntervalMs);
  pingTimer.unref?.();

  function cleanup() {
    clearInterval(pingTimer);
    unsubscribe();
  }

  req.on("close", cleanup);
}
