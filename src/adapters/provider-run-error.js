// Turn provider-specific chat failures into stable public Run errors.
// Prefer the provider's own message, but never expose an entire body or stderr
// stream and redact explicit credential values.

import { AdapterError } from "../core/errors.js";

const QUOTA_CODES = new Set([
  "credit_balance_exhausted",
  "credits_exhausted",
  "insufficient_quota",
  "quota_exceeded",
  "quota_exhausted",
  "usage_limit_reached",
]);

const RATE_CODES = new Set([
  "rate_limit_exceeded",
  "rate_limited",
  "resource_exhausted",
  "too_many_requests",
]);

const SAFE_CODE = /^[a-z][a-z0-9_-]{0,63}$/u;
const MAX_PUBLIC_MESSAGE_CHARS = 600;

function normalized(value) {
  return String(value ?? "")
    .toLocaleLowerCase("und")
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function collectSignals(value, result = [], depth = 0) {
  if (depth > 3 || value == null) return result;
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    if (text) result.push(text);
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) collectSignals(item, result, depth + 1);
    return result;
  }
  if (typeof value !== "object") return result;
  for (const key of ["code", "type", "reason", "status", "message", "error"]) {
    if (Object.hasOwn(value, key)) collectSignals(value[key], result, depth + 1);
  }
  return result;
}

function collectNativeMessages(value, result = [], depth = 0) {
  if (depth > 4 || value == null) return result;
  if (typeof value === "string") {
    const text = value.trim();
    if (text) result.push(text);
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) collectNativeMessages(item, result, depth + 1);
    return result;
  }
  if (typeof value !== "object") return result;
  for (const key of ["message", "error", "errors", "cause", "detail", "details"]) {
    if (Object.hasOwn(value, key)) collectNativeMessages(value[key], result, depth + 1);
  }
  return result;
}

function classification(payload, stderr) {
  const signals = collectSignals(payload);
  if (typeof stderr === "string" && stderr.trim()) signals.push(stderr.slice(0, 8000));
  const codes = new Set(signals.map(normalized).filter((value) => SAFE_CODE.test(value)));
  const text = signals.join(" ").toLocaleLowerCase("und");

  const quota = [...codes].some((code) => QUOTA_CODES.has(code)) ||
    /\b(?:insufficient|exhausted|exceeded)[ _-]?quota\b/u.test(text) ||
    /\bquota[ _-]?(?:exhausted|exceeded)\b/u.test(text) ||
    /\b(?:credits?|credit balance)(?: (?:are|is))? (?:depleted|exhausted|used up)\b/u.test(text) ||
    /\b(?:hit|reached) (?:your |the )?usage limit\b/u.test(text) ||
    /\bout of credits?\b/u.test(text);
  if (quota) return "quota_exhausted";

  const rate = [...codes].some((code) => RATE_CODES.has(code)) ||
    /\brate[ _-]?limit(?:ed| exceeded)?\b/u.test(text) ||
    /\btoo many requests\b/u.test(text) ||
    /(?:^|\D)429(?:\D|$)/u.test(text);
  if (rate) return "rate_limited";

  if (/\b(?:unauthenticated|unauthorized|authentication failed|login required|not logged in|sign in required|invalid api key)\b/u.test(text) ||
      /(?:^|\D)401(?:\D|$)/u.test(text)) {
    return "authentication";
  }
  if (/\b(?:unknown|invalid|unsupported) model\b/u.test(text) ||
      /\bmodel\b.{0,60}\b(?:not found|unavailable|unsupported)\b/u.test(text)) {
    return "model";
  }
  if (/\b(?:connection refused|connection reset|network unavailable|service unavailable)\b/u.test(text) ||
      /(?:^|\D)503(?:\D|$)/u.test(text)) {
    return "service";
  }
  return "provider_error";
}

function truncateCharacters(value, limit) {
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  return `${characters.slice(0, limit - 1).join("")}…`;
}

function redactNativeMessage(value) {
  let message = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!message) return "";

  message = message
    .replace(/(\b(?:https?|wss?):\/\/)[^/\s:@]+:[^/\s@]+@/giu, "$1[redacted]@")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gu, "$1 [redacted]")
    .replace(
      /\b((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[redacted]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[credential redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[credential redacted]")
    .replace(/\s+/gu, " ")
    .trim();

  const informative = message
    .replace(/\[(?:credential )?redacted\]/giu, "")
    .replace(/[^A-Za-z0-9\u0080-\u{10ffff}]+/gu, "");
  if (informative.length < 3) return "";
  return truncateCharacters(message, MAX_PUBLIC_MESSAGE_CHARS);
}

function nativeMessage(payload, stderr, kind) {
  for (const candidate of collectNativeMessages(payload)) {
    const safe = redactNativeMessage(candidate);
    if (safe) return safe;
  }
  if (kind === "provider_error" || typeof stderr !== "string") return "";
  for (const line of stderr.split(/\r?\n/u).slice(0, 20)) {
    if (classification(null, line) !== kind) continue;
    const safe = redactNativeMessage(line);
    if (safe) return safe;
  }
  return "";
}

export function publicProviderRunError(provider, { payload = null, stderr = "" } = {}) {
  const kind = classification(payload, stderr);
  const original = nativeMessage(payload, stderr, kind);
  if (original) {
    const code = kind === "quota_exhausted" || kind === "rate_limited"
      ? kind
      : "provider_error";
    return new AdapterError(code, `${provider}: ${original}`);
  }
  if (kind === "quota_exhausted") {
    return new AdapterError(
      "quota_exhausted",
      `${provider} 账号额度已用完，请等待额度恢复后重试。`,
    );
  }
  if (kind === "rate_limited") {
    return new AdapterError(
      "rate_limited",
      `${provider} 当前请求受到临时限流，请稍后重试。`,
    );
  }
  const messages = {
    authentication: `${provider} 登录已失效，请在 Agent 宿主重新登录后重试。`,
    model: `${provider} 当前模型不可用，请检查 Account 的模型设置。`,
    service: `${provider} 服务暂时不可达，请稍后重试。`,
    provider_error: `${provider} 执行失败，provider 未返回可安全公开的具体原因。`,
  };
  return new AdapterError("provider_error", messages[kind]);
}
