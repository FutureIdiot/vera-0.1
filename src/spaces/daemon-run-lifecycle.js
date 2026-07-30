// Gateway-side effects for authenticated daemon Run callbacks. Authentication
// and frozen lease ownership are enforced by daemon-runtime before these
// methods are called; this module owns timeline records and terminal state.

import { ApiError } from "../core/errors.js";
import { createApprovalRequest, expirePendingApprovalsForRun } from "./approvals.js";
import { createRunOutput, runFailureActivity } from "./run-output.js";
import { compilePrompt } from "./view-compiler.js";
import {
  assessContextPressure,
  rotateContextGeneration,
  updateContextPressure,
} from "./context-state.js";
import { modelContextFromCapabilities } from "../agents/runtime-contexts.js";
import {
  checkpointForAgent,
  effectiveContextLimit,
  estimateTokens,
  latestCheckpoint,
} from "./run-context.js";

function stripInternal({ _seq, ...record }) {
  return structuredClone(record);
}

export function createDaemonRunLifecycle({
  store,
  hub,
  config,
  agentStates = null,
  memoryDigestScheduler = null,
  memoryRetrieval = null,
  contextCompaction = null,
  contextForge = null,
  observation = null,
  runBackground = null,
  runMessages = null,
  dispatchRunCancel = null,
} = {}) {
  if (!store || !hub || !config) throw new Error("createDaemonRunLifecycle requires store, hub, and config");
  const outputs = new Map();
  const sourceOutputs = new Map();
  const bindingRotations = new Map();

  function outputFor(run, agent, account) {
    let output = outputs.get(run.id);
    if (!output) {
      output = createRunOutput({
        store,
        hub,
        config,
        spaceId: run.spaceId,
        spaceSessionId: run.spaceSessionId,
        runId: run.id,
        agent,
        account: { ...account, name: run.accountNameSnapshot ?? account.name },
        effectiveModel: run.effectiveModel,
        delegated: false,
        projectActivity: observation?.projectActivity,
        onMessageCompleted: (message, { agentRouting } = {}) => {
          if (agentRouting !== "none") runMessages?.routeAccountMessage?.(message);
        },
      });
      outputs.set(run.id, output);
    }
    return output;
  }

  function declareState({ account, agent, run, declaration }) {
    if (!declaration) return null;
    return agentStates?.declare?.({
      agentId: agent.id,
      ownerAgentId: account.ownerAgentId,
      accountId: account.id,
      spaceId: run.spaceId,
    }, declaration) ?? null;
  }

  function appendDelta({ account, agent, run, input }) {
    if (run.outputPolicy === "source") {
      const current = sourceOutputs.get(run.id) ?? "";
      sourceOutputs.set(run.id, `${current}${input.delta ?? ""}${input.paragraphEnd ? "\n\n" : ""}`);
      return { replyMessageIds: [] };
    }
    const output = outputFor(run, agent, account);
    if (input.delta) output.bubbles.delta(input.delta);
    if (input.paragraphEnd) output.bubbles.delta("\n\n");
    return { replyMessageIds: [...output.bubbles.replyMessageIds] };
  }

  function createMessage({ account, agent, run, input }) {
    if (run.outputPolicy === "source") {
      if (typeof input.content === "string" && input.content) {
        sourceOutputs.set(run.id, input.content);
      }
      return { message: null };
    }
    const output = outputFor(run, agent, account);
    // The daemon may stream deltas and then submit the authoritative full
    // content. In that case the POST is a finalize signal, not a second copy.
    // If no delta was sent, the full content is the fallback bubble.
    output.bubbles.finish(
      output.bubbles.replyMessageIds.length ? undefined : input.content,
      input.target,
      input.agentRouting,
    );
    const messageId = output.bubbles.replyMessageIds.at(-1);
    return { message: messageId ? stripInternal(store.find("messages", messageId)) : null };
  }

  function upsertActivity({ account, agent, run, input }) {
    if (run.outputPolicy === "source") return { activity: null };
    const output = outputFor(run, agent, account);
    output.onActivity(input);
    const activity = store.list("activities").filter((item) => item.runId === run.id).at(-1) ?? null;
    return { activity: activity ? stripInternal(activity) : null };
  }

  function createApproval({ account, agent, run, input, dispatchEvent }) {
    const space = store.find("spaces", run.spaceId);
    const seat = space?.seats?.find((candidate) => candidate.accountId === account.id);
    if ((seat?.approvalPolicy ?? "ask") === "approve") {
      return { approval: null, answer: "allow" };
    }
    if (run.outputPolicy === "source") {
      throw new ApiError("forbidden", "source-only Runs cannot create public Approval");
    }
    const { approval, answer } = createApprovalRequest({
      store,
      hub,
      spaceId: run.spaceId,
      spaceSessionId: run.spaceSessionId,
      runId: run.id,
      agentId: agent.id,
      req: input,
    });
    void answer.then((value) => {
      dispatchEvent?.({
        accountId: account.id,
        event: { type: "approval.answered", data: { approvalId: approval.id, answer: value } },
      });
    });
    return { approval };
  }

  function updateRun({ account, agent, run, input }) {
    if (input.agentState) declareState({ account, agent, run, declaration: input.agentState });
    if (input.status === undefined) return { run: stripInternal(store.find("runs", run.id)) };
    if (!new Set(["completed", "failed", "cancelled"]).has(input.status)) {
      throw new ApiError("invalid_request", "daemon may only submit a terminal Run status");
    }
    const current = store.find("runs", run.id);
    if (!current || current.status !== "running") throw new ApiError("conflict", "Run is no longer running");
    if (input.status === "completed") {
      const activeDescendant = store.list("runs").some((candidate) => {
        if (!["pending", "running"].includes(candidate.status)) return false;
        let parent = store.find("runs", candidate.parentRunId);
        while (parent) {
          if (parent.id === current.id) return true;
          parent = store.find("runs", parent.parentRunId);
        }
        return false;
      });
      if (activeDescendant) {
        return { run: stripInternal(current), awaitingChildren: true };
      }
    }
    if (input.status === "completed" && agent.runtimeProfile?.kind === "api" &&
        run.role === "root" && !Number.isInteger(current.apiResultVersion)) {
      const hasPublicReply = store.list("messages").some((message) =>
        message.runId === current.id && message.status === "completed");
      if (current.outputPolicy === "space" || hasPublicReply) {
        return { run: stripInternal(current), awaitingCommit: true };
      }
    }
    if (input.status === "completed" && current.outputPolicy === "source") {
      const hasTerminalSourceMessage = store.list("runMessages").some((message) =>
        message.sender?.type === "run" &&
        message.sender.runId === current.id &&
        ["result", "blocked"].includes(message.kind));
      if (!hasTerminalSourceMessage) {
        return { run: stripInternal(current), awaitingSourceResult: true };
      }
    }
    if (input.status !== "completed") {
      const descendants = store.list("runs")
        .filter((candidate) => {
          if (!["pending", "running"].includes(candidate.status)) return false;
          let parent = store.find("runs", candidate.parentRunId);
          while (parent) {
            if (parent.id === current.id) return true;
            parent = store.find("runs", parent.parentRunId);
          }
          return false;
        })
        .sort((left, right) => (right.depth ?? 0) - (left.depth ?? 0));
      for (const descendant of descendants) {
        if (descendant.status === "running") {
          try { dispatchRunCancel?.(descendant); } catch {}
        }
        cancelRun(descendant.id);
      }
    }
    const output = current.outputPolicy === "space" ? outputFor(current, agent, account) : null;
    if (input.status === "failed") {
      const error = input.error ?? { code: "internal", message: "Run 执行失败。" };
      output?.bubbles.fail();
      output?.onActivity(runFailureActivity(error));
    } else {
      output?.bubbles.finish();
    }
    expirePendingApprovalsForRun(store, hub, current.id);
    const replyMessageIds = [...new Set([
      ...(current.replyMessageIds ?? []),
      ...(output?.bubbles.replyMessageIds ?? []),
      ...store.list("messages").filter((message) => message.runId === current.id).map((message) => message.id),
    ])];
    let shouldCompact = false;
    if (input.status === "completed" && current.role === "root" &&
        agent.runtimeProfile?.kind === "cli" && Number.isFinite(input.usage?.inputTokens)) {
      const runtime = {
        ...(agent.runtimeProfile ?? {}),
        model: current.effectiveModel,
        connection: structuredClone(agent.runtimeBinding?.connection ?? {}),
        runtimeCapabilities: structuredClone(
          agent.runtimeBinding?.runtimeSnapshot?.runtimeCapabilities ?? {},
        ),
      };
      const modelContext = modelContextFromCapabilities(
        runtime.runtimeCapabilities,
        current.effectiveModel,
      );
      const reportedWindow = Number.isInteger(input.usage.contextWindowTokens) &&
        input.usage.contextWindowTokens > 0
        ? {
            contextWindowTokens: input.usage.contextWindowTokens,
            windowMeasurement: "provider_reported",
          }
        : modelContext ? {
            contextWindowTokens: modelContext.contextWindowTokens,
            windowMeasurement: modelContext.measurement,
          } : {};
      const agentSession = updateContextPressure(store, {
        agentSessionId: current.agentSessionId,
        generation: current.contextGeneration,
        estimatedInputTokens: input.usage.inputTokens,
        effectiveLimitTokens: effectiveContextLimit(config, runtime),
        measurement: "provider_reported",
        ...reportedWindow,
      });
      shouldCompact = assessContextPressure(agentSession, config.context).shouldCompact;
    }
    const patch = {
      status: input.status,
      endedAt: new Date().toISOString(),
      replyMessageIds,
    };
    if (input.status === "failed") patch.error = input.error ?? { code: "internal", message: "run failed" };
    if (current.outputPolicy === "source") {
      runMessages?.completeSourceRun?.(current.id, {
        status: input.status,
        content: sourceOutputs.get(current.id) ?? "",
        error: input.error,
      });
    }
    runMessages?.failRecipient?.(current.id);
    const updated = store.update("runs", current.id, patch);
    outputs.delete(current.id);
    sourceOutputs.delete(current.id);
    bindingRotations.delete(current.id);
    const catchupTask = runBackground?.finishRun?.(updated, {
      runtimeKind: agent.runtimeProfile?.kind,
    }) ?? null;
    hub.publish("run.ended", { run: stripInternal(updated) });
    const hasOtherActiveRun = store.list("runs").some((candidate) =>
      candidate.id !== updated.id &&
      candidate.agentId === updated.agentId &&
      candidate.accountId === updated.accountId &&
      candidate.spaceId === updated.spaceId &&
      ["pending", "running"].includes(candidate.status));
    if (!hasOtherActiveRun) {
      declareState({
        account,
        agent,
        run: updated,
        declaration: {
          agentId: agent.id,
          accountId: account.id,
          spaceId: updated.spaceId,
          status: "idle",
          detail: "",
        },
      });
    }
    for (const messageId of replyMessageIds) {
      const message = store.find("messages", messageId);
      if (message?.status === "completed") memoryDigestScheduler?.onMessageCommitted?.(message);
    }
    if (shouldCompact && contextCompaction) {
      void contextCompaction.compactAgent({
        spaceId: current.spaceId,
        agentId: current.agentId,
        requestId: `auto:${current.agentSessionId}:${current.contextGeneration}:${current.id}`,
      }).catch(() => {});
    }
    return {
      run: stripInternal(updated),
      ...(catchupTask ? { catchupTask } : {}),
    };
  }

  async function rotateProviderBinding({ account, agent, run, input }) {
    const prior = bindingRotations.get(run.id);
    if (prior) {
      if (prior.fromGeneration === input.generation) return structuredClone(prior.response);
      throw new ApiError("conflict", "provider binding rotation generation is stale");
    }
    const current = store.find("runs", run.id);
    if (!current || current.status !== "running" || current.role !== "root" ||
        agent.runtimeProfile?.kind !== "cli" ||
        current.contextGeneration !== input.generation) {
      throw new ApiError("conflict", "provider binding rotation does not match the active CLI Run");
    }
    if (store.list("messages").some((message) => message.runId === current.id)) {
      throw new ApiError("conflict", "provider binding can rotate only before the first reply");
    }
    const space = store.find("spaces", current.spaceId);
    const triggerMessage = store.find("messages", current.triggerMessageId);
    if (!space || !triggerMessage) {
      throw new ApiError("conflict", "provider binding rotation context is unavailable");
    }
    const checkpoint = checkpointForAgent(store, {
      spaceSessionId: current.spaceSessionId,
      agentId: agent.id,
      recentTurnLimit: config.context.checkpointRecentTurns,
      maxChars: config.viewCompiler.groupDeltaMaxChars,
    });
    const nextSession = rotateContextGeneration(store, {
      agentSessionId: current.agentSessionId,
      fromGeneration: current.contextGeneration,
      checkpoint,
    });
    store.update("runs", current.id, { contextGeneration: nextSession.generation });
    await memoryRetrieval?.ensureSession?.({
      agentId: agent.id,
      agentSessionId: nextSession.id,
      generation: nextSession.generation,
    });
    const runtime = {
      ...(agent.runtimeProfile ?? {}),
      model: current.effectiveModel,
      connection: structuredClone(agent.runtimeBinding?.connection ?? {}),
      runtimeCapabilities: structuredClone(
        agent.runtimeBinding?.runtimeSnapshot?.runtimeCapabilities ?? {},
      ),
    };
    const prompt = await compilePrompt({
      store,
      space,
      agent,
      account,
      triggerMessage,
      memoryRetrieval,
      spaceSessionId: current.spaceSessionId,
      agentSessionId: nextSession.id,
      generation: nextSession.generation,
      includeResidentIndex: true,
      apiHistory: null,
      checkpoint: latestCheckpoint(store, nextSession.id),
      runId: current.id,
      config,
    });
    if (estimateTokens(prompt.text) > Math.floor(
      effectiveContextLimit(config, runtime) * config.context.hardRatio,
    )) {
      throw new ApiError("context_capacity", "current message exceeds the AgentSession context capacity");
    }
    const response = {
      generation: nextSession.generation,
      promptText: prompt.text,
      providerBinding: null,
    };
    bindingRotations.set(current.id, {
      fromGeneration: input.generation,
      response: structuredClone(response),
    });
    return response;
  }

  function cancelRun(runId) {
    const current = store.find("runs", runId);
    if (!current) throw new ApiError("not_found", `run ${runId} does not exist`);
    if (!["pending", "running"].includes(current.status)) return stripInternal(current);
    const account = store.find("accounts", current.accountId);
    const agent = store.find("agents", current.agentId);
    const output = outputs.get(current.id);
    output?.bubbles.finish();
    expirePendingApprovalsForRun(store, hub, current.id);
    const replyMessageIds = [...new Set([
      ...(current.replyMessageIds ?? []),
      ...(output?.bubbles.replyMessageIds ?? []),
      ...store.list("messages").filter((message) => message.runId === current.id).map((message) => message.id),
    ])];
    if (current.outputPolicy === "source") {
      runMessages?.completeSourceRun?.(current.id, {
        status: "cancelled",
        content: sourceOutputs.get(current.id) ?? "",
        error: { code: "cancelled", message: "Run cancelled by owner" },
      });
    }
    const updated = store.update("runs", current.id, {
      status: "cancelled",
      endedAt: new Date().toISOString(),
      replyMessageIds,
      error: { code: "cancelled", message: "Run cancelled by owner" },
    });
    outputs.delete(current.id);
    sourceOutputs.delete(current.id);
    bindingRotations.delete(current.id);
    runMessages?.failRecipient?.(current.id);
    const hasOtherActiveRun = store.list("runs").some((candidate) =>
      candidate.id !== updated.id &&
      candidate.agentId === updated.agentId &&
      candidate.accountId === updated.accountId &&
      candidate.spaceId === updated.spaceId &&
      ["pending", "running"].includes(candidate.status));
    if (account && agent && !hasOtherActiveRun) {
      declareState({
        account,
        agent,
        run: current,
        declaration: {
          agentId: agent.id,
          accountId: account.id,
          spaceId: current.spaceId,
          status: "idle",
          detail: "",
        },
      });
    }
    runBackground?.finishRun?.(updated, {
      runtimeKind: agent?.runtimeProfile?.kind,
    });
    hub.publish("run.ended", { run: stripInternal(updated) });
    if (account && agent) {
      for (const messageId of replyMessageIds) {
        const message = store.find("messages", messageId);
        if (message?.status === "completed") memoryDigestScheduler?.onMessageCommitted?.(message);
      }
    }
    return stripInternal(updated);
  }

  return {
    updateRun,
    createMessage,
    appendDelta,
    upsertActivity,
    createApproval,
    rotateProviderBinding,
    cancelRun,
    submitCompactionResult: contextCompaction
      ? ({ job, target, input }) => contextCompaction.submitDaemonResult({ job, target, input })
      : undefined,
    submitForgeResult: contextForge
      ? ({ draft, target, input }) => contextForge.submitDaemonResult({
          draftId: draft.id,
          agentId: target.agentId,
          accountId: target.accountId,
          input,
        })
      : undefined,
  };
}
