// Account-bound Workspace control data. This module never reads or proxies
// Workspace files; it only validates and projects gateway-side bindings.

import { isAbsolute } from "node:path";
import { ApiError } from "../core/errors.js";

const UNAVAILABLE_STATUSES = new Set(["offline", "unavailable", "error"]);

function invalid(message) {
  throw new ApiError("invalid_request", message);
}

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) invalid(`${field} is required`);
  return value.trim();
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${field} must be an object`);
  return structuredClone(value);
}

export function projectWorkspace(workspace) {
  if (!workspace) return null;
  const safe = {};
  for (const field of ["accountId", "hostId", "status", "lastValidatedAt", "updatedAt"]) {
    if (workspace[field] !== undefined) safe[field] = structuredClone(workspace[field]);
  }
  return safe;
}

export function parseWorkspace(value, { requirePath = true, allowLastValidatedAt = true } = {}) {
  const workspace = object(value, "workspace");
  const allowed = new Set(["hostId", "path", "status", "policy", "lastValidatedAt"]);
  if (Object.keys(workspace).some((key) => !allowed.has(key))) invalid("workspace contains unsupported fields");
  const result = {
    hostId: text(workspace.hostId, "workspace.hostId"),
    status: text(workspace.status, "workspace.status"),
    policy: object(workspace.policy ?? {}, "workspace.policy"),
  };
  if (requirePath || workspace.path !== undefined) {
    const path = text(workspace.path, "workspace.path");
    if (!isAbsolute(path)) invalid("workspace.path must be absolute");
    result.path = path;
  }
  if (workspace.lastValidatedAt !== undefined) {
    if (!allowLastValidatedAt) invalid("workspace contains unsupported fields");
    result.lastValidatedAt = text(workspace.lastValidatedAt, "workspace.lastValidatedAt");
  }
  return result;
}

export function refreshWorkspaceBinding(account, incoming, { runtimeHostId }) {
  if (runtimeHostId !== incoming.hostId) {
    throw new ApiError("workspace_unavailable", "Workspace host does not match the Agent runtime host");
  }
  const current = account.workspace;
  const now = new Date().toISOString();
  if (!current) {
    return {
      ...incoming,
      accountId: account.id,
      lastValidatedAt: incoming.lastValidatedAt ?? now,
      updatedAt: now,
    };
  }
  if (current.hostId !== incoming.hostId || current.path !== incoming.path) {
    throw new ApiError("workspace_unavailable", "Workspace binding does not match this Account");
  }
  return {
    ...current,
    status: incoming.status,
    lastValidatedAt: incoming.lastValidatedAt ?? now,
    updatedAt: now,
  };
}

export function assertWorkspaceAvailable(workspace) {
  if (!workspace || UNAVAILABLE_STATUSES.has(workspace.status)) {
    throw new ApiError("workspace_unavailable", "Workspace is unavailable");
  }
}
