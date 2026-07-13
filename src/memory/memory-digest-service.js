import { createHash } from "node:crypto";
import { ApiError } from "../core/errors.js";
import { chunkDigestMessages, resolveDigestRange, resolveIncrementalDigestRange } from "./memory-digest-range.js";
import {
  MEMORY_DIGEST_OUTPUT_JSON_SCHEMA,
  mergeSourceRefs,
  stableMemoryOperationId,
  validateDigestProposals,
} from "./memory-proposals.js";

const COLLECTION = "memoryDigestJobs";
const ACTIVE = new Set(["queued", "running", "applying"]);
const PIPELINE_VERSION = "m2-v1";

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
const SAFE_MESSAGES = {
  executor_unavailable: "Memory digest executor is unavailable.",
  executor_failed: "Memory digest executor failed.",
  invalid_range: "Memory digest range is invalid.",
  invalid_proposal: "Memory digest proposal was rejected.",
  write_conflict: "Memory changed while the digest job was applying.",
  write_failed: "Memory digest write failed.",
  cancelled: "Memory digest job was cancelled.",
};
function safeError(code) {
  const safeCode = Object.hasOwn(SAFE_MESSAGES, code) ? code : "executor_failed";
  return { code: safeCode, message: SAFE_MESSAGES[safeCode] };
}
function safeJob(job) {
  const { _seq, proposals, catalogVersions, ...rest } = job;
  const safe = structuredClone(rest);
  if (safe.range) {
    delete safe.range.fromSeq;
    delete safe.range.toSeq;
  }
  if (safe.result) {
    safe.result = {
      proposalCount: safe.result.proposalCount ?? 0,
      appliedCount: safe.result.appliedCount ?? 0,
      skippedCount: safe.result.skippedCount ?? 0,
      operations: (safe.result.operations ?? []).map(({ fact, ...operation }) => operation),
      facts: (safe.result.facts ?? []).map(({ factId, slug, version }) => ({ factId, slug, version })),
    };
  }
  return safe;
}

