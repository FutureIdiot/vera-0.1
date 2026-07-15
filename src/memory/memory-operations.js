// MemoryOperation validation and compatibility wrappers for the current HTTP
// routes. Filesystem scanning/indexing stays in memory.js.

import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { ApiError } from "../core/errors.js";
import {
  MEMORY_SCHEMA_VERSION, computeMemoryVersion, serializeMemoryDocument,
  toIndexEntry, validateMemoryFields,
} from "./memory-format.js";
import {
  hasMemoryBatchMarker, removeMemoryBatchMarker, writeMemoryBatchMarker,
} from "./memory-index.js";

const PATCH_KEYS = new Set(["type", "description", "status", "content", "stains", "sources"]);
const HTTP_PATCH_KEYS = new Set(["type", "description", "status", "content", "stains", "ifMatch"]);
const CREATE_KEYS = new Set(["type", "description", "content", "stains", "sources"]);
const HTTP_CREATE_KEYS = new Set(["slug", "type", "description", "content", "stains"]);
const OPERATION_KEYS = new Set(["operationId", "agentId", "origin", "kind", "slug", "ifMatch", "value", "patch", "requestedAt"]);

function invalid(message) { return new ApiError("invalid_request", message); }
function nextTimestamp(previous) {
  const now = Date.now();
  const old = Date.parse(previous ?? "");
  return new Date(Number.isNaN(old) ? now : Math.max(now, old + 1)).toISOString();
}

