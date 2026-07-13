// HTTP 响应/请求体的小工具，供各 domain 的 routes.js 复用。

import { STATUS_BY_CODE, ApiError } from "../core/errors.js";
import { recordError } from "../core/status.js";

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

export function sendNoContent(res, status = 204) {
  res.writeHead(status);
  res.end();
}

export function sendError(res, status, code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  sendJson(res, status, { error });
}

export async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError("invalid_request", "request body is not valid JSON");
  }
}

// 包一层统一错误处理：domain 层只管抛 ApiError，这里按 code 映射状态码。
// 同时记录到 status tracker 的 recentErrors 环形缓冲（中控台用）。
export function asHandler(fn) {
  return async (ctx) => {
    try {
      await fn(ctx);
    } catch (err) {
      const code = err?.code || "internal";
      const status = STATUS_BY_CODE[code] || 500;
      sendError(ctx.res, status, code, err?.message || "internal error", err?.details);
      recordError("api", code, err?.message || "internal error");
    }
  };
}
