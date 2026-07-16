// Persistent M4 Dream maintenance jobs. The model only proposes; validated
// operations enter the same per-Agent Memory single-writer in one batch.

import { createHash } from "node:crypto";
import { ApiError } from "../core/errors.js";
import { sourceRefKey } from "./memory-format.js";
import { calculateMemoryDerivedWeights } from "./memory-derived-weight.js";
import { extractMemoryLinks } from "./memory-retrieval-text.js";
import {
  MEMORY_DREAM_OUTPUT_JSON_SCHEMA,
  planDreamOperations,
  validateDreamProposals,
} from "./memory-dream-proposals.js";
import { VERA_MARKDOWN_CAPABILITIES } from "./memory-provider-capabilities.js";

const COLLECTION = "memoryDreamJobs";
const ACTIVE = new Set(["queued", "running", "applying"]);
const PIPELINE_VERSION = "m4-dream-r1";
const SAFE_MESSAGES = Object.freeze({
  memory_task_unavailable: "Memory Dream task is unavailable.",
  memory_provider_unavailable: "Memory Provider is unavailable for Dream.",
  executor_failed: "Memory Dream executor failed.",
  invalid_proposal: "Memory Dream proposal was rejected.",
  write_conflict: "Memory changed while the Dream job was applying.",
  write_failed: "Memory Dream write failed.",
  cancelled: "Memory Dream job was cancelled.",
});

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const stripInternal = ({ _seq, ...value }) => value;
function safeError(code) {
  const stable = Object.hasOwn(SAFE_MESSAGES, code) ? code : "executor_failed";
  return { code: stable, message: SAFE_MESSAGES[stable] };
}
function safeJob(job) {
  return structuredClone({
    id: job.id,
    agentId: job.agentId,
    trigger: job.trigger,
    ...(job.requestId ? { requestId: job.requestId } : {}),
    status: job.status,
    attempt: job.attempt,
    createdAt: job.createdAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  });
}
function requestKey({ agentId, trigger, requestId, scheduleKey, pipelineVersion }) {
  return `sha256:${hash(`${agentId}|${trigger}|${requestId ?? scheduleKey}|${pipelineVersion}`)}`;
}
function validRequestId(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\r\n\0]/u.test(value);
}
function sameSources(left = [], right = []) {
  return [...left].map(sourceRefKey).sort().join("\0") === [...right].map(sourceRefKey).sort().join("\0");
}
function operationReached(current, operation, proposalAction) {
  if (!current) return false;
  if (operation.kind === "archive") return current.status === "archived";
  if (operation.kind !== "update") return false;
  if (proposalAction === "merge" && current.status !== "active") return false;
  for (const [key, value] of Object.entries(operation.patch ?? {})) {
    if (key === "sources") {
      if (!sameSources(current.sources, value)) return false;
    } else if (current[key] !== value) return false;
  }
  return true;
}

