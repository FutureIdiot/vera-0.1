// Permanent deletion for archived Spaces. Memory SourceRefs are preflighted and
// rewritten before the store graph is removed so retained Markdown never keeps
// a fake live pointer to a deleted Message.

import { randomUUID } from "node:crypto";
import { ApiError } from "../core/errors.js";

const ACTIVE_RUN_STATUSES = new Set(["pending", "running"]);
const ACTIVE_COMPACTION_STATUSES = new Set(["queued", "running"]);
const ACTIVE_MEMORY_JOB_STATUSES = new Set(["queued", "running", "applying"]);

function requireArchivedSpace(store, spaceId) {
  const space = store.find("spaces", spaceId);
  if (!space) throw new ApiError("not_found", `space ${spaceId} does not exist`);
  if (!space.archivedAt) throw new ApiError("conflict", `space ${spaceId} must be archived before permanent deletion`);
  return space;
}

function assertNoActiveWork(store, spaceId) {
  const busyRun = store.list("runs").some((run) =>
    run.spaceId === spaceId && ACTIVE_RUN_STATUSES.has(run.status));
  const busyCompaction = store.list("contextCompactionJobs").some((job) =>
    job.spaceId === spaceId && ACTIVE_COMPACTION_STATUSES.has(job.status));
  const busyDigest = store.list("memoryDigestJobs").some((job) =>
    job.spaceId === spaceId && ACTIVE_MEMORY_JOB_STATUSES.has(job.status));
  if (busyRun || busyCompaction || busyDigest) {
    throw new ApiError("conflict", `space ${spaceId} still has active work`);
  }
}

function isSpaceMessageSource(source, spaceId) {
  return source?.kind === "message" && source.spaceId === spaceId;
}

async function collectMemoryImpact({ store, snapshotMemories, spaceId, deletedAt }) {
  const batches = [];
  const affected = [];
  for (const agent of store.list("agents")) {
    const snapshot = await snapshotMemories(agent.id);
    if (snapshot.errors.length > 0) {
      throw new ApiError(
        "memory_provider_unavailable",
        `agent ${agent.id} has invalid Memory files; repair them before deleting Space ${spaceId}`,
      );
    }
    const operations = [];
    for (const item of snapshot.memories) {
      if (!item.sources.some((source) => isSpaceMessageSource(source, spaceId))) continue;
      const exclusive = item.sources.every((source) => isSpaceMessageSource(source, spaceId));
      const retainedSources = item.sources.map((source) => isSpaceMessageSource(source, spaceId)
        ? {
            kind: "deleted-message",
            spaceId: source.spaceId,
            messageId: source.messageId,
            deletedAt,
          }
        : source);
      const record = {
        agentId: agent.id,
        slug: item.slug,
        version: item.version,
        exclusive,
        retainedSources,
      };
      affected.push(record);
      operations.push(record);
    }
    if (operations.length > 0) batches.push({ agentId: agent.id, items: operations });
  }
  return { batches, affected };
}

export async function getSpaceDeletionPreview({ store, memory, files, spaceId }) {
  requireArchivedSpace(store, spaceId);
  assertNoActiveWork(store, spaceId);
  const impact = await collectMemoryImpact({
    store,
    snapshotMemories: (agentId) => memory.snapshotMemories(agentId),
    spaceId,
    deletedAt: new Date().toISOString(),
  });
  return {
    spaceId,
    messageCount: store.list("messages").filter((message) => message.spaceId === spaceId).length,
    affectedMemoryCount: impact.affected.length,
    exclusiveMemoryCount: impact.affected.filter((item) => item.exclusive).length,
  };
}

function removeMatching(store, collection, predicate) {
  let removed = 0;
  for (const record of [...store.list(collection)]) {
    if (!predicate(record)) continue;
    if (store.remove(collection, record.id)) removed += 1;
  }
  return removed;
}

function purgeSpaceGraph(store, spaceId, deletedMemories) {
  const spaceSessionIds = new Set(
    store.list("spaceSessions").filter((session) => session.spaceId === spaceId).map((session) => session.id),
  );
  const agentSessionIds = new Set(
    store.list("agentSessions")
      .filter((session) => spaceSessionIds.has(session.spaceSessionId))
      .map((session) => session.id),
  );
  const deletedMemoryKeys = new Set(deletedMemories.map((item) => `${item.agentId}\0${item.slug}`));

  for (const collection of [
    "messages",
    "activities",
    "approvals",
    "runs",
    "spaceSessions",
    "contextCompactionJobs",
    "contextControlRequests",
  ]) {
    removeMatching(store, collection, (record) => record.spaceId === spaceId);
  }
  removeMatching(store, "memoryDigestJobs", (record) =>
    record.spaceId === spaceId &&
    record.status !== "succeeded" &&
    (record.result?.facts?.length ?? 0) === 0);
  removeMatching(store, "agentSessions", (record) => spaceSessionIds.has(record.spaceSessionId));
  removeMatching(store, "providerBindings", (record) => agentSessionIds.has(record.agentSessionId));
  removeMatching(store, "apiHistories", (record) => agentSessionIds.has(record.agentSessionId));
  removeMatching(store, "memoryRecallSessions", (record) => agentSessionIds.has(record.agentSessionId));
  removeMatching(store, "memorySignals", (record) =>
    agentSessionIds.has(record.agentSessionId) ||
    deletedMemoryKeys.has(`${record.agentId}\0${record.slug}`));
  store.remove("spaces", spaceId);
}

export async function deleteArchivedSpace({
  store,
  memory,
  files,
  spaceId,
  deleteExclusiveMemories,
}) {
  return memory.withExclusiveMutation(async ({ snapshotMemories, applyMultiAgentBatch }) => {
    requireArchivedSpace(store, spaceId);
    assertNoActiveWork(store, spaceId);
    const deletedAt = new Date().toISOString();
    const impact = await collectMemoryImpact({ store, snapshotMemories, spaceId, deletedAt });
    const deletedMemories = impact.affected.filter((item) => deleteExclusiveMemories && item.exclusive);
    const multiAgentBatches = impact.batches.map((batch) => ({
      agentId: batch.agentId,
      operations: batch.items.map((item) => deleteExclusiveMemories && item.exclusive
        ? {
            operationId: `mop_${randomUUID()}`,
            agentId: item.agentId,
            origin: "user-api",
            kind: "delete",
            slug: item.slug,
            ifMatch: item.version,
            requestedAt: deletedAt,
          }
        : {
            operationId: `mop_${randomUUID()}`,
            agentId: item.agentId,
            origin: "user-api",
            kind: "update",
            slug: item.slug,
            ifMatch: item.version,
            patch: { sources: item.retainedSources },
            requestedAt: deletedAt,
          }),
    }));
    if (multiAgentBatches.length > 0) await applyMultiAgentBatch(multiAgentBatches);
    const deletedFileIds = await files?.deleteOwnedBySpace?.(spaceId, deletedAt) ?? [];

    const messageCount = store.list("messages").filter((message) => message.spaceId === spaceId).length;
    purgeSpaceGraph(store, spaceId, deletedMemories);
    await store.flush();
    return {
      spaceId,
      messageCount,
      affectedMemoryCount: impact.affected.length,
      deletedMemoryCount: deletedMemories.length,
      deletedFileIds,
    };
  });
}
