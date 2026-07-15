// Per-Agent MCP/Hook bindings. Built-in unit metadata is immutable; only the
// enabled flag is mutable in M4, guarded by an opaque binding version.

import { randomUUID } from "node:crypto";
import { ApiError } from "../core/errors.js";

const BINDING_KINDS = new Set(["mcp", "hook"]);
const PATCH_KEYS = new Set(["enabled", "ifMatch"]);

export const BUILT_IN_UNITS = Object.freeze([
  Object.freeze({
    unitId: "vera.memory",
    kind: "mcp",
    name: "Vera Memory MCP",
    runtime: "gateway",
    availability: "available",
  }),
  Object.freeze({
    unitId: "vera.memory.recall",
    kind: "hook",
    name: "Vera Memory Recall Hook",
    runtime: "gateway",
    availability: "available",
  }),
  Object.freeze({
    unitId: "vera.memory.write",
    kind: "hook",
    name: "Vera Memory Write Hook",
    runtime: "gateway",
    availability: "available",
  }),
]);

const UNIT_BY_ID = new Map(BUILT_IN_UNITS.map((unit) => [unit.unitId, unit]));

function invalid(message) {
  return new ApiError("invalid_request", message);
}

function bindingId(agentId, unitId) {
  return `${agentId}:${unitId}`;
}

function newVersion() {
  return `ubv_${randomUUID().replaceAll("-", "")}`;
}

function assertAgent(store, agentId) {
  if (!store.find("agents", agentId)) {
    throw new ApiError("not_found", `agent ${agentId} does not exist`);
  }
}

function toPublicBinding(record, unit) {
  return {
    agentId: record.agentId,
    unitId: unit.unitId,
    kind: unit.kind,
    name: unit.name,
    enabled: record.enabled,
    runtime: unit.runtime,
    availability: unit.availability,
    version: record.version,
  };
}

function findStoredBinding(store, agentId, unitId) {
  return store.list("unitBindings").find(
    (binding) => binding.agentId === agentId && binding.unitId === unitId,
  ) ?? null;
}

/**
 * Idempotently creates all built-in bindings for an existing Agent.
 * Returns public bindings in manifest order.
 */
export function ensureUnitBindings(store, agentId) {
  assertAgent(store, agentId);
  const now = new Date().toISOString();

  return BUILT_IN_UNITS.map((unit) => {
    let record = findStoredBinding(store, agentId, unit.unitId);
    if (!record) {
      record = store.insert("unitBindings", {
        id: bindingId(agentId, unit.unitId),
        agentId,
        unitId: unit.unitId,
        enabled: true,
        version: newVersion(),
        createdAt: now,
        updatedAt: now,
      });
    }
    return toPublicBinding(record, unit);
  });
}

/**
 * Lists one kind of binding. The HTTP contract requires an explicit kind.
 */
export function listUnitBindings(store, agentId, { kind } = {}) {
  if (!BINDING_KINDS.has(kind)) {
    throw invalid("kind must be mcp or hook");
  }
  return ensureUnitBindings(store, agentId).filter((binding) => binding.kind === kind);
}

/**
 * Reads one binding after ensuring the Agent's built-in defaults exist.
 */
export function getUnitBinding(store, agentId, unitId) {
  const unit = UNIT_BY_ID.get(unitId);
  if (!unit) throw new ApiError("not_found", `unit ${unitId} does not exist`);
  ensureUnitBindings(store, agentId);
  return toPublicBinding(findStoredBinding(store, agentId, unitId), unit);
}

/**
 * M4 built-ins accept exactly { enabled, ifMatch }. Immutable manifest fields,
 * executorAgentId and all unknown fields are rejected.
 */
export function updateUnitBinding(store, agentId, unitId, patch) {
  assertAgent(store, agentId);
  const unit = UNIT_BY_ID.get(unitId);
  if (!unit) throw new ApiError("not_found", `unit ${unitId} does not exist`);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw invalid("unit binding patch must be an object");
  }
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.has(key)) throw invalid(`unknown unit binding field: ${key}`);
  }
  if (Object.keys(patch).length !== PATCH_KEYS.size || !("enabled" in patch) || !("ifMatch" in patch)) {
    throw invalid("unit binding patch must be exactly { enabled, ifMatch }");
  }
  if (typeof patch.enabled !== "boolean") throw invalid("enabled must be boolean");
  if (typeof patch.ifMatch !== "string" || !patch.ifMatch) throw invalid("ifMatch is required");

  ensureUnitBindings(store, agentId);
  const current = findStoredBinding(store, agentId, unitId);
  if (patch.ifMatch !== current.version) {
    throw new ApiError("conflict", "unit binding version does not match", {
      reason: "version_mismatch",
      current: { binding: toPublicBinding(current, unit) },
    });
  }

  const updated = store.update("unitBindings", current.id, {
    enabled: patch.enabled,
    version: newVersion(),
    updatedAt: new Date().toISOString(),
  });
  return toPublicBinding(updated, unit);
}
