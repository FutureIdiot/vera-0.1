// AgentState is daemon-declared, per-Agent + Account + Space runtime state.
// It is intentionally process-local and independent from Account presence.

import { ApiError } from "../core/errors.js";

export const AGENT_STATE_STATUSES = Object.freeze([
  "idle",
  "thinking",
  "typing",
  "reading",
  "coding",
  "reviewing",
  "on_task",
  "away",
]);

const STATUS_SET = new Set(AGENT_STATE_STATUSES);
const DECLARATION_KEYS = ["accountId", "agentId", "detail", "spaceId", "status"];

function invalid(message) {
  throw new ApiError("invalid_request", message);
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) invalid(`${field} must be a non-empty string`);
  return value.trim();
}

function validateAuthority(authority) {
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    invalid("AgentState authority must be an object");
  }
  const agentId = requiredText(authority.agentId, "authority.agentId");
  const accountId = requiredText(authority.accountId, "authority.accountId");
  const spaceId = requiredText(authority.spaceId, "authority.spaceId");
  const ownerAgentId = requiredText(authority.ownerAgentId, "authority.ownerAgentId");
  if (agentId !== ownerAgentId) {
    throw new ApiError("delegation_unavailable", "Agent is not the Account owner");
  }
  return { agentId, accountId, spaceId };
}

function validateDeclaration(declaration) {
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    invalid("AgentState declaration must be an object");
  }
  const keys = Object.keys(declaration).sort();
  if (keys.length !== DECLARATION_KEYS.length
    || keys.some((key, index) => key !== DECLARATION_KEYS[index])) {
    invalid(`AgentState declaration fields must be exactly: ${DECLARATION_KEYS.join(", ")}`);
  }
  const agentId = requiredText(declaration.agentId, "agentId");
  const accountId = requiredText(declaration.accountId, "accountId");
  const spaceId = requiredText(declaration.spaceId, "spaceId");
  if (!STATUS_SET.has(declaration.status)) {
    invalid(`status must be one of: ${AGENT_STATE_STATUSES.join(", ")}`);
  }
  if (typeof declaration.detail !== "string" || /[\r\n]/u.test(declaration.detail)) {
    invalid("detail must be a single-line string");
  }
  return {
    agentId,
    accountId,
    spaceId,
    status: declaration.status,
    detail: declaration.detail,
  };
}

function keyOf({ agentId, accountId, spaceId }) {
  return `${agentId}:${accountId}:${spaceId}`;
}

function cloneState(state) {
  return { ...state };
}

export function createAgentStateTracker({ hub, now = () => new Date() }) {
  const states = new Map();

  function declare(authorityInput, declarationInput) {
    const authority = validateAuthority(authorityInput);
    const declaration = validateDeclaration(declarationInput);
    for (const field of ["agentId", "accountId", "spaceId"]) {
      if (declaration[field] !== authority[field]) {
        throw new ApiError("forbidden", `AgentState ${field} does not match authenticated authority`);
      }
    }
    const state = {
      ...declaration,
      lastActiveAt: now().toISOString(),
    };
    states.set(keyOf(state), state);
    const projected = cloneState(state);
    hub?.publish("agent.state.updated", { agentState: projected });
    return projected;
  }

  function list({ spaceId, accountId, agentId } = {}) {
    let result = Array.from(states.values());
    if (spaceId) result = result.filter((state) => state.spaceId === spaceId);
    if (accountId) result = result.filter((state) => state.accountId === accountId);
    if (agentId) result = result.filter((state) => state.agentId === agentId);
    return result.map(cloneState);
  }

  // Transitional compatibility for the gateway-local Run path. These methods
  // intentionally do nothing: gateway execution cannot authoritatively infer a
  // daemon's fine-grained state, and the removed `working` status is invalid.
  function ensure() { return null; }
  function setWorking() { return null; }
  function setIdle() { return null; }

  return { declare, list, ensure, setWorking, setIdle };
}
