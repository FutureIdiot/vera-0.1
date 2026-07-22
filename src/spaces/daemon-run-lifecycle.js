// Gateway-side effects for authenticated daemon Run callbacks. Authentication
// and frozen lease ownership are enforced by daemon-runtime before these
// methods are called; this module owns timeline records and terminal state.

import { newRunId } from "../core/id.js";
import { ApiError } from "../core/errors.js";
import { projectAgent } from "../agents/agents.js";
import { projectAccount } from "../agents/accounts.js";
import { createApprovalRequest, expirePendingApprovalsForRun } from "./approvals.js";
import { createRunOutput } from "./run-output.js";

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
  contextCompaction = null,
} = {}) {
  if (!store || !hub || !config) throw new Error("createDaemonRunLifecycle requires store, hub, and config");
  const outputs = new Map();

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
    const patch = {
      status: input.status,
      endedAt: new Date().toISOString(),
      replyMessageIds,
    };
    if (input.status === "failed") patch.error = input.error ?? { code: "internal", message: "run failed" };
    const updated = store.update("runs", current.id, patch);
    outputs.delete(current.id);
    hub.publish("run.ended", { run: stripInternal(updated) });
    for (const messageId of replyMessageIds) {
      const message = store.find("messages", messageId);
      if (message?.status === "completed") memoryDigestScheduler?.onMessageCommitted?.(message);
    }
    return { run: stripInternal(updated) };
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
    cancelRun,
    submitCompactionResult: contextCompaction
      ? ({ job, target, input }) => contextCompaction.submitDaemonResult({ job, target, input })
      : undefined,
  };
}
