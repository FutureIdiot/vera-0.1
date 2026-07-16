// P5-C1 SpaceSession / AgentSession domain truth. Provider bindings and API
// histories are generation-scoped and use integer CAS versions. All mutations
// are synchronous store operations so each command commits as one in-process
// critical section before any caller can observe an intermediate state.

import {
  newAgentSessionId,
  newContextControlRequestId,
  newSpaceSessionId,
} from "../core/id.js";
import { ApiError } from "../core/errors.js";

const ACTIVE_RUN_STATUSES = new Set(["pending", "running"]);
const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);

function nowIso(now) {
  return typeof now === "function" ? now() : now ?? new Date().toISOString();
}

function stripInternal({ _seq, ...record }) {
  return structuredClone(record);
}

function publicAgentSession(record) {
  const { _seq, checkpoints, ...session } = record;
  return structuredClone(session);
}

export function projectAgentSession(record) {
  return record ? publicAgentSession(record) : null;
}

function invalid(message) {
  return new ApiError("invalid_request", message);
}

function conflict(message) {
  return new ApiError("conflict", message);
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw invalid(`${name} must be a non-empty string`);
  return value.trim();
}

function findSpaceSession(store, id) {
  const session = store.find("spaceSessions", id);
  if (!session) throw new ApiError("not_found", `space session ${id} does not exist`);
  return session;
}

function findAgentSession(store, id) {
  const session = store.find("agentSessions", id);
  if (!session) throw new ApiError("not_found", `agent session ${id} does not exist`);
  return session;
}

function defaultContext(context = {}) {
  const estimatedInputTokens = Number.isFinite(context.estimatedInputTokens) && context.estimatedInputTokens >= 0
    ? context.estimatedInputTokens
    : 0;
  const effectiveLimitTokens = Number.isFinite(context.effectiveLimitTokens) && context.effectiveLimitTokens >= 0
    ? context.effectiveLimitTokens
    : 0;
  return {
    checkpointVersion: Number.isInteger(context.checkpointVersion) && context.checkpointVersion >= 0
      ? context.checkpointVersion
      : 0,
    estimatedInputTokens,
    effectiveLimitTokens,
    pressureRatio: effectiveLimitTokens > 0 ? estimatedInputTokens / effectiveLimitTokens : 0,
    measurement: ["provider_reported", "tokenizer", "estimate"].includes(context.measurement)
      ? context.measurement
      : "estimate",
  };
}

function createSpaceSessionRecord(store, spaceId, timestamp) {
  return store.insert("spaceSessions", {
    id: newSpaceSessionId(),
    spaceId,
    status: "active",
    createdAt: timestamp,
    archivedAt: null,
    archiveReason: null,
  });
}

export function ensureActiveSpaceSession(store, spaceId, { now } = {}) {
  const space = store.find("spaces", spaceId);
  if (!space) throw new ApiError("not_found", `space ${spaceId} does not exist`);
  let session = space.activeSpaceSessionId ? store.find("spaceSessions", space.activeSpaceSessionId) : null;
  if (session && session.spaceId === spaceId && session.status === "active") return stripInternal(session);
  const active = store.list("spaceSessions").filter((item) => item.spaceId === spaceId && item.status === "active");
  if (active.length > 1) throw conflict(`space ${spaceId} has multiple active sessions`);
  const timestamp = nowIso(now);
  session = active[0] ?? createSpaceSessionRecord(store, spaceId, timestamp);
  store.update("spaces", spaceId, { activeSpaceSessionId: session.id });
  return stripInternal(session);
}

