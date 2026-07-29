// Editable Forge draft lifecycle. Draft generation is asynchronous and
// per-Account; confirming a ready draft switches the whole SpaceSession once.

import { createHash } from "node:crypto";
import { ApiError } from "../core/errors.js";
import { newContextControlRequestId, newContextForgeDraftId } from "../core/id.js";
import { withAccountExecutionLock } from "./execution-lock.js";
import {
  ensureActiveSpaceSession,
  hasActiveContextWork,
  startForgedSpaceSession,
} from "./context-sessions.js";
import {
  completedMessageHighWater,
  forgeSourceForTarget,
} from "./context-forge-source.js";
import { emptyForgeCapsule, FORGE_HEADINGS } from "./forge-capsule.js";

const ACTIVE_TARGETS = new Set(["queued", "running"]);
const TERMINAL_TARGETS = new Set(["succeeded", "failed", "cancelled"]);
const EDITABLE_DRAFTS = new Set(["ready"]);

const nowIso = (now) => typeof now === "function" ? now() : now ?? new Date().toISOString();
const invalid = (message) => new ApiError("invalid_request", message);
const conflict = (message) => new ApiError("conflict", message);

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw invalid(`${name} must be a non-empty string`);
  return value.trim();
}

function normalizeCapsule(value, maxChars) {
  const content = requireString(value, "content");
  if (content.length > maxChars || FORGE_HEADINGS.some((heading) => !content.includes(heading))) {
    throw new ApiError("forge_failed", "Forge context capsule is invalid");
  }
  return content;
}

function normalizeManualContent(value, maxChars) {
  const content = requireString(value, "content");
  if (content.length > maxChars) throw invalid("Forge content exceeds the configured capacity");
  return content;
}

function publicDraft(record) {
  if (!record) return null;
  const { _seq, requestId, ...draft } = record;
  return structuredClone({
    ...draft,
    targets: draft.targets.map(({
      runtimeRevision,
      model,
      sourceCharCount,
      resultHash,
      ...target
    }) => target),
  });
}

function resultHash(input) {
  return createHash("sha256").update(JSON.stringify({
    accountId: input.accountId,
    agentId: input.agentId,
    status: input.status,
    content: input.content ?? null,
    execution: input.execution ?? null,
    error: input.error ?? null,
  })).digest("hex");
}

function deriveDraftStatus(targets) {
  if (targets.some((target) => ACTIVE_TARGETS.has(target.status))) return "generating";
  if (targets.every((target) => target.status === "succeeded")) return "ready";
  if (targets.every((target) => target.status === "cancelled")) return "cancelled";
  return "failed";
}

function safeError() {
  return { code: "forge_failed", message: "Forge context generation failed" };
}

function updateTargetRecord(store, draft, input, { now } = {}) {
  const index = draft.targets.findIndex((target) =>
    target.accountId === input.accountId && target.agentId === input.agentId);
  if (index < 0) throw new ApiError("not_found", `Forge target ${input.accountId} does not exist`);
  const current = draft.targets[index];
  if (!TERMINAL_TARGETS.has(input.status)) throw invalid("Forge target status is invalid");
  const hash = resultHash(input);
  if (TERMINAL_TARGETS.has(current.status)) {
    if (current.resultHash === hash || (current.status === "cancelled" && input.status === "cancelled")) {
      return publicDraft(draft);
    }
    throw conflict("Forge target is already terminal");
  }
  if (input.status === "succeeded") {
    if (input.execution?.runtimeRevision !== current.runtimeRevision ||
        input.execution?.model !== current.model ||
        input.execution?.fallbackUsed !== false) {
      throw conflict("Forge execution does not match the frozen target");
    }
  }
  const timestamp = nowIso(now);
  const targets = structuredClone(draft.targets);
  targets[index] = {
    ...targets[index],
    status: input.status,
    content: input.status === "succeeded" ? input.content : null,
    ...(input.status === "succeeded" ? {} : { error: safeError() }),
    resultHash: hash,
    finishedAt: timestamp,
  };
  return publicDraft(store.update("contextForgeDrafts", draft.id, {
    targets,
    status: deriveDraftStatus(targets),
    updatedAt: timestamp,
  }));
}

export function recoverInterruptedContextForges(store, { now } = {}) {
  const timestamp = nowIso(now);
  for (const draft of store.list("contextForgeDrafts").filter((item) => item.status === "generating")) {
    const targets = structuredClone(draft.targets).map((target) => ACTIVE_TARGETS.has(target.status)
      ? {
          ...target,
          status: "failed",
          content: null,
          error: safeError(),
          resultHash: resultHash({
            accountId: target.accountId,
            agentId: target.agentId,
            status: "failed",
            error: safeError(),
          }),
          finishedAt: timestamp,
        }
      : target);
    store.update("contextForgeDrafts", draft.id, {
      targets,
      status: "failed",
      updatedAt: timestamp,
    });
  }
}

