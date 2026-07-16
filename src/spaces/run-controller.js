// One main Run binds one active AgentSession generation and one Account. The
// gateway owns API history and CLI provider bindings; adapters only translate
// the typed input they receive.

import { newRunId } from "../core/id.js";
import { AdapterError, ApiError } from "../core/errors.js";
import { expirePendingApprovalsForRun } from "./approvals.js";
import { compilePrompt } from "./view-compiler.js";
import { getActiveContext } from "./context-sessions.js";
import {
  assessContextPressure,
  compareAndSetApiHistory,
  compareAndSetProviderBinding,
  getApiHistory,
  getProviderBinding,
  providerFingerprintForAccount,
  rotateContextGeneration,
  updateContextPressure,
} from "./context-state.js";
import { withAccountExecutionLock } from "./execution-lock.js";
import {
  boundApiMessages,
  checkpointForAgent,
  effectiveContextLimit,
  estimateTokens,
  latestCheckpoint,
} from "./run-context.js";
import { createRunOutput } from "./run-output.js";

const abortControllers = new Map();

function stripInternal({ _seq, ...rest }) {
  return rest;
}

export function cancelRun(runId) {
  const controller = abortControllers.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function recoverInterruptedRuns(store, { now = new Date().toISOString() } = {}) {
  const timestamp = typeof now === "function" ? now() : now;
  for (const run of store.list("runs").filter((item) => ["pending", "running"].includes(item.status))) {
    const replyMessages = store.list("messages").filter((message) => message.runId === run.id);
    for (const message of replyMessages.filter((item) => item.status === "streaming")) {
      store.update("messages", message.id, { status: "failed" });
    }
    for (const approval of store.list("approvals").filter((item) => item.runId === run.id && item.status === "pending")) {
      store.update("approvals", approval.id, { status: "expired", answer: "deny" });
    }
    for (const activity of store.list("activities").filter((item) =>
      item.runId === run.id && ["pending", "running"].includes(item.toolStatus))) {
      store.update("activities", activity.id, {
        phase: "error",
        toolStatus: "failed",
        detail: "Run interrupted by gateway restart",
        updatedAt: timestamp,
      });
    }
    store.update("runs", run.id, {
      status: "failed",
      endedAt: timestamp,
      replyMessageIds: [...new Set([...(run.replyMessageIds ?? []), ...replyMessages.map((item) => item.id)])],
      error: { code: "internal", message: "Run interrupted by gateway restart" },
    });
  }
}

export function executeRun({
  store, hub, config, agent, account, space, spaceSession, agentSession,
  triggerMessage, adapter, agentStates, memoryRetrieval, memoryDigestScheduler,
  contextCompaction,
}) {
  let activeSpaceSession = spaceSession;
  let activeAgentSession = agentSession;
  if (!activeSpaceSession || !activeAgentSession) {
    const active = getActiveContext(store, { spaceId: space.id, agentId: agent.id });
    activeSpaceSession = active.spaceSession;
    activeAgentSession = active.agentSession;
  }

  const run = {
    id: newRunId(),
    agentId: agent.id,
    accountId: account.id,
    parentRunId: null,
    role: "main",
    spaceId: space.id,
    spaceSessionId: activeSpaceSession.id,
    agentSessionId: activeAgentSession.id,
    contextGeneration: activeAgentSession.generation,
    triggerMessageId: triggerMessage.id,
    replyMessageIds: [],
    status: "pending",
    createdAt: new Date().toISOString(),
    endedAt: null,
  };
  const storedRun = store.insert("runs", run);
  const controller = new AbortController();
  abortControllers.set(storedRun.id, controller);

  const operation = (async () => {
    activeAgentSession = store.find("agentSessions", activeAgentSession.id) ?? activeAgentSession;
    const pressure = assessContextPressure(activeAgentSession, config.context);
    if (pressure.shouldCompact) {
      if (!contextCompaction) {
        if (pressure.mustCompact) throw new ApiError("context_capacity", "context compaction is unavailable");
      } else {
        try {
          activeAgentSession = await contextCompaction.compactAgent({
            spaceId: space.id,
            agentId: agent.id,
            requestId: `auto:${activeAgentSession.id}:${activeAgentSession.generation}:${storedRun.id}`,
          });
          store.update("runs", storedRun.id, { contextGeneration: activeAgentSession.generation });
        } catch (error) {
          // A compaction already queued for this AgentSession owns the same
          // Account lock. Wait behind it, then refresh the generation below.
          if (error?.code !== "session_busy" && pressure.mustCompact) throw error;
        }
      }
    }
    return withAccountExecutionLock(account.id, runWithLock);
  })();
  void operation.catch((error) => finishBeforeStart(error));

  function finishBeforeStart(error) {
    const current = store.find("runs", storedRun.id);
    if (!current || current.status !== "pending") return;
    abortControllers.delete(storedRun.id);
    const code = controller.signal.aborted ? "cancelled" : error?.code ?? "internal";
    const failed = store.update("runs", storedRun.id, {
      status: code === "cancelled" ? "cancelled" : "failed",
      endedAt: new Date().toISOString(),
      error: { code, message: code === "context_capacity" ? error.message : "run could not start" },
    });
    hub.publish("run.ended", { run: stripInternal(failed) });
  }

  async function runWithLock() {
    if (controller.signal.aborted) throw new AdapterError("cancelled", "run cancelled before start");
    const refreshedSession = store.find("agentSessions", activeAgentSession.id);
    if (!refreshedSession || refreshedSession.status !== "active" ||
        refreshedSession.spaceSessionId !== activeSpaceSession.id) {
      throw new ApiError("history_conflict", "AgentSession changed before Run start");
    }
    activeAgentSession = refreshedSession;
    store.update("runs", storedRun.id, { contextGeneration: activeAgentSession.generation });
    if (assessContextPressure(activeAgentSession, config.context).mustCompact) {
      throw new ApiError("context_capacity", "AgentSession must be compacted before Run start");
    }
    let providerBinding = account.kind === "api" ? null : getProviderBinding(store, {
      agentSessionId: activeAgentSession.id,
      generation: activeAgentSession.generation,
      accountId: account.id,
    });
    const providerFingerprint = providerFingerprintForAccount(account);
    if (providerBinding && providerBinding.providerFingerprint !== providerFingerprint) {
      const checkpoint = checkpointForAgent(store, {
        spaceSessionId: activeSpaceSession.id,
        agentId: agent.id,
        recentTurnLimit: config.context.checkpointRecentTurns,
        maxChars: config.viewCompiler.groupDeltaMaxChars,
      });
      activeAgentSession = rotateContextGeneration(store, {
        agentSessionId: activeAgentSession.id,
        fromGeneration: activeAgentSession.generation,
        checkpoint,
      });
      providerBinding = null;
      store.update("runs", storedRun.id, { contextGeneration: activeAgentSession.generation });
    }

    let apiHistory = account.kind === "api" ? getApiHistory(store, {
      agentSessionId: activeAgentSession.id,
      generation: activeAgentSession.generation,
    }) : null;
    let historyVersion = apiHistory?.version ?? 0;
    const effectiveLimitTokens = effectiveContextLimit(config, account);

    const compileCurrentPrompt = async () => {
      await memoryRetrieval?.ensureSession({
        agentId: agent.id,
        agentSessionId: activeAgentSession.id,
        generation: activeAgentSession.generation,
      });
      const prompt = await compilePrompt({
        store,
        space,
        agent,
        account,
        triggerMessage,
        memoryRetrieval,
        spaceSessionId: activeSpaceSession.id,
        agentSessionId: activeAgentSession.id,
        generation: activeAgentSession.generation,
        includeResidentIndex: account.kind !== "api" && providerBinding === null,
        apiHistory,
        checkpoint: latestCheckpoint(store, activeAgentSession.id),
        runId: storedRun.id,
        config,
      });
      if (account.kind === "api") {
        prompt.apiMessages = boundApiMessages(
          prompt.apiMessages,
          Math.floor(effectiveLimitTokens * config.context.hardRatio),
        );
      } else if (estimateTokens(prompt.text) > Math.floor(
        effectiveLimitTokens * config.context.hardRatio,
      )) {
        throw new ApiError("context_capacity", "current message exceeds the AgentSession context capacity");
      }
      return prompt;
    };

    let prompt;
    try {
      prompt = await compileCurrentPrompt();
    } catch (error) {
      throw error;
    }

    const running = store.update("runs", storedRun.id, {
      status: "running",
      contextGeneration: activeAgentSession.generation,
    });
    hub.publish("run.started", { run: stripInternal(running) });
    agentStates?.setWorking(agent.id, space.id);

    const output = createRunOutput({
      store,
      hub,
      config,
      spaceId: space.id,
      spaceSessionId: activeSpaceSession.id,
      runId: storedRun.id,
      agentId: agent.id,
    });
    const { bubbles, onActivity, requestApproval } = output;

    let bindingRotationUsed = false;
    const ctx = {
      agent,
      account,
      spaceSessionId: activeSpaceSession.id,
      agentSessionId: activeAgentSession.id,
      contextGeneration: activeAgentSession.generation,
      sessionMode: "main",
      prompt,
      providerBinding,
      historyVersion: account.kind === "api" ? historyVersion : undefined,
      workspacePath: process.cwd(),
      onDelta: (text) => bubbles.delta(text),
      onActivity,
      requestApproval,
      persistProviderBinding: (providerState, ifVersion) => {
        providerBinding = compareAndSetProviderBinding(store, {
          agentSessionId: activeAgentSession.id,
          generation: activeAgentSession.generation,
          accountId: account.id,
          providerFingerprint,
          providerState,
          ifVersion,
        });
        return providerBinding;
      },
      rotateProviderBinding: async ({ reason }) => {
        if (!["missing", "invalid"].includes(reason)) {
          throw new ApiError("invalid_request", "provider binding rotation reason is invalid");
        }
        if (bindingRotationUsed || bubbles.replyMessageIds.length > 0) {
          throw new ApiError("conflict", "provider binding can rotate only once before the first reply");
        }
        bindingRotationUsed = true;
        const checkpoint = checkpointForAgent(store, {
          spaceSessionId: activeSpaceSession.id,
          agentId: agent.id,
          recentTurnLimit: config.context.checkpointRecentTurns,
          maxChars: config.viewCompiler.groupDeltaMaxChars,
        });
        activeAgentSession = rotateContextGeneration(store, {
          agentSessionId: activeAgentSession.id,
          fromGeneration: activeAgentSession.generation,
          checkpoint,
        });
        providerBinding = null;
        store.update("runs", storedRun.id, { contextGeneration: activeAgentSession.generation });
        apiHistory = null;
        historyVersion = 0;
        const nextPrompt = await compileCurrentPrompt();
        ctx.agentSessionId = activeAgentSession.id;
        ctx.contextGeneration = activeAgentSession.generation;
        ctx.prompt = nextPrompt;
        ctx.providerBinding = null;
        return { prompt: nextPrompt, providerBinding: null, generation: activeAgentSession.generation };
      },
      signal: controller.signal,
    };

    let status = "completed";
    let runError = null;
    try {
      const result = await adapter.run(ctx);
      bubbles.finish(result?.content);
      if (account.kind === "api") {
        const replies = bubbles.replyMessageIds.map((id) => store.find("messages", id));
        if (replies.length === 0 || replies.some((message) => message?.status !== "completed")) {
          throw new ApiError("history_conflict", "API Run has no completed reply Messages");
        }
        const history = compareAndSetApiHistory(store, {
          agentSessionId: activeAgentSession.id,
          generation: activeAgentSession.generation,
          baseHistoryVersion: historyVersion,
          turn: {
            runId: storedRun.id,
            input: {
              sourceMessageId: triggerMessage.id,
              author: triggerMessage.author,
              target: triggerMessage.target,
              content: triggerMessage.content ?? "",
              fileIds: triggerMessage.fileIds ?? [],
              createdAt: triggerMessage.createdAt ?? null,
            },
            assistant: replies.map((message) => ({
              messageId: message.id,
              content: message.content,
              createdAt: message.createdAt,
            })),
            ...(result?.toolTranscript ? { toolTranscript: result.toolTranscript } : {}),
            ...(result?.usage ? { usage: result.usage } : {}),
          },
        });
        apiHistory = history;
        historyVersion = history.version;
      }
      const priorEstimate = account.kind === "api" ? 0 : activeAgentSession.context?.estimatedInputTokens ?? 0;
      const providerInputTokens = result?.usage?.inputTokens;
      const hasProviderMeasurement = Number.isFinite(providerInputTokens) && providerInputTokens >= 0;
      const measured = hasProviderMeasurement
        ? providerInputTokens
        : account.kind === "api"
          ? estimateTokens(apiHistory)
          : priorEstimate + estimateTokens(prompt.text) + estimateTokens(result?.content ?? "");
      activeAgentSession = updateContextPressure(store, {
        agentSessionId: activeAgentSession.id,
        generation: activeAgentSession.generation,
        estimatedInputTokens: measured,
        effectiveLimitTokens,
        measurement: hasProviderMeasurement ? "provider_reported" : "estimate",
      });
      const nextPressure = assessContextPressure(activeAgentSession, config.context);
      if (nextPressure.shouldCompact && contextCompaction) {
        void contextCompaction.compactAgent({
          spaceId: space.id,
          agentId: agent.id,
          requestId: `auto:${activeAgentSession.id}:${activeAgentSession.generation}:${storedRun.id}`,
        }).catch(() => {});
      }
    } catch (error) {
      bubbles.finish();
      if (error instanceof AdapterError) {
        status = error.code === "cancelled" ? "cancelled" : "failed";
        runError = error;
      } else {
        status = "failed";
        runError = error;
      }
    }
    await finishRunning({ status, error: runError, bubbles });
  }

  async function finishRunning({ status, error, bubbles }) {
    abortControllers.delete(storedRun.id);
    expirePendingApprovalsForRun(store, hub, storedRun.id);
    agentStates?.setIdle(agent.id);
    const code = controller.signal.aborted ? "cancelled" : error?.code;
    const patch = {
      status: controller.signal.aborted ? "cancelled" : status,
      endedAt: new Date().toISOString(),
      replyMessageIds: bubbles?.replyMessageIds ?? [],
    };
    if (error) patch.error = {
      code: code ?? "internal",
      message: error instanceof AdapterError || error instanceof ApiError
        ? error.message
        : "run failed",
    };
    const updated = store.update("runs", storedRun.id, patch);
    hub.publish("run.ended", { run: stripInternal(updated) });
    for (const messageId of patch.replyMessageIds) {
      const message = store.find("messages", messageId);
      if (message?.status === "completed") memoryDigestScheduler?.onMessageCommitted(message);
    }
  }

  return stripInternal(storedRun);
}