export function ensureAgentSession(store, { spaceSessionId, agentId, context } = {}, { now } = {}) {
  requireString(spaceSessionId, "spaceSessionId");
  requireString(agentId, "agentId");
  const spaceSession = findSpaceSession(store, spaceSessionId);
  if (spaceSession.status !== "active") throw conflict(`space session ${spaceSessionId} is archived`);
  if (!store.find("agents", agentId)) throw new ApiError("not_found", `agent ${agentId} does not exist`);
  const matches = store.list("agentSessions").filter((item) =>
    item.spaceSessionId === spaceSessionId && item.agentId === agentId);
  if (matches.length > 1) throw conflict(`agent ${agentId} has multiple sessions in ${spaceSessionId}`);
  if (matches[0]) return publicAgentSession(matches[0]);
  const timestamp = nowIso(now);
  const session = store.insert("agentSessions", {
    id: newAgentSessionId(),
    spaceSessionId,
    agentId,
    status: "active",
    generation: 1,
    context: defaultContext(context),
    checkpoints: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return publicAgentSession(session);
}

export function getActiveContext(store, { spaceId, agentId } = {}) {
  const spaceSession = ensureActiveSpaceSession(store, spaceId);
  const agentSession = ensureAgentSession(store, { spaceSessionId: spaceSession.id, agentId });
  return { spaceSession, agentSession };
}

function requestResult(store, request) {
  const archivedSession = request.result?.archivedSpaceSessionId
    ? store.find("spaceSessions", request.result.archivedSpaceSessionId)
    : null;
  const newSession = request.result?.newSpaceSessionId
    ? store.find("spaceSessions", request.result.newSpaceSessionId)
    : null;
  if (!archivedSession || !newSession) throw new ApiError("internal", "context control request result is incomplete");
  return { archivedSession: stripInternal(archivedSession), newSession: stripInternal(newSession) };
}

export function startNewSpaceSession(store, { spaceId, requestId } = {}, { now } = {}) {
  requireString(spaceId, "spaceId");
  requireString(requestId, "requestId");
  const priorRequest = store.list("contextControlRequests").find((item) =>
    item.type === "new" && item.spaceId === spaceId && item.requestId === requestId);
  if (priorRequest) return requestResult(store, priorRequest);
  const space = store.find("spaces", spaceId);
  if (!space) throw new ApiError("not_found", `space ${spaceId} does not exist`);
  const current = ensureActiveSpaceSession(store, spaceId);
  const busyRun = store.list("runs").some((run) =>
    run.spaceSessionId === current.id && ACTIVE_RUN_STATUSES.has(run.status));
  const busyCompaction = store.list("contextCompactionJobs").some((job) =>
    job.spaceSessionId === current.id && ACTIVE_JOB_STATUSES.has(job.status));
  if (busyRun || busyCompaction) throw new ApiError("session_busy", `space ${spaceId} has active context work`);
  for (const seat of space.seats ?? []) {
    if (!store.find("agents", seat.agentId)) {
      throw conflict(`space ${spaceId} references missing agent ${seat.agentId}`);
    }
  }

  const timestamp = nowIso(now);
  store.update("spaceSessions", current.id, {
    status: "archived", archivedAt: timestamp, archiveReason: "new_command",
  });
  for (const agentSession of store.list("agentSessions").filter((item) => item.spaceSessionId === current.id)) {
    store.update("agentSessions", agentSession.id, { status: "archived", updatedAt: timestamp });
    for (const recall of store.list("memoryRecallSessions").filter((item) =>
      item.agentSessionId === agentSession.id && item.status === "active")) {
      store.update("memoryRecallSessions", recall.id, {
        status: "frozen", frozenAt: timestamp, updatedAt: timestamp,
      });
    }
  }
  const next = createSpaceSessionRecord(store, spaceId, timestamp);
  store.update("spaces", spaceId, { activeSpaceSessionId: next.id });
  for (const seat of space.seats ?? []) {
    ensureAgentSession(store, { spaceSessionId: next.id, agentId: seat.agentId }, { now: timestamp });
  }
  store.insert("contextControlRequests", {
    id: newContextControlRequestId(), type: "new", spaceId, requestId,
    status: "succeeded",
    result: { archivedSpaceSessionId: current.id, newSpaceSessionId: next.id },
    createdAt: timestamp, finishedAt: timestamp,
  });
  return { archivedSession: stripInternal(store.find("spaceSessions", current.id)), newSession: stripInternal(next) };
}
