import { createHash } from "node:crypto";
import { newContextCompactionJobId, newContextControlRequestId } from "../core/id.js";
import { ApiError } from "../core/errors.js";
import { ensureActiveSpaceSession } from "./context-sessions.js";
import { getApiHistory, rotateContextGeneration } from "./context-state.js";

const ACTIVE = new Set(["queued", "running"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const MODES = new Set(["native", "checkpoint_new_binding", "gateway_history"]);

const nowIso = (now) => typeof now === "function" ? now() : now ?? new Date().toISOString();
const invalid = (message) => new ApiError("invalid_request", message);
const conflict = (message) => new ApiError("conflict", message);
function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw invalid(`${name} must be a non-empty string`);
}

function safeJob(job) {
  const { _seq, ...rest } = job;
  return structuredClone({
    ...rest,
    targets: rest.targets.map(({
      accountId, mode, recentTurnLimit, sourceSeq, includedRunIds, resultHash, result, ...target
    }) => target),
  });
}

export function getContextCompactionJob(store, jobId) {
  const job = store.find("contextCompactionJobs", jobId);
  if (!job) throw new ApiError("not_found", `context compaction job ${jobId} does not exist`);
  return safeJob(job);
}

export function getContextCompactionTarget(store, { jobId, agentId } = {}) {
  const job = store.find("contextCompactionJobs", jobId);
  if (!job) throw new ApiError("not_found", `context compaction job ${jobId} does not exist`);
  const target = job.targets.find((item) => item.agentId === agentId);
  if (!target) throw new ApiError("not_found", `compaction target ${agentId} does not exist`);
  return structuredClone(target);
}

export function recoverInterruptedContextCompactions(store, { now } = {}) {
  const timestamp = nowIso(now);
  for (const job of store.list("contextCompactionJobs").filter((item) => ACTIVE.has(item.status))) {
    const targets = structuredClone(job.targets).map((target) => ACTIVE.has(target.status)
      ? {
        ...target,
        status: "failed",
        error: { code: "context_capacity", message: "Context compaction was interrupted by gateway restart" },
        resultHash: hashResult({
          agentSessionId: target.agentSessionId,
          fromGeneration: target.fromGeneration,
          status: "failed",
          error: { code: "context_capacity", message: "Context compaction was interrupted by gateway restart" },
        }),
        result: {
          status: "failed",
          checkpoint: null,
          providerBinding: null,
          error: { code: "context_capacity", message: "Context compaction was interrupted by gateway restart" },
        },
        finishedAt: timestamp,
      }
      : target);
    updateJob(store, job, targets, timestamp);
  }
}

function resolveTarget(store, spaceSession, target) {
  requireString(target?.agentId, "target.agentId");
  const agentSession = target.agentSessionId
    ? store.find("agentSessions", target.agentSessionId)
    : store.list("agentSessions").find((item) =>
      item.spaceSessionId === spaceSession.id && item.agentId === target.agentId);
  if (!agentSession || agentSession.spaceSessionId !== spaceSession.id || agentSession.agentId !== target.agentId ||
      agentSession.status !== "active") throw conflict(`agent ${target.agentId} has no active AgentSession`);
  const owned = store.list("accounts").filter((account) => account.owningAgentId === target.agentId);
  const accountId = target.accountId ?? (owned.length === 1 ? owned[0].id : null);
  const account = accountId ? store.find("accounts", accountId) : null;
  if (!account || account.owningAgentId !== target.agentId) throw conflict(`agent ${target.agentId} has no unique Home Account`);
  const mode = target.mode ?? (account.kind === "api" ? "gateway_history" : "checkpoint_new_binding");
  if (!MODES.has(mode)) throw invalid("target.mode is invalid");
  const recentTurnLimit = target.recentTurnLimit ?? 8;
  if (!Number.isInteger(recentTurnLimit) || recentTurnLimit < 1) {
    throw invalid("target.recentTurnLimit must be a positive integer");
  }
  let sourceSeq = 0;
  for (const message of store.list("messages")) {
    if (message.spaceSessionId === spaceSession.id && Number.isInteger(message._seq) && message._seq > sourceSeq) {
      sourceSeq = message._seq;
    }
  }
  const includedRunIds = store.list("runs")
    .filter((run) => run.spaceSessionId === spaceSession.id && run.agentId === target.agentId && ACTIVE.has(run.status))
    .map((run) => run.id);
  return {
    agentId: target.agentId,
    agentSessionId: agentSession.id,
    accountId,
    fromGeneration: agentSession.generation,
    mode,
    recentTurnLimit,
    sourceSeq,
    includedRunIds,
    status: "queued",
  };
}

export function createContextCompactionJob(store, { spaceId, requestId, targets } = {}, { now } = {}) {
  requireString(spaceId, "spaceId");
  requireString(requestId, "requestId");
  const prior = store.list("contextControlRequests").find((item) =>
    item.type === "compact" && item.spaceId === spaceId && item.requestId === requestId);
  if (prior) return getContextCompactionJob(store, prior.result.jobId);
  if (!Array.isArray(targets) || targets.length === 0) throw invalid("targets must be a non-empty array");
  const spaceSession = ensureActiveSpaceSession(store, spaceId);
  const resolved = targets.map((target) => resolveTarget(store, spaceSession, target));
  if (new Set(resolved.map((target) => target.agentId)).size !== resolved.length) throw invalid("targets contain duplicate agents");
  const activeIds = new Set(store.list("contextCompactionJobs").filter((job) => ACTIVE.has(job.status))
    .flatMap((job) => job.targets.filter((target) => ACTIVE.has(target.status)).map((target) => target.agentSessionId)));
  if (resolved.some((target) => activeIds.has(target.agentSessionId))) {
    throw new ApiError("session_busy", "an AgentSession already has an active compaction");
  }
  const timestamp = nowIso(now);
  const job = store.insert("contextCompactionJobs", {
    id: newContextCompactionJobId(),
    spaceId,
    spaceSessionId: spaceSession.id,
    requestId,
    status: "queued",
    targets: resolved,
    createdAt: timestamp,
    finishedAt: null,
  });
  store.insert("contextControlRequests", {
    id: newContextControlRequestId(),
    type: "compact",
    spaceId,
    requestId,
    status: "accepted",
    result: { jobId: job.id },
    createdAt: timestamp,
    finishedAt: timestamp,
  });
  return safeJob(job);
}

function deriveStatus(targets) {
  if (targets.some((target) => target.status === "running")) return "running";
  if (targets.some((target) => target.status === "queued")) {
    return targets.some((target) => TERMINAL.has(target.status)) ? "running" : "queued";
  }
  if (targets.every((target) => target.status === "succeeded")) return "succeeded";
  if (targets.every((target) => target.status === "cancelled")) return "cancelled";
  return "failed";
}

function updateJob(store, job, targets, timestamp) {
  const status = deriveStatus(targets);
  return store.update("contextCompactionJobs", job.id, {
    targets,
    status,
    finishedAt: TERMINAL.has(status) ? timestamp : null,
  });
}

export function markContextCompactionTargetRunning(store, { jobId, agentId } = {}, { now } = {}) {
  const job = store.find("contextCompactionJobs", jobId);
  if (!job) throw new ApiError("not_found", `context compaction job ${jobId} does not exist`);
  const index = job.targets.findIndex((target) => target.agentId === agentId);
  if (index < 0) throw new ApiError("not_found", `compaction target ${agentId} does not exist`);
  if (job.targets[index].status === "running") return safeJob(job);
  if (job.targets[index].status !== "queued") throw conflict("compaction target is already terminal");
  const targets = structuredClone(job.targets);
  targets[index] = { ...targets[index], status: "running", startedAt: nowIso(now) };
  return safeJob(updateJob(store, job, targets, nowIso(now)));
}

function hashResult(input) {
  return createHash("sha256").update(JSON.stringify({
    agentSessionId: input.agentSessionId,
    fromGeneration: input.fromGeneration,
    status: input.status,
    checkpoint: input.checkpoint ?? null,
    providerBinding: input.providerBinding ?? null,
    error: input.error ?? null,
  })).digest("hex");
}

export function updateContextCompactionTarget(store, input = {}, { now } = {}) {
  const job = store.find("contextCompactionJobs", input.jobId);
  if (!job) throw new ApiError("not_found", `context compaction job ${input.jobId} does not exist`);
  const index = job.targets.findIndex((target) => target.agentId === input.agentId);
  if (index < 0) throw new ApiError("not_found", `compaction target ${input.agentId} does not exist`);
  const target = job.targets[index];
  if (!TERMINAL.has(input.status)) throw invalid("compaction result status is invalid");
  if (input.agentSessionId !== target.agentSessionId || input.fromGeneration !== target.fromGeneration) {
    throw conflict("compaction target generation is stale");
  }
  const resultHash = hashResult(input);
  if (TERMINAL.has(target.status)) {
    if (target.resultHash === resultHash) return safeJob(job);
    throw conflict("compaction target already has a different result");
  }
  if (input.status === "succeeded") {
    if (target.mode === "native" && (!input.providerBinding || input.checkpoint !== undefined)) {
      throw invalid("native compaction requires providerBinding and forbids checkpoint");
    }
    if (target.mode !== "native" && (input.checkpoint === undefined || input.providerBinding !== undefined)) {
      throw invalid("checkpoint compaction requires checkpoint and forbids providerBinding");
    }
  } else if (input.checkpoint !== undefined || input.providerBinding !== undefined) {
    throw invalid("failed or cancelled compaction must not include checkpoint or providerBinding");
  }
  const timestamp = nowIso(now);
  let toGeneration;
  if (input.status === "succeeded") {
    const priorHistory = target.mode === "gateway_history"
      ? getApiHistory(store, {
        agentSessionId: target.agentSessionId,
        generation: target.fromGeneration,
      })
      : null;
    toGeneration = rotateContextGeneration(store, {
      agentSessionId: target.agentSessionId,
      fromGeneration: target.fromGeneration,
      checkpoint: input.checkpoint,
      providerBinding: input.providerBinding,
      createApiHistory: target.mode === "gateway_history",
      recentTurns: structuredClone(priorHistory?.turns?.slice(-target.recentTurnLimit) ?? []),
    }, { now: timestamp }).generation;
  }
  const targets = structuredClone(job.targets);
  targets[index] = {
    ...targets[index],
    status: input.status,
    ...(toGeneration ? { toGeneration } : {}),
    ...(input.error ? { error: structuredClone(input.error) } : {}),
    resultHash,
    result: structuredClone({
      status: input.status,
      checkpoint: input.checkpoint ?? null,
      providerBinding: input.providerBinding ?? null,
      error: input.error ?? null,
    }),
    finishedAt: timestamp,
  };
  return safeJob(updateJob(store, job, targets, timestamp));
}
