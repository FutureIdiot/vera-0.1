// Gateway-owned daemon Run scheduling. The scheduler freezes the main Run,
// compiles its typed input, acquires the Account execution lease, and only
// then publishes run.requested to the authenticated owner daemon.

import { newRunId } from "../core/id.js";
import { ApiError } from "../core/errors.js";
import { projectAgent } from "../agents/agents.js";
import { projectAccount } from "../agents/accounts.js";
import { authorizeDaemonExecution } from "./execution-control.js";
import { compilePrompt } from "./view-compiler.js";
import {
  assessContextPressure,
  getApiHistory,
  getProviderBinding,
  providerFingerprintForRuntime,
} from "./context-state.js";
import {
  boundApiMessages,
  effectiveContextLimit,
  estimateTokens,
  latestCheckpoint,
} from "./run-context.js";

function stripInternal({ _seq, ...record }) {
  return structuredClone(record);
}

function publicWorkspace(workspace) {
  if (!workspace) return null;
  return {
    hostId: workspace.hostId,
    path: workspace.path,
    status: workspace.status,
    policy: structuredClone(workspace.policy ?? {}),
  };
}

function publicTrigger(message) {
  const { _seq, ...record } = message;
  return structuredClone(record);
}

export function createDaemonRunScheduler({
  store,
  hub,
  config,
  controlService,
  daemonRuntime,
  agentStates = null,
  memoryRetrieval = null,
  memoryDigestScheduler = null,
  contextCompaction = null,
} = {}) {
  if (!store || !hub || !config || !controlService || !daemonRuntime) {
    throw new Error("createDaemonRunScheduler requires store, hub, config, controlService, and daemonRuntime");
  }

  function failPending(runId, error) {
    const current = store.find("runs", runId);
    if (!current || current.status !== "pending") return current;
    const code = typeof error?.code === "string" ? error.code : "internal";
    const failed = store.update("runs", runId, {
      status: "failed",
      endedAt: new Date().toISOString(),
      error: {
        code,
        message: error instanceof ApiError ? error.message : "run could not start",
      },
    });
    hub.publish("run.ended", { run: stripInternal(failed) });
    return failed;
  }

  async function prepareAndDispatch({ runId, agent, account, space, agentSession, triggerMessage }) {
    try {
      let currentSession = store.find("agentSessions", agentSession.id);
      if (!currentSession || currentSession.status !== "active" ||
          currentSession.generation !== agentSession.generation) {
        throw new ApiError("history_conflict", "AgentSession changed before Run start");
      }
      const pressure = assessContextPressure(currentSession, config.context);
      if (pressure.shouldCompact) {
        if (!contextCompaction) {
          if (pressure.mustCompact) {
            throw new ApiError("context_capacity", "AgentSession must be compacted before Run start");
          }
        } else {
          currentSession = await contextCompaction.compactAgent({
            spaceId: space.id,
            agentId: agent.id,
            requestId: `auto:${currentSession.id}:${currentSession.generation}:${runId}`,
          });
          store.update("runs", runId, { contextGeneration: currentSession.generation });
        }
      }
      const runtime = {
        ...(agent.runtimeProfile ?? {}),
        connection: structuredClone(agent.runtimeBinding?.connection ?? {}),
      };
      const session = controlService.getSession(account.id);
      if (!session || session.agentId !== agent.id || session.runtimeRevision !== agent.runtimeRevision) {
        throw new ApiError("account_reauthentication_required", "Account Session requires reauthentication");
      }
      if (account.presence !== "online" || account.activeAgentId !== agent.id ||
          account.ownerAgentId !== agent.id) {
        throw new ApiError("adapter_unavailable", "Account owner daemon is offline");
      }
      const compacting = store.list("contextCompactionJobs").some((job) =>
        ["queued", "running"].includes(job.status) && job.targets?.some((target) =>
          target.accountId === account.id && ["queued", "running"].includes(target.status)));
      if (compacting) throw new ApiError("account_busy", "Account has an active context compaction");

      let providerBinding = runtime.kind === "api" ? null : getProviderBinding(store, {
        agentSessionId: currentSession.id,
        generation: currentSession.generation,
        accountId: account.id,
      });
      if (providerBinding && providerBinding.providerFingerprint !== providerFingerprintForRuntime(runtime)) {
        throw new ApiError("history_conflict", "CLI provider binding does not match the frozen runtime");
      }
      const apiHistory = runtime.kind === "api" ? getApiHistory(store, {
        agentSessionId: currentSession.id,
        generation: currentSession.generation,
      }) : null;
      const historyVersion = apiHistory?.version ?? 0;
      await memoryRetrieval?.ensureSession?.({
        agentId: agent.id,
        agentSessionId: currentSession.id,
        generation: currentSession.generation,
      });
      const prompt = await compilePrompt({
        store,
        space,
        agent,
        account,
        triggerMessage,
        memoryRetrieval,
        spaceSessionId: currentSession.spaceSessionId,
        agentSessionId: currentSession.id,
        generation: currentSession.generation,
        includeResidentIndex: runtime.kind !== "api" && providerBinding === null,
        apiHistory,
        checkpoint: latestCheckpoint(store, currentSession.id),
        runId,
        config,
      });
      const effectiveLimitTokens = effectiveContextLimit(config, runtime);
      let input;
      if (runtime.kind === "api") {
        input = {
          kind: "api",
          sessionMode: "main",
          messages: boundApiMessages(
            prompt.apiMessages,
            Math.floor(effectiveLimitTokens * config.context.hardRatio),
          ),
          historyVersion,
        };
      } else {
        if (estimateTokens(prompt.text) > Math.floor(effectiveLimitTokens * config.context.hardRatio)) {
          throw new ApiError("context_capacity", "current message exceeds the AgentSession context capacity");
        }
        input = {
          kind: "cli",
          sessionMode: "main",
          promptText: prompt.text,
          ...(providerBinding ? { providerBinding } : {}),
        };
      }

      const claimed = authorizeDaemonExecution({
        store,
        hub,
        runId,
        account,
        agent,
        session,
        workspaceHostId: account.workspace?.hostId,
        runtimeRevision: agent.runtimeRevision,
      });
      agentStates?.setWorking?.(agent.id, space.id, account.id);
      const running = store.find("runs", runId);
      daemonRuntime.dispatchRun({
        accountId: account.id,
        event: {
          type: "run.requested",
          data: {
            run: stripInternal(running),
            triggerMessage: publicTrigger(triggerMessage),
            agent: projectAgent(agent),
            account: projectAccount(account),
            workspace: publicWorkspace(account.workspace),
            input,
          },
        },
      });
      return claimed.execution;
    } catch (error) {
      failPending(runId, error);
      throw error;
    }
  }

  function scheduleMainRun({ agent, account, space, spaceSession, agentSession, triggerMessage }) {
    if (agent.id !== account.ownerAgentId || agent.id !== account.activeAgentId) {
      throw new ApiError("delegation_unavailable", "Only the online owner Agent may execute this Account");
    }
    const session = controlService.getSession(account.id);
    if (!session || session.agentId !== agent.id) {
      throw new ApiError("account_reauthentication_required", "Account Session requires reauthentication");
    }
    const runtime = agent.runtimeProfile ?? {};
    const run = store.insert("runs", {
      id: newRunId(),
      agentId: agent.id,
      accountId: account.id,
      accountNameSnapshot: account.name,
      parentRunId: null,
      role: "main",
      spaceId: space.id,
      spaceSessionId: spaceSession.id,
      agentSessionId: agentSession.id,
      contextGeneration: agentSession.generation,
      runtimeRevision: agent.runtimeRevision ?? null,
      effectiveModel: runtime.model ?? "",
      delegated: false,
      triggerMessageId: triggerMessage.id,
      replyMessageIds: [],
      status: "pending",
      executionTransport: "daemon",
      accountSessionId: session.id,
      executionLeaseId: null,
      workspaceHostId: account.workspace?.hostId ?? null,
      leaseAcquiredAt: null,
      apiResultVersion: null,
      createdAt: new Date().toISOString(),
      endedAt: null,
    });
    void prepareAndDispatch({
      runId: run.id,
      agent,
      account,
      space,
      agentSession,
      triggerMessage,
    }).catch(() => {});
    return stripInternal(run);
  }

  return {
    scheduleMainRun,
    failPending,
    onReplyCompleted(message) {
      memoryDigestScheduler?.onMessageCommitted?.(message);
    },
  };
}
