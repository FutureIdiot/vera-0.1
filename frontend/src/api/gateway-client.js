// gateway client：唯一知道 HTTP 路径形状与 SSE 连接细节的模块
// （docs/api-contract.md 三、四）。页面逻辑不得直接 fetch，都经这里。

async function requestJson(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(json?.error?.message || `${method} ${path} failed with ${res.status}`);
    err.status = res.status;
    err.code = json?.error?.code;
    throw err;
  }
  return json;
}

export function fetchBootstrap() {
  return requestJson("GET", "/api/bootstrap");
}

export function fetchTimeline(spaceId, { before, limit } = {}) {
  const params = new URLSearchParams();
  if (before) params.set("before", before);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return requestJson("GET", `/api/spaces/${spaceId}/timeline${qs ? `?${qs}` : ""}`);
}

export function postMessage(spaceId, { author, target, content }) {
  return requestJson("POST", `/api/spaces/${spaceId}/messages`, { author, target, content });
}

export function answerApproval(approvalId, answer) {
  return requestJson("POST", `/api/approvals/${approvalId}/answer`, { answer });
}

export function createSpace(body) {
  return requestJson("POST", "/api/spaces", body);
}

export function createAgent(body) {
  return requestJson("POST", "/api/agents", body);
}

// 打开一条 SSE 连接（原生 EventSource）。只负责这一次连接：收帧、转发给
// onEvent；连接层面的断线重连/退避策略由 frontend/src/hooks/ 的
// reconnecting-event-stream.js 负责，这里保持单一职责。
export function connectEvents({ since, onEvent, onOpen, onError } = {}) {
  const url = since !== undefined && since !== null ? `/api/events?since=${since}` : "/api/events";
  const source = new EventSource(url);
  source.onopen = () => onOpen?.();
  source.onerror = (evt) => onError?.(evt);
  source.onmessage = (evt) => {
    let envelope;
    try {
      envelope = JSON.parse(evt.data);
    } catch {
      return; // 畸形帧，静默丢弃
    }
    onEvent?.(envelope);
  };
  return source;
}
