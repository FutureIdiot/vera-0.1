// Bounded, credential-safe Account login audit persistence.

import { randomBytes } from "node:crypto";
import { STATUS_BY_CODE } from "../core/errors.js";

const EVENTS = new Set(["enroll", "login", "reconnect", "logout", "session_revoked"]);
const RESULTS = new Set(["succeeded", "rejected"]);
const SESSION_REVOKED_REASONS = new Set([
  "access_key_rotated",
  "access_key_revoked",
  "security_revoked",
]);
const INPUT_KEYS = new Set([
  "accountId",
  "agentId",
  "event",
  "result",
  "reasonCode",
  "createdAt",
]);
const MAX_ACCOUNT_AUDITS = 200;

function auditId() {
  return `ala_${randomBytes(8).toString("hex")}`;
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("login audit input must be an object");
  }
  if (Object.keys(input).some((key) => !INPUT_KEYS.has(key))) {
    throw new TypeError("login audit input contains unsupported fields");
  }
  const accountId = requiredText(input.accountId, "accountId");
  const agentId = input.agentId === null ? null : requiredText(input.agentId, "agentId");
  const event = requiredText(input.event, "event");
  const result = requiredText(input.result, "result");
  if (!EVENTS.has(event)) throw new TypeError(`unsupported login audit event: ${event}`);
  if (!RESULTS.has(result)) throw new TypeError(`unsupported login audit result: ${result}`);

  let reasonCode = input.reasonCode;
  if (reasonCode !== null) reasonCode = requiredText(reasonCode, "reasonCode");
  if (event === "session_revoked") {
    if (result !== "succeeded" || !SESSION_REVOKED_REASONS.has(reasonCode)) {
      throw new TypeError("session_revoked audit must succeed with a supported reasonCode");
    }
  } else if (result === "succeeded" && reasonCode !== null) {
    throw new TypeError("successful login audit must use reasonCode=null");
  } else if (result === "rejected" && reasonCode === null) {
    throw new TypeError("rejected login audit requires a reasonCode");
  } else if (result === "rejected" && !Object.hasOwn(STATUS_BY_CODE, reasonCode)) {
    throw new TypeError("rejected login audit requires a stable API error code");
  }

  const createdAt = input.createdAt === undefined
    ? new Date().toISOString()
    : requiredText(input.createdAt, "createdAt");
  if (Number.isNaN(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
    throw new TypeError("createdAt must be an ISO timestamp");
  }
  return { accountId, agentId, event, result, reasonCode, createdAt };
}

function newestFirst(left, right) {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

export function recordAccountLoginAudit(store, input) {
  const normalized = normalizeInput(input);
  const account = store.find("accounts", normalized.accountId);
  if (!account) return null;
  const record = { id: auditId(), ...normalized };
  const loginAudits = [...(Array.isArray(account.loginAudits) ? account.loginAudits : []), record]
    .sort(newestFirst)
    .slice(0, MAX_ACCOUNT_AUDITS);
  store.update("accounts", account.id, { loginAudits });
  return structuredClone(record);
}

export function listAccountLoginAudits(store, accountId, { limit = 20 } = {}) {
  const normalizedAccountId = requiredText(accountId, "accountId");
  if (!Number.isInteger(limit) || limit < 0) throw new TypeError("limit must be a non-negative integer");
  const account = store.find("accounts", normalizedAccountId);
  if (!account) return [];
  return (Array.isArray(account.loginAudits) ? account.loginAudits : [])
    .toSorted(newestFirst)
    .slice(0, limit)
    .map((record) => ({
      id: record.id,
      accountId: record.accountId,
      agentId: record.agentId,
      event: record.event,
      result: record.result,
      reasonCode: record.reasonCode,
      createdAt: record.createdAt,
    }));
}
