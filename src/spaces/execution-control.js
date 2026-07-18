// Account execution control: daemon lease claims and Session revocation.

import { ApiError } from "../core/errors.js";
import { newExecutionLeaseId } from "../core/id.js";
import { expirePendingApprovalsForRun } from "./approvals.js";
import { cancelRun } from "./run-controller.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

function executionSummary(run) {
  return {
    runId: run.id,
    accountId: run.accountId,
    agentId: run.agentId,
    accountSessionId: run.accountSessionId,
    executionLeaseId: run.executionLeaseId,
    workspaceHostId: run.workspaceHostId,
    runtimeRevision: run.runtimeRevision,
  };
}

function rejectMismatch(message = "Execution does not match the owner Account Session") {
  throw new ApiError("forbidden", message);
}

/**
 * Atomically claim a daemon Run for the authenticated Account Session.
 * The caller must invoke this from the Control Service serialized mutation
 * queue; this function keeps the state transition and its publication as one
 * claim operation.
 */
export function authorizeDaemonExecution({
  store,
  hub = null,
  runId,
  account,
  agent,
  session,
  workspaceHostId,
  runtimeRevision,
}) {
  const run = store.find("runs", runId);
  if (!run || !["pending", "running"].includes(run.status)) {
    throw new ApiError("conflict", "Execution is not pending or running");
  }
  if (run.executionTransport !== "daemon") {
    throw new ApiError("conflict", "Execution does not use daemon transport");
  }
  if (run.accountId !== account.id || run.agentId !== agent.id ||
      run.runtimeRevision !== runtimeRevision || run.delegated === true ||
      run.accountSessionId !== session.id) {
    rejectMismatch();
  }
  if (account.workspace?.hostId !== workspaceHostId || session.runtimeHostId !== workspaceHostId ||
      (run.workspaceHostId !== null && run.workspaceHostId !== workspaceHostId)) {
    throw new ApiError("workspace_unavailable", "Workspace host is not admitted for this Execution");
  }

  // A retry for the same already-claimed Run is idempotent. This check must
  // precede the Account-wide busy check so a completed claim can be replayed
  // even while the lease is still the Account's active one.
  if (run.status === "running" && run.executionLeaseId &&
      run.accountSessionId === session.id && run.workspaceHostId === workspaceHostId) {
    return { execution: executionSummary(run), claimed: false };
  }
  if (run.status === "running") {
    throw new ApiError("conflict", "Execution already has an invalid or different lease");
  }

  const otherRunning = store.list("runs").some((candidate) =>
    candidate.accountId === account.id && candidate.id !== run.id && candidate.status === "running");
  if (otherRunning) {
    throw new ApiError("account_busy", "Account has another active Execution");
  }

  const claimed = store.update("runs", run.id, {
    status: "running",
    executionLeaseId: newExecutionLeaseId(),
    workspaceHostId,
    leaseAcquiredAt: new Date().toISOString(),
  });
  hub?.publish("run.started", { run: stripInternal(claimed) });
  return { execution: executionSummary(claimed), claimed: true };
}

export function releaseAccountExecutions(store, accountId, { hub = null, now = () => new Date().toISOString() } = {}) {
  const endedAt = now();
  for (const run of store.list("runs")) {
    if (run.accountId !== accountId || !["pending", "running"].includes(run.status)) continue;
    cancelRun(run.id);
    const replyMessages = store.list("messages").filter((message) => message.runId === run.id);
    for (const message of store.list("messages")) {
      if (message.runId === run.id && message.status === "streaming") {
        const updated = store.update("messages", message.id, { status: "failed" });
        hub?.publish("message.completed", { message: stripInternal(updated) });
      }
    }
    for (const activity of store.list("activities")) {
      if (activity.runId === run.id && ["pending", "running"].includes(activity.toolStatus)) {
        const updated = store.update("activities", activity.id, {
          phase: "error",
          toolStatus: "failed",
          detail: "Account Session was revoked",
          updatedAt: endedAt,
        });
        hub?.publish("activity.updated", { activity: stripInternal(updated) });
      }
    }
    expirePendingApprovalsForRun(store, hub, run.id);
    const failed = store.update("runs", run.id, {
      status: "failed",
      endedAt,
      replyMessageIds: [...new Set([...(run.replyMessageIds ?? []), ...replyMessages.map((message) => message.id)])],
      error: { code: "account_session_revoked", message: "Account Session was revoked" },
    });
    hub?.publish("run.ended", { run: stripInternal(failed) });
  }
}