export function createMemoryDreamService({
  store,
  memory,
  freezeTask,
  validateTaskSnapshot = async () => {},
  proposalExecutor,
  providerCapabilities = VERA_MARKDOWN_CAPABILITIES,
  batchSize = 256,
  pipelineVersion = PIPELINE_VERSION,
  onJobUpdated = () => {},
  now = () => new Date().toISOString(),
} = {}) {
  if (!store || !memory?.applyBatch) throw new Error("createMemoryDreamService requires store and Memory batch facade");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 256) {
    throw new Error("Memory Dream batchSize must be an integer from 1 to 256");
  }
  const tails = new Map();
  const controllers = new Map();
  let accepting = true;

  const jobs = () => store.list(COLLECTION);
  function factIds(agentId) {
    const result = {};
    for (const job of store.list("memoryDigestJobs")) {
      if (job.agentId !== agentId || !["succeeded", "partial"].includes(job.status)) continue;
      for (const fact of job.result?.facts ?? []) if (fact?.slug && fact?.factId) result[fact.slug] = fact.factId;
    }
    return result;
  }
  const notify = (job) => {
    const safe = safeJob(job);
    try { onJobUpdated(safe); } catch {}
    return safe;
  };
  const patch = (id, value) => notify(store.update(COLLECTION, id, value));

  function find(agentId, jobId) {
    const job = store.find(COLLECTION, jobId);
    return job?.agentId === agentId ? job : null;
  }
  function listJobs(agentId, { limit = 20 } = {}) {
    const value = Number(limit);
    if (!Number.isInteger(value) || value < 1 || value > 100) throw new ApiError("invalid_request", "Dream job limit must be 1..100");
    return jobs().filter((job) => job.agentId === agentId).sort((a, b) => b._seq - a._seq).slice(0, value).map(safeJob);
  }
  function getJob(agentId, jobId) {
    const job = find(agentId, jobId);
    if (!job) throw new ApiError("not_found", `memory Dream job ${jobId} does not exist`);
    return safeJob(job);
  }
  function latestJob(agentId) {
    return jobs().filter((job) => job.agentId === agentId).sort((a, b) => b._seq - a._seq)[0] ?? null;
  }

  async function freezeMemories(agentId) {
    const listed = memory.snapshotMemories
      ? await memory.snapshotMemories(agentId)
      : { memories: await memory.listMemories(agentId), index: { generation: null } };
    const hydrated = listed.memories;
    const weights = calculateMemoryDerivedWeights({
      agentId, memories: hydrated, signals: store.list("memorySignals"), now: now(),
    });
    hydrated.sort((a, b) => {
      const aPin = store.find("memorySignals", `pin:${agentId}:${a.slug}`)?.pinned === true;
      const bPin = store.find("memorySignals", `pin:${agentId}:${b.slug}`)?.pinned === true;
      return Number(bPin) - Number(aPin) || (weights.get(b.slug) ?? 0) - (weights.get(a.slug) ?? 0) || a.slug.localeCompare(b.slug);
    });
    const selected = hydrated.slice(0, batchSize).sort((a, b) => a.slug.localeCompare(b.slug));
    return {
      indexGeneration: listed.index.generation,
      memories: selected.map((item) => ({
        slug: item.slug, version: item.version, type: item.type, description: item.description,
        status: item.status, content: item.content, sources: structuredClone(item.sources),
        links: [...new Set(extractMemoryLinks(item))].sort(),
        derived: { weight: weights.get(item.slug) ?? 0 },
      })),
    };
  }

  async function enqueue({ agentId, trigger = "manual", requestId, scheduleKey } = {}) {
    if (!accepting) throw new ApiError("conflict", "Memory Dream service is closing");
    if (!store.find("agents", agentId)) throw new ApiError("not_found", `agent ${agentId} does not exist`);
    if (!new Set(["manual", "scheduled"]).has(trigger)) throw new ApiError("invalid_request", "Dream trigger must be manual or scheduled");
    if (trigger === "manual" && !validRequestId(requestId)) throw new ApiError("invalid_request", "Dream requestId must be a non-empty opaque string up to 128 characters");
    if (trigger === "scheduled" && !validRequestId(scheduleKey)) throw new ApiError("invalid_request", "scheduled Dream requires a stable scheduleKey");
    const key = requestKey({ agentId, trigger, requestId, scheduleKey, pipelineVersion });
    const duplicate = jobs().find((job) => job.idempotencyKey === key);
    if (duplicate) return { job: safeJob(duplicate), coalesced: false };
    const active = jobs().find((job) => job.agentId === agentId && ACTIVE.has(job.status));
    if (active) return { job: safeJob(active), coalesced: true };

    let task = null;
    let frozen = { indexGeneration: null, memories: [] };
    let freezeError = null;
    try {
      task = await freezeTask?.({ ownerAgentId: agentId, kind: "dream" });
      if (!task?.memoryTaskSnapshot || !task?.memoryProviderSnapshot) {
        throw Object.assign(new Error("Dream task is unavailable"), { code: "memory_task_unavailable" });
      }
      frozen = await freezeMemories(agentId);
    } catch (error) {
      freezeError = safeError(error?.code === "memory_provider_unavailable" ? error.code : "memory_task_unavailable");
    }
    const createdAt = now();
    const job = store.insert(COLLECTION, {
      id: `mdr_${hash(key).slice(0, 16)}`,
      agentId, trigger,
      ...(requestId ? { requestId } : {}),
      ...(scheduleKey ? { scheduleKey } : {}),
      pipelineVersion, idempotencyKey: key,
      status: "queued", attempt: 0, createdAt,
      memoryTaskSnapshot: task?.memoryTaskSnapshot ?? null,
      memoryProviderSnapshot: task?.memoryProviderSnapshot
        ? { ...task.memoryProviderSnapshot, indexGeneration: frozen.indexGeneration }
        : null,
      memorySnapshot: frozen.memories,
      ...(freezeError ? { freezeError } : {}),
      receipts: [],
    });
    await store.flush?.();
    notify(job);
    schedule(job.id);
    return { job: safeJob(job), coalesced: false };
  }

  function schedule(jobId) {
    const job = store.find(COLLECTION, jobId);
    if (!job || job.status !== "queued") return;
    const prior = tails.get(job.agentId) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(() => run(jobId));
    const tail = task.catch(() => {});
    tails.set(job.agentId, tail);
    tail.finally(() => { if (tails.get(job.agentId) === tail) tails.delete(job.agentId); });
  }

  async function currentMemory(agentId, slug) {
    try { return await memory.getMemory(agentId, slug); }
    catch (error) { if (error?.code === "not_found") return null; throw error; }
  }

  async function run(jobId) {
    let job = store.find(COLLECTION, jobId);
    if (!job || job.status !== "queued") return;
    const controller = new AbortController();
    controllers.set(jobId, controller);
    job = store.update(COLLECTION, jobId, {
      status: "running", attempt: (job.attempt ?? 0) + 1,
      startedAt: now(), finishedAt: undefined, error: undefined,
    });
    notify(job);
    let stage = "executor";
    try {
      if (job.freezeError) throw Object.assign(new Error(job.freezeError.message), { code: job.freezeError.code });
      await validateTaskSnapshot({
        memoryTaskSnapshot: job.memoryTaskSnapshot,
        memoryProviderSnapshot: job.memoryProviderSnapshot,
      });
      let raw = job.proposals;
      if (!raw) {
        if (typeof proposalExecutor !== "function") throw Object.assign(new Error("Dream executor is unavailable"), { code: "memory_task_unavailable" });
        const owner = store.find("agents", job.agentId);
        const result = await proposalExecutor({
          job,
          payload: {
            agent: { id: owner.id, name: owner.name },
            memories: structuredClone(job.memorySnapshot),
            proposalSchema: MEMORY_DREAM_OUTPUT_JSON_SCHEMA,
          },
          signal: controller.signal,
        });
        raw = Array.isArray(result) ? result : result?.proposals;
      }
      if (controller.signal.aborted) throw Object.assign(new Error("Dream cancelled"), { code: "cancelled" });
      stage = "proposal";
      const proposals = validateDreamProposals({
        proposals: raw,
        memories: job.memorySnapshot,
        factIdsBySlug: factIds(job.agentId),
        providerCapabilities,
        jobId: job.id,
      });
      if (!job.proposals) {
        job = store.update(COLLECTION, jobId, { proposals: structuredClone(raw) });
        await store.flush?.();
      }
      job = store.update(COLLECTION, jobId, { status: "applying" });
      notify(job);
      stage = "write";
      const planned = planDreamOperations({
        agentId: job.agentId, jobId: job.id, proposals,
        memories: job.memorySnapshot, requestedAt: job.createdAt,
      });
      const receipts = [...(job.receipts ?? [])];
      const actionByProposalId = new Map(proposals.map((proposal) => [proposal.proposalId, proposal.action]));
      const complete = new Set(receipts.map((receipt) => receipt.operationId));
      const pending = [];
      const pendingMeta = [];
      for (const item of planned) {
        const operation = item.operation;
        if (complete.has(operation.operationId)) continue;
        const current = await currentMemory(job.agentId, operation.slug);
        const proposalAction = actionByProposalId.get(item.proposalId);
        if (operationReached(current, operation, proposalAction)) {
          const receipt = { proposalId: item.proposalId, operationId: operation.operationId, slug: operation.slug, status: "noop", version: current.version };
          receipts.push(receipt);
          store.update(COLLECTION, jobId, { receipts });
          await store.flush?.();
          continue;
        }
        if (proposalAction === "merge" && operation.kind === "update" && current?.status !== "active") {
          throw new ApiError("conflict", `Dream merge target ${operation.slug} is no longer active`);
        }
        if (!current || current.version !== operation.ifMatch) throw new ApiError("conflict", `Dream target ${operation.slug} changed after enqueue`);
        pending.push(operation);
        pendingMeta.push(item);
      }
      if (pending.length) await memory.applyBatch(job.agentId, pending, {
        onApplied: async ({ index, operation, result }) => {
          const receipt = {
            proposalId: pendingMeta[index].proposalId,
            operationId: operation.operationId,
            slug: operation.slug,
            status: "applied",
            version: result?.version ?? null,
          };
          receipts.push(receipt);
          store.update(COLLECTION, jobId, { receipts });
          await store.flush?.();
        },
        onRolledBack: async ({ operations }) => {
          const rolledBack = new Set(operations.map((operation) => operation.operationId));
          for (let index = receipts.length - 1; index >= 0; index -= 1) {
            if (rolledBack.has(receipts[index].operationId)) receipts.splice(index, 1);
          }
          store.update(COLLECTION, jobId, { receipts });
          await store.flush?.();
        },
      });
      await memory.finalizeBatch?.(job.agentId);
      const result = {
        scannedCount: job.memorySnapshot.length,
        updatedCount: proposals.filter((proposal) => proposal.action === "update").length,
        mergedCount: proposals.filter((proposal) => proposal.action === "merge").length,
        archivedCount: proposals.filter((proposal) => proposal.action === "archive").length +
          proposals.filter((proposal) => proposal.action === "merge").reduce((sum, proposal) => sum + proposal.sourceSlugs.length - 1, 0),
        noopCount: proposals.filter((proposal) => proposal.action === "keep").length + receipts.filter((receipt) => receipt.status === "noop").length,
      };
      patch(jobId, { status: "succeeded", finishedAt: now(), error: undefined, result });
    } catch (error) {
      const cancelled = controller.signal.aborted || error?.code === "cancelled";
      const code = cancelled ? "cancelled"
        : error?.code === "memory_task_unavailable" || error?.code === "executor_unavailable" ? "memory_task_unavailable"
          : error?.code === "memory_provider_unavailable" ? "memory_provider_unavailable"
            : stage === "executor" ? "executor_failed"
              : stage === "proposal" ? "invalid_proposal"
                : error?.code === "conflict" ? "write_conflict" : "write_failed";
      patch(jobId, { status: cancelled ? "cancelled" : "failed", finishedAt: now(), error: safeError(code) });
    } finally {
      controllers.delete(jobId);
    }
  }

  function cancel(agentId, jobId) {
    const job = find(agentId, jobId);
    if (!job) throw new ApiError("not_found", `memory Dream job ${jobId} does not exist`);
    if (job.status === "applying") throw new ApiError("conflict", "applying Dream jobs cannot be cancelled");
    if (!new Set(["queued", "running"]).has(job.status)) throw new ApiError("conflict", "only queued or running Dream jobs can be cancelled");
    controllers.get(jobId)?.abort();
    if (job.status === "queued") return patch(jobId, { status: "cancelled", finishedAt: now(), error: safeError("cancelled") });
    return safeJob(store.find(COLLECTION, jobId));
  }

  function retry(agentId, jobId) {
    const job = find(agentId, jobId);
    if (!job) throw new ApiError("not_found", `memory Dream job ${jobId} does not exist`);
    if (!new Set(["failed", "cancelled"]).has(job.status)) throw new ApiError("conflict", "only failed or cancelled Dream jobs can be retried");
    const queued = store.update(COLLECTION, jobId, { status: "queued", error: undefined, finishedAt: undefined });
    notify(queued);
    schedule(jobId);
    return safeJob(queued);
  }

  function start() {
    accepting = true;
    for (const job of jobs()) if (["running", "applying"].includes(job.status)) store.update(COLLECTION, job.id, { status: "queued", error: undefined });
    for (const job of jobs()) if (job.status === "queued") schedule(job.id);
  }
  async function close() {
    accepting = false;
    for (const controller of controllers.values()) controller.abort();
    await Promise.allSettled([...tails.values()]);
  }

  return { enqueue, listJobs, getJob, latestJob: (agentId) => latestJob(agentId) ? safeJob(latestJob(agentId)) : null, cancel, retry, start, close };
}