export function createMemoryOperations(deps) {
  const {
    queue, rootSnapshot, getActiveRoot, assertAgentId, assertSlug, filePathFor,
    agentPathFor, readCanonical, scanAt, validateSourceRefs, atomicReplace,
    syncDirectory, invalidMemoryFile,
  } = deps;

  async function applyOperation(operation) {
    validateOperation(operation);
    const { agentId } = operation;
    return queue.enqueue(agentId, async () => {
      const snapshot = rootSnapshot();
      const result = await applyValidatedOperation(operation, snapshot, { scan: true });
      return result;
    });
  }

  function validateOperation(operation) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw invalid("memory operation must be an object");
    for (const key of Object.keys(operation)) if (!OPERATION_KEYS.has(key)) throw invalid(`unknown memory operation field: ${key}`);
    const { agentId, kind, slug } = operation;
    assertAgentId(agentId);
    assertSlug(slug);
    if (typeof operation.operationId !== "string" || !operation.operationId) throw invalid("operationId is required");
    if (!["user-api", "agent-mcp", "memory-hook", "memory-dream", "external-scan"].includes(operation.origin)) {
      throw invalid("origin must be user-api, agent-mcp, memory-hook, memory-dream, or external-scan");
    }
    if (!["create", "update", "archive", "delete"].includes(kind)) throw invalid(`unsupported memory operation: ${kind}`);
    if (typeof operation.requestedAt !== "string" || Number.isNaN(Date.parse(operation.requestedAt))) throw invalid("requestedAt must be ISO8601");
    if (kind === "create") {
      if (!operation.value || typeof operation.value !== "object" || Array.isArray(operation.value)) throw invalid("create operation requires value");
      if (operation.patch !== undefined || operation.ifMatch !== undefined) throw invalid("create operation cannot include patch or ifMatch");
    } else if (kind === "delete") {
      if (operation.value !== undefined || operation.patch !== undefined) throw invalid("delete operation cannot include value or patch");
      if (typeof operation.ifMatch !== "string" || !operation.ifMatch) throw invalid("delete operation requires ifMatch");
    } else {
      if (!operation.patch || typeof operation.patch !== "object" || Array.isArray(operation.patch)) throw invalid(`${kind} operation requires patch`);
      if (operation.value !== undefined) throw invalid(`${kind} operation cannot include value`);
      if (typeof operation.ifMatch !== "string" || !operation.ifMatch) throw invalid(`${kind} operation requires ifMatch`);
    }
    return operation;
  }

  async function applyValidatedOperation(operation, snapshot, { scan }) {
    const { agentId, kind, slug } = operation;
    const path = filePathFor(snapshot.root, agentId, slug);
    if (kind === "create") return createMemory({ operation, path, snapshot, scan });
    const current = await readCanonical(snapshot.root, agentId, slug, { upgradeLegacy: false });
    if (operation.ifMatch !== current.version) {
      const conflict = new ApiError("conflict", `memory ${slug} was modified`);
      conflict.details = { reason: "version_mismatch", current: { memory: current } };
      throw conflict;
    }
    if (kind === "delete") {
      try { await unlink(path); await syncDirectory(agentPathFor(snapshot.root, agentId)); }
      catch (error) {
        if (error.code === "ENOENT") throw new ApiError("not_found", `memory ${slug} does not exist for agent ${agentId}`);
        throw error;
      }
      if (scan) await scanAt(snapshot.root, agentId, { force: true, queueHeld: true });
      return null;
    }
    return updateMemoryFile({ operation, current, path, snapshot, scan });
  }

  async function createMemory({ operation, path, snapshot, scan }) {
    const { agentId, slug } = operation;
    const input = operation.value;
    for (const key of Object.keys(input)) if (!CREATE_KEYS.has(key)) throw invalid(`unknown memory create field: ${key}`);
    const now = new Date().toISOString();
    const memory = {
      slug, schemaVersion: MEMORY_SCHEMA_VERSION, scope: { type: "agent", agentId },
      sources: await validateSourceRefs(input.sources ?? [{ kind: "manual", actor: "user", capturedAt: now }]),
      type: input.type, description: input.description, status: "active",
      stains: input.stains ?? {}, createdAt: now, updatedAt: now,
      content: input.content ?? "",
    };
    validateMemoryFields(memory, { agentId });
    memory.version = computeMemoryVersion(memory);
    try { await atomicReplace(path, serializeMemoryDocument(memory), { createOnly: true }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const conflict = new ApiError("conflict", `memory ${slug} already exists for agent ${agentId}`);
      let current = null;
      try { current = toIndexEntry(await readCanonical(snapshot.root, agentId, slug, { upgradeLegacy: false })); } catch {}
      conflict.details = { reason: "slug_exists", current: { memory: current } };
      throw conflict;
    }
    if (scan) await scanAt(snapshot.root, agentId, { force: true, queueHeld: true });
    return toIndexEntry(memory);
  }

  async function updateMemoryFile({ operation, current, path, snapshot, scan }) {
    const { agentId, kind, slug } = operation;
    const patch = kind === "archive" ? { ...operation.patch, status: "archived" } : operation.patch;
    for (const key of Object.keys(patch)) if (!PATCH_KEYS.has(key)) throw invalid(`unknown memory patch field: ${key}`);
    const updated = {
      ...current,
      type: patch.type ?? current.type,
      description: patch.description ?? current.description,
      status: patch.status ?? current.status,
      stains: patch.stains ?? current.stains,
      sources: patch.sources === undefined ? current.sources : await validateSourceRefs(patch.sources),
      content: patch.content ?? current.content,
      updatedAt: nextTimestamp(current.updatedAt),
    };
    validateMemoryFields(updated, { agentId });
    updated.sources = await validateSourceRefs(updated.sources);
    updated.version = computeMemoryVersion(updated);
    await atomicReplace(path, serializeMemoryDocument(updated));
    if (scan) await scanAt(snapshot.root, agentId, { force: true, queueHeld: true });
    return updated;
  }

  async function applyBatch(agentId, operations, { onApplied, onRolledBack } = {}) {
    assertAgentId(agentId);
    if (!Array.isArray(operations) || operations.length === 0) throw invalid("memory batch must contain operations");
    for (const operation of operations) {
      validateOperation(operation);
      if (operation.agentId !== agentId) throw invalid("memory batch cannot cross Agent scope");
    }
    return queue.enqueue(agentId, async () => {
      const snapshot = rootSnapshot();
      const before = [];
      // Preflight every target version before the first file changes.
      for (const operation of operations) {
        if (operation.kind === "create") { before.push(null); continue; }
        const current = await readCanonical(snapshot.root, agentId, operation.slug, { upgradeLegacy: false });
        if (operation.ifMatch !== current.version) {
          const conflict = new ApiError("conflict", `memory ${operation.slug} was modified`);
          conflict.details = { reason: "version_mismatch", current: { memory: current } };
          throw conflict;
        }
        before.push(current);
      }
      await writeMemoryBatchMarker(snapshot.root, agentId);
      const results = [];
      const applied = [];
      let failure = null;
      try {
        for (let index = 0; index < operations.length; index += 1) {
          const result = await applyValidatedOperation(operations[index], snapshot, { scan: false });
          results.push(result);
          applied.push({ index, operation: operations[index], before: before[index] });
          await onApplied?.({ index, operation: operations[index], result });
        }
      } catch (error) {
        failure = error;
      }
      if (failure) {
        try {
          for (const item of [...applied].reverse()) {
            const path = filePathFor(snapshot.root, agentId, item.operation.slug);
            if (item.operation.kind === "create") {
              try { await unlink(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
            } else {
              await atomicReplace(path, serializeMemoryDocument(item.before));
            }
          }
          await scanAt(snapshot.root, agentId, { force: true, queueHeld: true, allowPendingBatch: true });
          await removeMemoryBatchMarker(snapshot.root, agentId);
          await onRolledBack?.({ operations: applied.map((item) => item.operation) });
        } catch {
          // Leave the durable marker in place. Ordinary reads fail closed until
          // the owning job retries and publishes one complete generation.
        }
        throw failure;
      }
      await scanAt(snapshot.root, agentId, { force: true, queueHeld: true, allowPendingBatch: true });
      await removeMemoryBatchMarker(snapshot.root, agentId);
      return results;
    });
  }

  async function finalizeBatch(agentId) {
    assertAgentId(agentId);
    return queue.enqueue(agentId, async () => {
      const snapshot = rootSnapshot();
      if (!await hasMemoryBatchMarker(snapshot.root, agentId)) return false;
      await scanAt(snapshot.root, agentId, { force: true, queueHeld: true, allowPendingBatch: true });
      await removeMemoryBatchMarker(snapshot.root, agentId);
      return true;
    });
  }

  async function saveMemory(agentId, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("memory create body must be an object");
    for (const key of Object.keys(input)) if (!HTTP_CREATE_KEYS.has(key)) throw invalid(`unknown memory create field: ${key}`);
    const { slug, ...value } = input;
    return applyOperation({
      operationId: `mop_${randomUUID()}`, agentId, origin: "user-api", kind: "create",
      slug, value, requestedAt: new Date().toISOString(),
    });
  }

  async function getMemory(agentId, slug) {
    return queue.enqueue(agentId, async () => {
      try {
        const memory = await readCanonical(getActiveRoot(), agentId, slug, { queueHeld: true });
        memory.sources = await validateSourceRefs(memory.sources);
        return memory;
      } catch (error) {
        if (error.code === "invalid_request") throw invalidMemoryFile(agentId, slug, error);
        throw error;
      }
    });
  }

  async function updateMemory(agentId, slug, patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw invalid("memory patch must be an object");
    for (const key of Object.keys(patch)) if (!HTTP_PATCH_KEYS.has(key)) throw invalid(`unknown memory patch field: ${key}`);
    if (typeof patch.ifMatch !== "string" || !patch.ifMatch) throw invalid("ifMatch is required");
    const { ifMatch, ...operationPatch } = patch;
    return applyOperation({
      operationId: `mop_${randomUUID()}`, agentId, origin: "user-api", kind: "update",
      slug, ifMatch, patch: operationPatch, requestedAt: new Date().toISOString(),
    });
  }

  async function deleteMemory(agentId, slug, ifMatch) {
    await applyOperation({
      operationId: `mop_${randomUUID()}`, agentId, origin: "user-api", kind: "delete",
      slug, ifMatch, requestedAt: new Date().toISOString(),
    });
  }

  return { applyOperation, applyBatch, finalizeBatch, saveMemory, getMemory, updateMemory, deleteMemory };
}
