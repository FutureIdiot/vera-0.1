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
import { agentModelContext } from "../agents/runtime-contexts.js";

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
  const contextWindowTokens = Number.isInteger(context.contextWindowTokens) && context.contextWindowTokens > 0
    ? context.contextWindowTokens
    : 0;
  return {
    checkpointVersion: Number.isInteger(context.checkpointVersion) && context.checkpointVersion >= 0
      ? context.checkpointVersion
      : 0,
    estimatedInputTokens,
    effectiveLimitTokens,
    contextWindowTokens,
    windowMeasurement: ["provider_reported", "verified_config"].includes(context.windowMeasurement)
      ? context.windowMeasurement
      : null,
    pressureRatio: effectiveLimitTokens > 0 ? estimatedInputTokens / effectiveLimitTokens : 0,
    measurement: ["provider_reported", "tokenizer", "estimate"].includes(context.measurement)
      ? context.measurement
      : "estimate",
  };
}

function contextForModel(store, account, agentId, context = {}) {
  const modelContext = agentModelContext(store.find("agents", agentId), account?.model);
  if (!modelContext) {
    return {
      ...context,
      contextWindowTokens: 0,
      windowMeasurement: null,
    };
  }
  return {
    ...context,
    contextWindowTokens: modelContext.contextWindowTokens,
    windowMeasurement: modelContext.measurement,
    effectiveLimitTokens: context.effectiveLimitTokens > 0
      ? Math.min(context.effectiveLimitTokens, modelContext.contextWindowTokens)
      : modelContext.contextWindowTokens,
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

export function ensureAgentSession(store, { spaceSessionId, accountId, agentId, context } = {}, { now } = {}) {
  requireString(spaceSessionId, "spaceSessionId");
  requireString(accountId, "accountId");
  requireString(agentId, "agentId");
  const spaceSession = findSpaceSession(store, spaceSessionId);
  if (spaceSession.status !== "active") throw conflict(`space session ${spaceSessionId} is archived`);
  const agent = store.find("agents", agentId);
  const account = store.find("accounts", accountId);
  if (!agent) throw new ApiError("not_found", `agent ${agentId} does not exist`);
  if (!account) throw new ApiError("not_found", `account ${accountId} does not exist`);
  const matches = store.list("agentSessions").filter((item) =>
    item.spaceSessionId === spaceSessionId && item.accountId === accountId && item.agentId === agentId);
  if (matches.length > 1) throw conflict(`agent ${agentId} has multiple sessions in ${spaceSessionId}`);
  if (matches[0]) return publicAgentSession(matches[0]);
  const timestamp = nowIso(now);
  const session = store.insert("agentSessions", {
    id: newAgentSessionId(),
    spaceSessionId,
    accountId,
    agentId,
    status: "active",
    generation: 1,
    context: defaultContext(contextForModel(store, account, agent.id, context)),
    checkpoints: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return publicAgentSession(session);
}

export function refreshAgentSessionContextWindows(store, accountId, { now } = {}) {
  const account = store.find("accounts", accountId);
  const agent = account?.ownerAgentId ? store.find("agents", account.ownerAgentId) : null;
  const modelContext = agentModelContext(agent, account?.model);
  if (!account || !agent) return [];
  const timestamp = nowIso(now);
  return store.list("agentSessions")
    .filter((session) =>
      session.accountId === account.id &&
      session.agentId === agent.id &&
      session.status === "active")
    .map((session) => {
      const effectiveLimitTokens = modelContext?.contextWindowTokens ?? 0;
      return publicAgentSession(store.update("agentSessions", session.id, {
        context: {
          ...defaultContext(session.context),
          contextWindowTokens: modelContext?.contextWindowTokens ?? 0,
          windowMeasurement: modelContext?.measurement ?? null,
          effectiveLimitTokens,
          pressureRatio: effectiveLimitTokens > 0
            ? (session.context?.estimatedInputTokens ?? 0) / effectiveLimitTokens
            : 0,
        },
        updatedAt: timestamp,
      }));
    });
}

export function getActiveContext(store, { spaceId, accountId, agentId } = {}) {
  const spaceSession = ensureActiveSpaceSession(store, spaceId);
  const agentSession = ensureAgentSession(store, { spaceSessionId: spaceSession.id, accountId, agentId });
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

function resumeRequestResult(store, request) {
  const archivedSession = request.result?.archivedSpaceSessionId
    ? store.find("spaceSessions", request.result.archivedSpaceSessionId)
    : null;
  const resumedSession = request.result?.resumedSpaceSessionId
    ? store.find("spaceSessions", request.result.resumedSpaceSessionId)
    : null;
  if (!archivedSession || !resumedSession) {
    throw new ApiError("internal", "context resume request result is incomplete");
  }
  const agentSessions = store.list("agentSessions")
    .filter((item) => item.spaceSessionId === resumedSession.id && item.status === "active")
    .map(publicAgentSession);
  return {
    archivedSession: stripInternal(archivedSession),
    resumedSession: stripInternal(resumedSession),
    agentSessions,
  };
}

function hasActiveContextWork(store, spaceSessionIds) {
  const ids = new Set(spaceSessionIds);
  return store.list("runs").some((run) =>
    ids.has(run.spaceSessionId) && ACTIVE_RUN_STATUSES.has(run.status)) ||
    store.list("contextCompactionJobs").some((job) =>
      ids.has(job.spaceSessionId) && ACTIVE_JOB_STATUSES.has(job.status));
}

function freezeRecallSessions(store, agentSessionId, timestamp) {
  for (const recall of store.list("memoryRecallSessions").filter((item) =>
    item.agentSessionId === agentSessionId && item.status === "active")) {
    store.update("memoryRecallSessions", recall.id, {
      status: "frozen", frozenAt: timestamp, updatedAt: timestamp,
    });
  }
}

function reactivateCurrentRecallSession(store, agentSession, timestamp) {
  const recalls = store.list("memoryRecallSessions").filter((item) =>
    item.agentSessionId === agentSession.id && item.generation === agentSession.generation);
  if (recalls.length > 1) throw conflict(`agent session ${agentSession.id} has multiple recall sessions`);
  if (recalls[0]) {
    store.update("memoryRecallSessions", recalls[0].id, {
      status: "active", frozenAt: null, updatedAt: timestamp,
    });
  }
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
    const account = store.find("accounts", seat.accountId);
    if (!account?.ownerAgentId || !store.find("agents", account.ownerAgentId)) {
      throw conflict(`space ${spaceId} references unavailable account ${seat.accountId}`);
    }
  }

  const timestamp = nowIso(now);
  store.update("spaceSessions", current.id, {
    status: "archived", archivedAt: timestamp, archiveReason: "new_command",
  });
  for (const agentSession of store.list("agentSessions").filter((item) => item.spaceSessionId === current.id)) {
    store.update("agentSessions", agentSession.id, { status: "archived", updatedAt: timestamp });
    freezeRecallSessions(store, agentSession.id, timestamp);
  }
  const next = createSpaceSessionRecord(store, spaceId, timestamp);
  store.update("spaces", spaceId, { activeSpaceSessionId: next.id });
  for (const seat of space.seats ?? []) {
    const account = store.find("accounts", seat.accountId);
    ensureAgentSession(store, {
      spaceSessionId: next.id, accountId: account.id, agentId: account.ownerAgentId,
    }, { now: timestamp });
  }
  store.insert("contextControlRequests", {
    id: newContextControlRequestId(), type: "new", spaceId, requestId,
    status: "succeeded",
    result: { archivedSpaceSessionId: current.id, newSpaceSessionId: next.id },
    createdAt: timestamp, finishedAt: timestamp,
  });
  return { archivedSession: stripInternal(store.find("spaceSessions", current.id)), newSession: stripInternal(next) };
}

export function resumeSpaceSession(store, {
  spaceId,
  spaceSessionId,
  requestId,
} = {}, { now } = {}) {
  requireString(spaceId, "spaceId");
  requireString(spaceSessionId, "spaceSessionId");
  requireString(requestId, "requestId");
  const priorRequest = store.list("contextControlRequests").find((item) =>
    item.type === "resume" && item.spaceId === spaceId && item.requestId === requestId);
  if (priorRequest) return resumeRequestResult(store, priorRequest);

  const space = store.find("spaces", spaceId);
  if (!space) throw new ApiError("not_found", `space ${spaceId} does not exist`);
  if (space.archivedAt) throw conflict(`space ${spaceId} is archived`);
  const current = ensureActiveSpaceSession(store, spaceId);
  const target = findSpaceSession(store, spaceSessionId);
  if (target.spaceId !== spaceId) {
    throw new ApiError("not_found", `space session ${spaceSessionId} does not belong to ${spaceId}`);
  }
  if (target.id === current.id || target.status !== "archived") {
    throw conflict(`space session ${spaceSessionId} is not resumable`);
  }
  if (hasActiveContextWork(store, [current.id, target.id])) {
    throw new ApiError("session_busy", `space ${spaceId} has active context work`);
  }

  const targets = [];
  for (const seat of space.seats ?? []) {
    const account = store.find("accounts", seat.accountId);
    if (!account?.ownerAgentId || !store.find("agents", account.ownerAgentId)) {
      throw conflict(`space ${spaceId} references unavailable account ${seat.accountId}`);
    }
    const matches = store.list("agentSessions").filter((item) =>
      item.spaceSessionId === target.id &&
      item.accountId === account.id &&
      item.agentId === account.ownerAgentId);
    if (matches.length > 1) {
      throw conflict(`agent ${account.ownerAgentId} has multiple sessions in ${target.id}`);
    }
    if (matches[0]) {
      const recalls = store.list("memoryRecallSessions").filter((item) =>
        item.agentSessionId === matches[0].id && item.generation === matches[0].generation);
      if (recalls.length > 1) {
        throw conflict(`agent session ${matches[0].id} has multiple recall sessions`);
      }
    }
    targets.push({ account, agentSession: matches[0] ?? null });
  }

  const timestamp = nowIso(now);
  store.update("spaceSessions", current.id, {
    status: "archived", archivedAt: timestamp, archiveReason: "resume_switch",
  });
  for (const agentSession of store.list("agentSessions").filter((item) =>
    item.spaceSessionId === current.id)) {
    store.update("agentSessions", agentSession.id, { status: "archived", updatedAt: timestamp });
    freezeRecallSessions(store, agentSession.id, timestamp);
  }

  const resumedSession = store.update("spaceSessions", target.id, {
    status: "active", archivedAt: null, archiveReason: null,
  });
  for (const agentSession of store.list("agentSessions").filter((item) =>
    item.spaceSessionId === target.id)) {
    store.update("agentSessions", agentSession.id, { status: "archived", updatedAt: timestamp });
  }
  const resumedAgentSessions = [];
  for (const { account, agentSession } of targets) {
    const resumed = agentSession
      ? store.update("agentSessions", agentSession.id, {
          status: "active",
          context: defaultContext(contextForModel(
            store,
            account,
            account.ownerAgentId,
            agentSession.context,
          )),
          updatedAt: timestamp,
        })
      : store.insert("agentSessions", {
          id: newAgentSessionId(),
          spaceSessionId: target.id,
          accountId: account.id,
          agentId: account.ownerAgentId,
          status: "active",
          generation: 1,
          context: defaultContext(contextForModel(store, account, account.ownerAgentId)),
          checkpoints: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        });
    reactivateCurrentRecallSession(store, resumed, timestamp);
    resumedAgentSessions.push(publicAgentSession(resumed));
  }
  store.update("spaces", spaceId, { activeSpaceSessionId: target.id });
  store.insert("contextControlRequests", {
    id: newContextControlRequestId(),
    type: "resume",
    spaceId,
    requestId,
    status: "succeeded",
    result: {
      archivedSpaceSessionId: current.id,
      resumedSpaceSessionId: target.id,
    },
    createdAt: timestamp,
    finishedAt: timestamp,
  });
  return {
    archivedSession: stripInternal(store.find("spaceSessions", current.id)),
    resumedSession: stripInternal(resumedSession),
    agentSessions: resumedAgentSessions,
  };
}