export function createMemoryDigestService({
  store, memory, proposalExecutor = null, executor = proposalExecutor,
  pipelineVersion = PIPELINE_VERSION, chunkMaxChars = 8000,
  onJobUpdated = () => {}, now = () => new Date().toISOString(),
} = {}) {
  if (!store || !memory) throw new Error("createMemoryDigestService requires store and memory");
  const tails = new Map();
  const controllers = new Map();
  let accepting = true;

  const jobs = () => store.list(COLLECTION);
  const notify = (job) => {
    const safe = safeJob(job);
    try { onJobUpdated(safe); } catch {}
    return safe;
  };
  const patchJob = (id, patch) => notify(store.update(COLLECTION, id, patch));

  function idempotencyKey({ agentId, spaceId, fromMessageId, toMessageId, mode }) {
    return `sha256:${digest(`${agentId}|${spaceId}|${fromMessageId}|${toMessageId}|${mode}|${pipelineVersion}`)}`;
  }

  function findJob(agentId, jobId) {
    const job = store.find(COLLECTION, jobId);
    return job?.agentId === agentId ? job : null;
  }

  function listJobs(agentId) {
    return jobs().filter((job) => job.agentId === agentId).map(safeJob);
  }

  function getJob(agentId, jobId) {
    const job = findJob(agentId, jobId);
    if (!job) throw new ApiError("not_found", `memory digest job ${jobId} does not exist`);
    return safeJob(job);
  }

  function getIncrementalWindow({ agentId, spaceId, toMessageId }) {
    return resolveIncrementalDigestRange({ store, jobs: jobs(), agentId, spaceId, toMessageId });
  }

  function enqueue({ agentId, spaceId, mode, trigger, fromMessageId, toMessageId }) {
    if (!accepting) throw new ApiError("conflict", "memory digest service is closing");
    if (!["incremental", "range"].includes(mode)) throw new ApiError("invalid_request", "digest mode must be incremental or range");
    if (!["manual", "scheduled", "realtime"].includes(trigger)) throw new ApiError("invalid_request", "digest trigger is invalid");
    const resolved = mode === "incremental" && !fromMessageId
      ? getIncrementalWindow({ agentId, spaceId, toMessageId })
      : resolveDigestRange({ store, agentId, spaceId, fromMessageId, toMessageId });
    if (!resolved) {
      if (trigger === "manual") throw new ApiError("invalid_request", "digest range contains no new visible Messages");
      return null;
    }
    const key = idempotencyKey({ agentId, spaceId, fromMessageId: resolved.range.fromMessageId, toMessageId: resolved.range.toMessageId, mode });
    const duplicate = jobs().find((job) => job.idempotencyKey === key);
    if (duplicate) return safeJob(duplicate);
    const active = jobs().find((job) => job.agentId === agentId && job.spaceId === spaceId && ACTIVE.has(job.status));
    if (active) throw new ApiError("conflict", `agent ${agentId} already has an active digest job in Space ${spaceId}`);
    const createdAt = now();
    const job = store.insert(COLLECTION, {
      id: `mdj_${digest(key).slice(0, 12)}`,
      agentId, spaceId, mode, trigger,
      range: resolved.range,
      pipelineVersion,
      idempotencyKey: key,
      status: "queued",
      attempt: 0,
      createdAt,
    });
    notify(job);
    schedule(job.id);
    return safeJob(job);
  }

  function enqueueIncremental({ agentId, spaceId, trigger, toMessageId }) {
    return enqueue({ agentId, spaceId, mode: "incremental", trigger, toMessageId });
  }

  function schedule(jobId) {
    const job = store.find(COLLECTION, jobId);
    if (!job || job.status !== "queued") return;
    const previous = tails.get(job.agentId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => run(jobId));
    const tail = task.catch(() => {});
    tails.set(job.agentId, tail);
    tail.finally(() => { if (tails.get(job.agentId) === tail) tails.delete(job.agentId); });
  }

  function factMap(agentId) {
    const map = new Map();
    for (const job of jobs()) {
      if (job.agentId !== agentId) continue;
      for (const fact of job.result?.facts ?? []) {
        if (fact.agentId !== agentId) continue;
        const candidates = map.get(fact.factAddressHash) ?? [];
        const prior = candidates.findIndex((candidate) => candidate.slug === fact.slug);
        if (prior === -1) candidates.push(fact);
        else candidates[prior] = fact;
        map.set(fact.factAddressHash, candidates);
      }
    }
    return map;
  }

  function targetFor(proposal, map) {
    if (proposal.targetFactId) {
      const matches = [...map.values()].flat().filter((fact) => fact.factId === proposal.targetFactId);
      const slugs = [...new Set(matches.map((fact) => fact.slug))];
      if (slugs.length !== 1) throw new ApiError("conflict", "targetFactId is missing or ambiguous");
      return slugs[0];
    }
    if (proposal.targetMemorySlug) {
      const mapped = [...map.values()].flat().some((fact) => fact.slug === proposal.targetMemorySlug);
      if (mapped) throw new ApiError("conflict", "targetMemorySlug is already mapped; use targetFactId");
      return proposal.targetMemorySlug;
    }
    if (!proposal.factAddressHash) return null;
    const candidates = map.get(proposal.factAddressHash) ?? [];
    const slugs = [...new Set(candidates.map((candidate) => candidate.slug))];
    if (slugs.length > 1) throw new ApiError("conflict", "fact address maps to multiple Memory slugs");
    return slugs[0] ?? null;
  }

  function factById(map, factId) {
    return [...map.values()].flat().find((fact) => fact.factId === factId) ?? null;
  }

  function targetStateMatches(current, proposal) {
    if (!current) return false;
    if (mergeSourceRefs(current.sources, proposal.sources).length !== current.sources.length) return false;
    if (proposal.action === "archive") return current.status === "archived";
    for (const field of ["type", "description", "content"]) {
      if (proposal[field] !== undefined && current[field] !== proposal[field]) return false;
    }
    if (proposal.stains !== undefined && JSON.stringify(current.stains) !== JSON.stringify(proposal.stains)) return false;
    return true;
  }

  async function preflightProposals(job, proposals, map, expectedVersions = new Map()) {
    const plannedSlugs = new Map();
    for (const proposal of proposals) {
      if (proposal.action === "skip") continue;
      let slug = targetFor(proposal, map);
      if (proposal.action === "create" && !slug) slug = proposal.suggestedSlug;
      if (!slug) throw new ApiError("invalid_request", `${proposal.action} proposal has no deterministic target`);
      let current = null;
      try { current = await memory.getMemory(job.agentId, slug); }
      catch (error) { if (error.code !== "not_found") throw error; }
      if (!current && !plannedSlugs.has(slug) && proposal.action !== "create") {
        throw new ApiError("not_found", `target Memory ${slug} does not exist`);
      }
      if (proposal.action === "create" && current) {
        const known = (map.get(proposal.factAddressHash) ?? []).find((fact) => fact.slug === slug);
        const sameTarget = current.type === proposal.type
          && current.description === proposal.description
          && current.content === proposal.content
          && mergeSourceRefs(current.sources, proposal.sources).length === current.sources.length;
        if (!known && !sameTarget) throw new ApiError("conflict", `suggested slug ${slug} belongs to an unrelated Memory`);
      }
      const known = (map.get(proposal.factAddressHash) ?? []).find((fact) => fact.slug === slug);
      const targetFact = proposal.targetFactId ? factById(map, proposal.targetFactId) : null;
      if (targetFact?.version && current && targetFact.version !== current.version && !targetStateMatches(current, proposal)) {
        throw new ApiError("conflict", "target fact is stale after an external Memory edit");
      }
      if (proposal.targetMemorySlug && expectedVersions.get(slug) !== current?.version && !targetStateMatches(current, proposal)) {
        throw new ApiError("conflict", "unmapped target Memory changed while the executor was running");
      }
      if (proposal.action === "update" && proposal.targetFactId && targetFact?.factValueHash !== proposal.factValueHash) {
        throw new ApiError("conflict", "update cannot change the fact value; use supersede with correction evidence");
      }
      if (proposal.action === "supersede" && targetFact?.factValueHash === proposal.factValueHash) {
        throw new ApiError("conflict", "supersede requires a changed fact value");
      }
      if (!proposal.targetFactId && known && known.factValueHash !== proposal.factValueHash && proposal.action !== "supersede") {
        throw new ApiError("conflict", "fact value conflicts without supersede");
      }
      const plannedFact = plannedSlugs.get(slug);
      const factIdentity = targetFact?.factId ?? proposal.factAddressHash ?? `archive:${proposal.targetFactId ?? proposal.targetMemorySlug}`;
      if (plannedFact && plannedFact !== factIdentity) {
        throw new ApiError("conflict", `multiple facts cannot target the same new slug ${slug}`);
      }
      plannedSlugs.set(slug, factIdentity);
      if (proposal.factAddressHash) {
        const fact = {
          agentId: job.agentId,
          factId: targetFact?.factId ?? `fct_${proposal.factAddressHash.slice(7, 23)}`,
          factAddressHash: targetFact?.factAddressHash ?? proposal.factAddressHash,
          factValueHash: proposal.factValueHash,
          slug,
        };
        const candidates = map.get(fact.factAddressHash) ?? [];
        const prior = candidates.findIndex((candidate) => candidate.slug === slug);
        if (prior === -1) candidates.push(fact); else candidates[prior] = fact;
        map.set(fact.factAddressHash, candidates);
      }
    }
  }

  async function applyProposal({ job, proposal, index, map, expectedVersions }) {
    if (proposal.action === "skip") return { proposalId: proposal.proposalId, action: "skip", status: "skipped" };
    let slug = targetFor(proposal, map);
    if (proposal.action === "create" && !slug) slug = proposal.suggestedSlug;
    if (!slug) throw new ApiError("invalid_request", `${proposal.action} proposal has no deterministic target`);
    let current;
    try { current = await memory.getMemory(job.agentId, slug); }
    catch (error) { if (error.code !== "not_found") throw error; }
    const sources = mergeSourceRefs(current?.sources, proposal.sources);
    const targetFactBefore = proposal.targetFactId ? factById(map, proposal.targetFactId) : null;
    if (targetFactBefore?.version && current && targetFactBefore.version !== current.version && !targetStateMatches(current, proposal)) {
      throw new ApiError("conflict", "target fact is stale after an external Memory edit");
    }
    if (proposal.targetMemorySlug && expectedVersions.get(slug) !== current?.version && !targetStateMatches(current, proposal)) {
      throw new ApiError("conflict", "unmapped target Memory changed while the executor was running");
    }
    const operationId = stableMemoryOperationId(job.id, index, proposal);
    const requestedAt = job.createdAt;
    let result;

    if (targetStateMatches(current, proposal)) {
      result = current;
    } else if (!current) {
      if (proposal.action !== "create") throw new ApiError("not_found", `target Memory ${slug} does not exist`);
      result = await memory.applyOperation({
        operationId, agentId: job.agentId, origin: "memory-hook", kind: "create", slug, requestedAt,
        value: { type: proposal.type, description: proposal.description, content: proposal.content, stains: proposal.stains ?? {}, sources },
      });
    } else if (proposal.action === "archive") {
      if (current.status === "archived" && sources.length === current.sources.length) result = current;
      else result = await memory.applyOperation({
        operationId, agentId: job.agentId, origin: "memory-hook", kind: "archive", slug,
        ifMatch: current.version, patch: { sources }, requestedAt,
      });
    } else {
      const known = proposal.targetFactId
        ? factById(map, proposal.targetFactId)
        : (map.get(proposal.factAddressHash) ?? []).find((fact) => fact.slug === slug);
      const sameValue = known?.factValueHash === proposal.factValueHash;
      if (known && !sameValue && proposal.action !== "supersede") {
        throw new ApiError("conflict", "fact value conflicts without supersede");
      }
      const patch = sameValue && proposal.action === "create"
        ? { sources }
        : {
            ...(proposal.type === undefined ? {} : { type: proposal.type }),
            ...(proposal.description === undefined ? {} : { description: proposal.description }),
            ...(proposal.content === undefined ? {} : { content: proposal.content }),
            ...(proposal.stains === undefined ? {} : { stains: proposal.stains }),
            sources,
          };
      const unchanged = Object.keys(patch).length === 1 && sources.length === current.sources.length;
      result = unchanged ? current : await memory.applyOperation({
        operationId, agentId: job.agentId, origin: "memory-hook", kind: "update", slug,
        ifMatch: current.version, patch, requestedAt,
      });
    }
    const priorFact = proposal.targetFactId ? factById(map, proposal.targetFactId) : null;
    const fact = proposal.factAddressHash ? {
      agentId: job.agentId,
      factId: priorFact?.factId ?? `fct_${proposal.factAddressHash.slice(7, 23)}`,
      factAddressHash: priorFact?.factAddressHash ?? proposal.factAddressHash,
      factValueHash: proposal.factValueHash,
      addressSlots: priorFact?.addressSlots ?? {
        subject: proposal.fact.subject,
        relation: proposal.fact.relation,
        qualifiers: proposal.fact.qualifiers,
      },
      slug,
      version: result.version,
    } : priorFact ? { ...priorFact, slug, version: result.version } : null;
    if (fact) map.set(fact.factAddressHash, [fact]);
    return {
      proposalId: proposal.proposalId,
      operationId,
      action: proposal.action,
      slug,
      status: result.version === current?.version ? "noop" : "applied",
      ...(current?.version ? { oldVersion: current.version } : {}),
      newVersion: result.version,
      fact,
    };
  }

  async function run(jobId) {
    let job = store.find(COLLECTION, jobId);
    if (!job || job.status !== "queued") return;
    const controller = new AbortController();
    controllers.set(jobId, controller);
    job = store.update(COLLECTION, jobId, {
      status: "running", attempt: (job.attempt ?? 0) + 1, startedAt: now(), finishedAt: undefined, error: undefined,
    });
    notify(job);
    let stage = "executor";
    try {
      const resolved = resolveDigestRange({ store, agentId: job.agentId, spaceId: job.spaceId, ...job.range });
      const chunks = chunkDigestMessages(resolved.messages, { maxChars: chunkMaxChars });
      const existingMemories = await memory.listMemories(job.agentId);
      const mapBefore = factMap(job.agentId);
      const mappedSlugs = new Set([...mapBefore.values()].flat().map((fact) => fact.slug));
      const facts = [];
      for (const fact of [...mapBefore.values()].flat()) {
        const current = existingMemories.find((item) => item.slug === fact.slug);
        if (!current) continue;
        facts.push({
          factId: fact.factId,
          slug: fact.slug,
          type: current.type,
          description: current.description,
          status: current.status,
          addressSlots: fact.addressSlots ?? null,
          valueHash: fact.factValueHash,
          version: current.version,
          stale: fact.version !== undefined && fact.version !== current.version,
        });
      }
      for (const current of existingMemories) {
        if (mappedSlugs.has(current.slug)) continue;
        facts.push({
          factId: null,
          slug: current.slug,
          type: current.type,
          description: current.description,
          status: current.status,
          addressSlots: null,
          valueHash: null,
          version: current.version,
          unmapped: true,
        });
      }
      const currentCatalogVersions = new Map(existingMemories.map((item) => [item.slug, item.version]));
      let rawProposals = job.proposals;
      if (!rawProposals) {
        if (typeof executor !== "function") throw Object.assign(new Error("memory digest executor is unavailable"), { code: "executor_unavailable" });
        const output = await executor({
          job: safeJob(job), chunks, facts,
          proposalSchema: MEMORY_DIGEST_OUTPUT_JSON_SCHEMA, signal: controller.signal,
        });
        rawProposals = Array.isArray(output) ? output : output?.proposals;
      }
      if (controller.signal.aborted) throw Object.assign(new Error("memory digest job was cancelled"), { code: "cancelled" });
      stage = "proposal";
      const proposals = validateDigestProposals({
        proposals: rawProposals,
        messages: resolved.messages,
        agentId: job.agentId,
        spaceId: job.spaceId,
        jobId: job.id,
      });
      if (!job.proposals) {
        job = store.update(COLLECTION, jobId, {
          proposals: structuredClone(rawProposals),
          catalogVersions: Object.fromEntries(currentCatalogVersions),
        });
        await store.flush?.();
      }
      job = store.update(COLLECTION, jobId, { status: "applying" });
      notify(job);
      const map = factMap(job.agentId);
      const expectedVersions = new Map(Object.entries(job.catalogVersions ?? Object.fromEntries(currentCatalogVersions)));
      const priorOperations = job.result?.operations ?? [];
      const completedProposalIds = new Set(priorOperations.map((item) => item.proposalId));
      const pendingProposals = proposals.filter((proposal) => !completedProposalIds.has(proposal.proposalId));
      stage = "write";
      await preflightProposals(job, pendingProposals, structuredClone(map), expectedVersions);
      const operations = [...priorOperations];
      for (let index = 0; index < proposals.length; index += 1) {
        if (completedProposalIds.has(proposals[index].proposalId)) continue;
        const operation = await applyProposal({
          job, proposal: proposals[index], index, map, expectedVersions,
        });
        operations.push(operation);
        store.update(COLLECTION, jobId, {
          result: {
            proposalCount: proposals.length,
            operations,
            facts: operations.map((item) => item.fact).filter(Boolean),
          },
        });
        await store.flush?.();
      }
      const result = {
        proposalCount: proposals.length,
        appliedCount: operations.filter((item) => item.status === "applied").length,
        skippedCount: operations.filter((item) => ["skipped", "noop"].includes(item.status)).length,
        operations,
        facts: operations.map((item) => item.fact).filter(Boolean),
      };
      patchJob(jobId, { status: "succeeded", finishedAt: now(), error: undefined, result });
    } catch (error) {
      const cancelled = controller.signal.aborted || error.code === "cancelled";
      const code = cancelled
        ? "cancelled"
        : error.code === "executor_unavailable"
          ? "executor_unavailable"
          : stage === "executor"
            ? "executor_failed"
            : stage === "proposal"
              ? "invalid_proposal"
              : error.code === "conflict"
                ? "write_conflict"
                : "write_failed";
      patchJob(jobId, {
        status: cancelled ? "cancelled" : "failed",
        finishedAt: now(),
        error: safeError(code),
      });
    } finally {
      controllers.delete(jobId);
    }
  }

  function retry(agentId, jobId) {
    const job = findJob(agentId, jobId);
    if (!job) throw new ApiError("not_found", `memory digest job ${jobId} does not exist`);
    if (!new Set(["failed", "cancelled"]).has(job.status)) throw new ApiError("conflict", "only failed or cancelled digest jobs can be retried");
    const queued = store.update(COLLECTION, jobId, { status: "queued", error: undefined, finishedAt: undefined });
    notify(queued);
    schedule(jobId);
    return safeJob(queued);
  }

  function cancel(agentId, jobId) {
    const job = findJob(agentId, jobId);
    if (!job) throw new ApiError("not_found", `memory digest job ${jobId} does not exist`);
    if (job.status === "applying") throw new ApiError("conflict", "applying digest jobs cannot be cancelled");
    if (!new Set(["queued", "running"]).has(job.status)) throw new ApiError("conflict", "only queued or running digest jobs can be cancelled");
    controllers.get(jobId)?.abort();
    if (job.status === "queued") return patchJob(jobId, { status: "cancelled", finishedAt: now(), error: safeError("cancelled") });
    return safeJob(store.find(COLLECTION, jobId));
  }

  function start() {
    accepting = true;
    for (const job of jobs()) {
      if (["running", "applying"].includes(job.status)) {
        store.update(COLLECTION, job.id, { status: "queued", error: undefined });
      }
    }
    for (const job of jobs()) if (job.status === "queued") schedule(job.id);
  }

  async function close() {
    accepting = false;
    for (const controller of controllers.values()) controller.abort();
    await Promise.allSettled([...tails.values()]);
  }

  return {
    enqueue, enqueueIncremental, getIncrementalWindow,
    listJobs, getJob, retry, cancel, start, close,
  };
}
