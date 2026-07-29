// Gateway-side effects for authenticated daemon Run callbacks. Authentication
// and frozen lease ownership are enforced by daemon-runtime before these
// methods are called; this module owns timeline records and terminal state.

import { newRunId } from "../core/id.js";
import { ApiError } from "../core/errors.js";
import { projectAgent } from "../agents/agents.js";
import { projectAccount } from "../agents/accounts.js";
import { createApprovalRequest, expirePendingApprovalsForRun } from "./approvals.js";
import { createRunOutput } from "./run-output.js";
import { compilePrompt } from "./view-compiler.js";
import {
  assessContextPressure,
  rotateContextGeneration,
  updateContextPressure,
} from "./context-state.js";
import {
  checkpointForAgent,
  effectiveContextLimit,
  estimateTokens,
  latestCheckpoint,
} from "./run-context.js";

function stripInternal({ _seq, ...record }) {
  return structuredClone(record);
}

function workspaceForDaemon(workspace) {
  return workspace ? {
    hostId: workspace.hostId,
    path: workspace.path,
    status: workspace.status,
    policy: structuredClone(workspace.policy ?? {}),
  } : null;
}

function isolatedPrompt(input) {
  const context = input.context === undefined
    ? ""
    : `\n\nContext:\n${typeof input.context === "string" ? input.context : JSON.stringify(input.context)}`;
  return `${input.task}${context}`;
}

