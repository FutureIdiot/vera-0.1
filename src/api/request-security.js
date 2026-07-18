// Unified outer request boundary for Owner Tailscale identity and native CORS.

import { sendError, sendNoContent } from "./http.js";
import { recordError } from "../core/status.js";

const ALLOWED_METHODS = Object.freeze(["GET", "POST", "PATCH", "DELETE", "OPTIONS"]);
const ALLOWED_HEADERS = Object.freeze(["Authorization", "Content-Type", "Last-Event-ID"]);
const ALLOWED_HEADER_SET = new Set(ALLOWED_HEADERS.map((header) => header.toLowerCase()));

function headerValue(req, name) {
  const value = req.headers?.[name.toLowerCase()];
  return typeof value === "string" ? value : null;
}

export function isLoopbackAddress(remoteAddress) {
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

function mergeVary(res, value) {
  const current = res.getHeader?.("Vary");
  const values = new Map();
  for (const item of `${current ?? ""},${value}`.split(",").map((part) => part.trim()).filter(Boolean)) {
    values.set(item.toLowerCase(), item);
  }
  res.setHeader("Vary", [...values.values()].join(", "));
}

function effectiveSameOrigin(req, config, loopback) {
  const host = headerValue(req, "host");
  if (!host) return null;
  const scheme = config.security.allowLoopbackDevelopment && loopback
    ? req.socket?.encrypted ? "https" : "http"
    : "https";
  return `${scheme}://${host}`;
}

function requestedHeaders(req) {
  const raw = headerValue(req, "access-control-request-headers");
  if (!raw) return [];
  return raw.split(",").map((header) => header.trim()).filter(Boolean);
}

function forbid(res) {
  sendError(res, 403, "forbidden", "Owner access is forbidden");
  return true;
}

function applyCors(req, res, config, loopback) {
  const origin = headerValue(req, "origin");
  if (!origin) return false;
  const allowedOrigins = config.security.cors.allowedOrigins;
  const allowlisted = allowedOrigins.includes(origin);
  const sameOrigin = origin === effectiveSameOrigin(req, config, loopback);
  if (!allowlisted && !sameOrigin) return forbid(res);

  // ACAO is needed only for a configured cross-origin client. Same-origin Web
  // requests remain ordinary same-origin traffic.
  if (allowlisted) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    mergeVary(res, "Origin");
  }
  if (req.method !== "OPTIONS") return false;

  const method = (headerValue(req, "access-control-request-method") ?? "").toUpperCase();
  const headers = requestedHeaders(req);
  if (!ALLOWED_METHODS.includes(method) || headers.some((header) => !ALLOWED_HEADER_SET.has(header.toLowerCase()))) {
    // A rejected preflight must not retain authorization headers set above.
    res.removeHeader?.("Access-Control-Allow-Origin");
    res.removeHeader?.("Access-Control-Allow-Methods");
    res.removeHeader?.("Access-Control-Allow-Headers");
    return forbid(res);
  }
  res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS.join(", "));
  res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS.join(", "));
  sendNoContent(res);
  return true;
}

export function createRequestSecurity({ config }) {
  if (!config?.security) throw new TypeError("request security requires config.security");
  const ownerLogins = config.security.ownerTailscaleLogins;

  return function handleRequestSecurity(req, res) {
    const remoteAddress = req.socket?.remoteAddress ?? null;
    const loopback = isLoopbackAddress(remoteAddress);
    if (applyCors(req, res, config, loopback)) return true;

    const path = new URL(req.url, "http://localhost").pathname;
    if (req.method === "GET" && path === "/api/health") return false;
    if (path.startsWith("/api/agent/")) return false;

    const login = loopback ? headerValue(req, "tailscale-user-login") : null;
    if (loopback && config.security.allowLoopbackDevelopment && login === null) return false;
    if (ownerLogins.length > 0 && login !== null && ownerLogins.includes(login)) return false;

    if (ownerLogins.length === 0) {
      recordError("security", "forbidden", "Owner Tailscale login allowlist is not configured");
    } else if (login === null) {
      recordError("security", "forbidden", "Owner Tailscale identity is required");
    } else {
      recordError("security", "forbidden", "Owner Tailscale identity was rejected");
    }
    return forbid(res);
  };
}

export const CORS_METHODS = ALLOWED_METHODS;
export const CORS_HEADERS = ALLOWED_HEADERS;