export function createContextForgeService({
  store,
  hub,
  config,
  dispatchDaemonForge,
} = {}) {
  if (!store || !hub || !config?.context || typeof dispatchDaemonForge !== "function") {
    throw new TypeError("createContextForgeService dependencies are unavailable");
  }
  const waiters = new Map();
  const inFlight = new Map();
  recoverInterruptedContextForges(store);

  function publish(draft) {
    hub.publish("context-forge.updated", {
      spaceId: draft.spaceId,
      spaceSessionId: draft.sourceSpaceSessionId,
      draft: publicDraft(draft),
    });
  }

  function getDraft(draftId) {
    const draft = store.find("contextForgeDrafts", draftId);
    if (!draft) throw new ApiError("not_found", `Forge draft ${draftId} does not exist`);
    return publicDraft(draft);
  }

  function settleWaiter(key, value) {
    const waiter = waiters.get(key);
    if (!waiter) return;
    waiters.delete(key);
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }

  async function runTarget(draftId, accountId) {
    const key = `${draftId}:${accountId}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const task = (async () => {
      let draft = store.find("contextForgeDrafts", draftId);
      let target = draft?.targets.find((candidate) => candidate.accountId === accountId);
      if (!draft || !target || target.status !== "queued") return;
      const account = store.find("accounts", target.accountId);
      if (!account) return;
      await withAccountExecutionLock(account.id, async () => {
        draft = store.find("contextForgeDrafts", draftId);
        target = draft?.targets.find((candidate) => candidate.accountId === accountId);
        if (!draft || draft.status !== "generating" || target?.status !== "queued") return;
        const timestamp = nowIso();
        const targets = structuredClone(draft.targets);
        const index = targets.findIndex((candidate) => candidate.accountId === accountId);
        targets[index] = { ...targets[index], status: "running", startedAt: timestamp };
        draft = store.update("contextForgeDrafts", draft.id, { targets, updatedAt: timestamp });
        publish(draft);
        try {
          const space = store.find("spaces", draft.spaceId);
          const source = forgeSourceForTarget(store, {
            space,
            spaceSessionId: draft.sourceSpaceSessionId,
            sourceSeq: draft.sourceSeq,
            accountId,
            maxChars: config.context.forgeSourceMaxChars,
          });
          const result = new Promise((resolve) => {
            const timer = setTimeout(() => resolve({
              status: "failed",
              error: safeError(),
            }), config.context.forgeTaskTimeoutMs);
            timer.unref?.();
            waiters.set(key, { resolve, timer });
          });
          dispatchDaemonForge({
            accountId,
            event: {
              type: "context-forge.requested",
              data: {
                draftId,
                target: {
                  accountId,
                  agentId: target.agentId,
                  runtimeRevision: target.runtimeRevision,
                  model: target.model,
                },
                source: {
                  spaceId: draft.spaceId,
                  spaceSessionId: draft.sourceSpaceSessionId,
                  sourceSeq: draft.sourceSeq,
                  messages: source.messages,
                },
                limits: {
                  chunkChars: config.context.forgeChunkChars,
                  capsuleChars: config.context.forgeCapsuleMaxChars,
                },
              },
            },
          });
          const outcome = await result;
          draft = store.find("contextForgeDrafts", draftId);
          target = draft?.targets.find((candidate) => candidate.accountId === accountId);
          if (draft && target && ACTIVE_TARGETS.has(target.status)) {
            const updated = updateTargetRecord(store, draft, {
              accountId,
              agentId: target.agentId,
              status: outcome.status,
              ...(outcome.content ? { content: outcome.content } : {}),
              ...(outcome.execution ? { execution: outcome.execution } : {}),
              ...(outcome.error ? { error: outcome.error } : {}),
            });
            publish(updated);
          }
        } catch {
          draft = store.find("contextForgeDrafts", draftId);
          target = draft?.targets.find((candidate) => candidate.accountId === accountId);
          if (draft && target && ACTIVE_TARGETS.has(target.status)) {
            const updated = updateTargetRecord(store, draft, {
              accountId,
              agentId: target.agentId,
              status: "failed",
              error: safeError(),
            });
            publish(updated);
          }
        } finally {
          settleWaiter(key, { status: "cancelled" });
        }
      });
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return task;
  }

  function createDraft({ spaceId, requestId }, { now } = {}) {
    requireString(spaceId, "spaceId");
    requireString(requestId, "requestId");
    const prior = store.list("contextControlRequests").find((item) =>
      item.type === "forge_draft" && item.spaceId === spaceId && item.requestId === requestId);
    if (prior) return getDraft(prior.result.draftId);
    const space = store.find("spaces", spaceId);
    if (!space) throw new ApiError("not_found", `space ${spaceId} does not exist`);
    const spaceSession = ensureActiveSpaceSession(store, spaceId);
    if (hasActiveContextWork(store, [spaceSession.id]) ||
        store.list("contextForgeDrafts").some((draft) =>
          draft.sourceSpaceSessionId === spaceSession.id && draft.status === "generating")) {
      throw new ApiError("session_busy", `space ${spaceId} has active context work`);
    }
    const sourceSeq = completedMessageHighWater(store, spaceSession.id);
    const targets = [];
    for (const seat of space.seats ?? []) {
      const account = store.find("accounts", seat.accountId);
      const agent = account?.ownerAgentId ? store.find("agents", account.ownerAgentId) : null;
      if (!account || !agent || !agent.runtimeRevision || !account.model) {
        throw conflict(`account ${seat.accountId} has no available Forge executor`);
      }
      const source = forgeSourceForTarget(store, {
        space,
        spaceSessionId: spaceSession.id,
        sourceSeq,
        accountId: account.id,
        maxChars: config.context.forgeSourceMaxChars,
      });
      targets.push({
        accountId: account.id,
        agentId: agent.id,
        runtimeRevision: agent.runtimeRevision,
        model: account.model,
        status: source.messages.length === 0 ? "succeeded" : "queued",
        content: source.messages.length === 0 ? emptyForgeCapsule() : null,
        sourceMessageIds: source.sourceMessageIds,
        sourceCharCount: source.charCount,
        ...(source.messages.length === 0 ? { finishedAt: nowIso(now) } : {}),
      });
    }
    if (targets.length === 0) throw conflict(`space ${spaceId} has no Forge targets`);
    const timestamp = nowIso(now);
    const status = deriveDraftStatus(targets);
    const draft = store.insert("contextForgeDrafts", {
      id: newContextForgeDraftId(),
      spaceId,
      sourceSpaceSessionId: spaceSession.id,
      sourceSeq,
      requestId,
      status,
      version: 1,
      targets,
      createdAt: timestamp,
      updatedAt: timestamp,
      confirmedAt: null,
      newSpaceSessionId: null,
    });
    store.insert("contextControlRequests", {
      id: newContextControlRequestId(),
      type: "forge_draft",
      spaceId,
      requestId,
      status: "accepted",
      result: { draftId: draft.id },
      createdAt: timestamp,
      finishedAt: timestamp,
    });
    publish(draft);
    for (const target of targets.filter((item) => item.status === "queued")) {
      void runTarget(draft.id, target.accountId);
    }
    return publicDraft(draft);
  }

  function updateDraft({ draftId, ifVersion, targets: inputTargets }, { now } = {}) {
    const draft = store.find("contextForgeDrafts", draftId);
    if (!draft) throw new ApiError("not_found", `Forge draft ${draftId} does not exist`);
    if (!EDITABLE_DRAFTS.has(draft.status)) throw conflict("Forge draft is not editable");
    if (!Number.isInteger(ifVersion) || ifVersion !== draft.version) {
      throw conflict("Forge draft version is stale");
    }
    if (!Array.isArray(inputTargets) || inputTargets.length !== draft.targets.length) {
      throw invalid("targets must exactly cover the Forge draft");
    }
    const byAccount = new Map(inputTargets.map((target) => [target?.accountId, target]));
    if (byAccount.size !== draft.targets.length) throw invalid("targets contain duplicate accounts");
    const targets = draft.targets.map((target) => {
      const input = byAccount.get(target.accountId);
      if (!input || Object.keys(input).sort().join(",") !== "accountId,content") {
        throw invalid("target fields must be exactly accountId and content");
      }
      return {
        ...target,
        content: normalizeManualContent(input.content, config.context.forgeCapsuleMaxChars),
        editedByUser: target.editedByUser === true || input.content.trim() !== target.content,
      };
    });
    const timestamp = nowIso(now);
    const updated = store.update("contextForgeDrafts", draft.id, {
      targets,
      version: draft.version + 1,
      updatedAt: timestamp,
    });
    publish(updated);
    return publicDraft(updated);
  }

  function cancelDraft(draftId, { now } = {}) {
    const draft = store.find("contextForgeDrafts", draftId);
    if (!draft) throw new ApiError("not_found", `Forge draft ${draftId} does not exist`);
    if (["confirmed", "stale", "cancelled"].includes(draft.status)) return publicDraft(draft);
    const timestamp = nowIso(now);
    const targets = structuredClone(draft.targets).map((target) => ACTIVE_TARGETS.has(target.status)
      ? {
          ...target,
          status: "cancelled",
          content: null,
          error: undefined,
          resultHash: resultHash({
            accountId: target.accountId,
            agentId: target.agentId,
            status: "cancelled",
          }),
          finishedAt: timestamp,
        }
      : target);
    const updated = store.update("contextForgeDrafts", draft.id, {
      targets,
      status: "cancelled",
      updatedAt: timestamp,
    });
    for (const target of draft.targets.filter((item) => ACTIVE_TARGETS.has(item.status))) {
      dispatchDaemonForge({
        accountId: target.accountId,
        event: {
          type: "context-forge.cancelled",
          data: { draftId: draft.id, accountId: target.accountId, agentId: target.agentId },
        },
      });
      settleWaiter(`${draft.id}:${target.accountId}`, { status: "cancelled" });
    }
    publish(updated);
    return publicDraft(updated);
  }

  function confirmDraft({ draftId, requestId, ifVersion }, { now } = {}) {
    requireString(requestId, "requestId");
    const draft = store.find("contextForgeDrafts", draftId);
    if (!draft) throw new ApiError("not_found", `Forge draft ${draftId} does not exist`);
    const prior = store.list("contextControlRequests").find((item) =>
      item.type === "forge" && item.spaceId === draft.spaceId && item.requestId === requestId);
    if (prior) {
      const result = startForgedSpaceSession(store, {
        spaceId: draft.spaceId,
        requestId,
        draftId,
        sourceSpaceSessionId: draft.sourceSpaceSessionId,
        targets: draft.targets,
      });
      return { draft: getDraft(draftId), ...result };
    }
    if (draft.status !== "ready") throw conflict("Forge draft is not ready");
    if (!Number.isInteger(ifVersion) || ifVersion !== draft.version) {
      throw conflict("Forge draft version is stale");
    }
    const current = ensureActiveSpaceSession(store, draft.spaceId);
    const currentSeq = completedMessageHighWater(store, current.id);
    if (current.id !== draft.sourceSpaceSessionId || currentSeq !== draft.sourceSeq) {
      const stale = store.update("contextForgeDrafts", draft.id, {
        status: "stale",
        updatedAt: nowIso(now),
      });
      publish(stale);
      throw new ApiError("history_conflict", "Forge source changed after the draft was generated");
    }
    if (hasActiveContextWork(store, [current.id]) ||
        store.list("contextForgeDrafts").some((candidate) =>
          candidate.id !== draft.id &&
          candidate.sourceSpaceSessionId === current.id &&
          candidate.status === "generating")) {
      throw new ApiError("session_busy", `space ${draft.spaceId} has active context work`);
    }
    const result = startForgedSpaceSession(store, {
      spaceId: draft.spaceId,
      requestId,
      draftId,
      sourceSpaceSessionId: draft.sourceSpaceSessionId,
      targets: draft.targets,
    }, { now });
    const timestamp = nowIso(now);
    const confirmed = store.update("contextForgeDrafts", draft.id, {
      status: "confirmed",
      confirmedAt: timestamp,
      newSpaceSessionId: result.newSession.id,
      updatedAt: timestamp,
    });
    publish(confirmed);
    return { draft: publicDraft(confirmed), ...result };
  }

  function submitDaemonResult({ draftId, agentId, accountId, input }) {
    const draft = store.find("contextForgeDrafts", draftId);
    if (!draft) throw new ApiError("not_found", `Forge draft ${draftId} does not exist`);
    const target = draft.targets.find((candidate) =>
      candidate.agentId === agentId && candidate.accountId === accountId);
    if (!target) throw new ApiError("forbidden", "Forge target does not match the authenticated Account");
    let normalized;
    try {
      normalized = {
        accountId,
        agentId,
        status: input.status,
        ...(input.status === "succeeded" ? {
          content: normalizeCapsule(input.content, config.context.forgeCapsuleMaxChars),
          execution: structuredClone(input.execution),
        } : {}),
        ...(input.error ? { error: structuredClone(input.error) } : {}),
      };
    } catch (error) {
      if (error?.code !== "forge_failed") throw error;
      normalized = { accountId, agentId, status: "failed", error: safeError() };
    }
    const updated = updateTargetRecord(store, draft, normalized);
    publish(updated);
    settleWaiter(`${draftId}:${accountId}`, normalized);
    return updated;
  }

  function forgeContextForSession(spaceSessionId) {
    const draft = store.list("contextForgeDrafts").find((candidate) =>
      candidate.status === "confirmed" && candidate.newSpaceSessionId === spaceSessionId);
    return draft ? publicDraft(draft) : null;
  }

  return {
    createDraft,
    getDraft,
    updateDraft,
    cancelDraft,
    confirmDraft,
    submitDaemonResult,
    forgeContextForSession,
  };
}