export function createDaemonRunLifecycle({
  store,
  hub,
  config,
  agentStates = null,
  memoryDigestScheduler = null,
  memoryRetrieval = null,
  contextCompaction = null,
  observation = null,
  runBackground = null,
} = {}) {
  if (!store || !hub || !config) throw new Error("createDaemonRunLifecycle requires store, hub, and config");
  const outputs = new Map();
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
    const output = outputFor(run, agent, account);
    if (input.delta) output.bubbles.delta(input.delta);
    if (input.paragraphEnd) output.bubbles.delta("\n\n");
    return { replyMessageIds: [...output.bubbles.replyMessageIds] };
  }

  function createMessage({ account, agent, run, input }) {
    const output = outputFor(run, agent, account);
    // The daemon may stream deltas and then submit the authoritative full
    // content. In that case the POST is a finalize signal, not a second copy.
    // If no delta was sent, the full content is the fallback bubble.
    output.bubbles.finish(output.bubbles.replyMessageIds.length ? undefined : input.content);
    const messageId = output.bubbles.replyMessageIds.at(-1);
    return { message: messageId ? stripInternal(store.find("messages", messageId)) : null };
  }

  function upsertActivity({ account, agent, run, input }) {
    const output = outputFor(run, agent, account);
    output.onActivity(input);
    const activity = store.list("activities").filter((item) => item.runId === run.id).at(-1) ?? null;
    return { activity: activity ? stripInternal(activity) : null };
  }

  function createApproval({ account, agent, run, input, dispatchEvent }) {
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

  function createSubagent({ account, agent, session, run: parent, input, dispatchRun }) {
    const currentParent = store.find("runs", parent.id);
    if (!currentParent || currentParent.status !== "running") {
      throw new ApiError("conflict", "Parent Run is no longer running");
    }
    const task = isolatedPrompt(input);
    const child = store.insert("runs", {
      id: newRunId(),
      agentId: parent.agentId,
      accountId: parent.accountId,
      accountNameSnapshot: parent.accountNameSnapshot ?? account.name,
      parentRunId: parent.id,
      role: "subagent",
      spaceId: parent.spaceId,
      spaceSessionId: parent.spaceSessionId,
      agentSessionId: null,
      contextGeneration: null,
      runtimeRevision: parent.runtimeRevision,
      effectiveModel: parent.effectiveModel,
      modelVersion: parent.modelVersion,
      delegated: false,
      triggerMessageId: parent.triggerMessageId,
      replyMessageIds: [],
      status: "running",
      executionTransport: "daemon",
      accountSessionId: session.id,
      executionLeaseId: parent.executionLeaseId,
      workspaceHostId: parent.workspaceHostId,
      leaseAcquiredAt: parent.leaseAcquiredAt,
      apiResultVersion: null,
      createdAt: new Date().toISOString(),
      endedAt: null,
    });
    hub.publish("run.started", { run: stripInternal(child) });
    const runtimeKind = agent.runtimeProfile?.kind;
    const inputEnvelope = runtimeKind === "api"
      ? { kind: "api", sessionMode: "isolated", messages: [{ role: "user", content: task }] }
      : { kind: "cli", sessionMode: "isolated", promptText: task };
    const triggerMessage = store.find("messages", parent.triggerMessageId);
    dispatchRun({
      accountId: account.id,
      event: {
        type: "run.requested",
        data: {
          run: stripInternal(child),
          triggerMessage: triggerMessage ? stripInternal(triggerMessage) : null,
          agent: projectAgent(agent),
          account: projectAccount(account),
          workspace: workspaceForDaemon(account.workspace),
          input: inputEnvelope,
          activityVisibility: observation?.visibilityForSpace(parent.spaceId) ?? "status-only",
        },
      },
    });
    return { run: stripInternal(child) };
  }

  function updateRun({ account, agent, run, input }) {
    if (input.agentState) declareState({ account, agent, run, declaration: input.agentState });
    if (input.status === undefined) return { run: stripInternal(store.find("runs", run.id)) };
    if (!new Set(["completed", "failed", "cancelled"]).has(input.status)) {
      throw new ApiError("invalid_request", "daemon may only submit a terminal Run status");
    }
    const current = store.find("runs", run.id);
    if (!current || current.status !== "running") throw new ApiError("conflict", "Run is no longer running");
    if (input.status === "completed" && agent.runtimeProfile?.kind === "api" &&
        run.role === "main" && !Number.isInteger(current.apiResultVersion)) {
      throw new ApiError("history_conflict", "API result must be committed before Run completion");
    }
    const output = outputFor(current, agent, account);
    output.bubbles.finish();
    expirePendingApprovalsForRun(store, hub, current.id);
    const replyMessageIds = [...new Set([
      ...(current.replyMessageIds ?? []),
      ...output.bubbles.replyMessageIds,
      ...store.list("messages").filter((message) => message.runId === current.id).map((message) => message.id),
    ])];
    let shouldCompact = false;
    if (input.status === "completed" && current.role === "main" &&
        agent.runtimeProfile?.kind === "cli" && Number.isFinite(input.usage?.inputTokens)) {
      const runtime = {
        ...(agent.runtimeProfile ?? {}),
        model: current.effectiveModel,
        connection: structuredClone(agent.runtimeBinding?.connection ?? {}),
      };
      const agentSession = updateContextPressure(store, {
        agentSessionId: current.agentSessionId,
        generation: current.contextGeneration,
        estimatedInputTokens: input.usage.inputTokens,
        effectiveLimitTokens: effectiveContextLimit(config, runtime),
        measurement: "provider_reported",
      });
      shouldCompact = assessContextPressure(agentSession, config.context).shouldCompact;
    }
    const patch = {
      status: input.status,
      endedAt: new Date().toISOString(),
      replyMessageIds,
    };
    if (input.status === "failed") patch.error = input.error ?? { code: "internal", message: "run failed" };
    const updated = store.update("runs", current.id, patch);
    outputs.delete(current.id);
    bindingRotations.delete(current.id);
    const catchupTask = runBackground?.finishRun?.(updated, {
      runtimeKind: agent.runtimeProfile?.kind,
    }) ?? null;
    hub.publish("run.ended", { run: stripInternal(updated) });
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
    if (!current || current.status !== "running" || current.role !== "main" ||
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
    const updated = store.update("runs", current.id, {
      status: "cancelled",
      endedAt: new Date().toISOString(),
      replyMessageIds,
      error: { code: "cancelled", message: "Run cancelled by owner" },
    });
    outputs.delete(current.id);
    bindingRotations.delete(current.id);
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
    createSubagent,
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
  };
}
