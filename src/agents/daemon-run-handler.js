// Account-bound Run protocol handler. Connection login, SSE lifecycle and
// reconnect policy remain owned by daemon-client.

const RUN_ERROR_CODES = new Set([
  "cancelled", "timed_out", "unavailable", "provider_error", "internal", "gateway_unreachable",
]);

class DaemonRunError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new DaemonRunError("invalid_event", `${field} is required`);
  return value.trim();
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DaemonRunError("invalid_event", `${field} must be an object`);
  }
  return value;
}


function validateRunEvent(data, current) {
  const run = object(data?.run, "run");
  const agent = object(data?.agent, "agent");
  const account = object(data?.account, "account");
  const workspace = object(data?.workspace, "workspace");
  const input = object(data?.input, "input");
  const mode = input.sessionMode;
  if (!text(run.id, "run.id") || run.agentId !== current.agentId || run.accountId !== current.accountId ||
      agent.id !== current.agentId || account.id !== current.accountId || account.ownerAgentId !== current.agentId ||
      run.accountSessionId !== current.accountSessionId || run.runtimeRevision !== current.runtime.revision ||
      run.delegated !== false || !text(run.executionLeaseId, "run.executionLeaseId") ||
      workspace.hostId !== current.workspace.hostId || run.workspaceHostId !== current.workspace.hostId ||
      !["main", "isolated"].includes(mode)) {
    throw new DaemonRunError("invalid_event", "run binding does not match this daemon");
  }
  const isolated = mode === "isolated";
  if (isolated !== (run.agentSessionId == null && run.contextGeneration == null)) {
    throw new DaemonRunError("invalid_event", "run session binding is invalid");
  }
  if (!isolated && (typeof run.agentSessionId !== "string" || !Number.isInteger(run.contextGeneration))) {
    throw new DaemonRunError("invalid_event", "main run session binding is invalid");
  }
  if (input.kind === "cli") {
    const keys = new Set(["kind", "sessionMode", "promptText", "providerBinding"]);
    if (Object.keys(input).some((key) => !keys.has(key)) || typeof input.promptText !== "string" ||
        "messages" in input || "historyVersion" in input || (isolated && "providerBinding" in input)) {
      throw new DaemonRunError("invalid_event", "CLI input is invalid");
    }
  } else if (input.kind === "api") {
    const keys = new Set(["kind", "sessionMode", "messages", "historyVersion"]);
    if (Object.keys(input).some((key) => !keys.has(key)) || !Array.isArray(input.messages) ||
        "promptText" in input || "providerBinding" in input || (isolated && "historyVersion" in input) ||
        (!isolated && !(typeof input.historyVersion === "string" ||
          (Number.isInteger(input.historyVersion) && input.historyVersion >= 0)))) {
      throw new DaemonRunError("invalid_event", "API input is invalid");
    }
  } else {
    throw new DaemonRunError("invalid_event", "run input kind is invalid");
  }
  return { ...data, run, agent, account, workspace, input };
}

function safeRunError(error) {
  const code = RUN_ERROR_CODES.has(error?.code) ? error.code : "internal";
  return { code, message: code === "gateway_unreachable" ? "gateway unreachable" : "daemon execution failed" };
}

export function createDaemonRunHandler({
  identity, executor, request, getAccountSessionId, getTerminalReason,
} = {}) {
  if (!identity || typeof request !== "function" || typeof getAccountSessionId !== "function" ||
      !(typeof executor === "function" || executor?.execute)) {
    throw new DaemonRunError("invalid_config", "Run handler dependencies are unavailable");
  }
  const execute = typeof executor === "function" ? executor : executor.execute.bind(executor);
  const activeRuns = new Map();
  const handledRuns = new Set();
  const approvalWaiters = new Map();
  const knownGenerations = new Map();

  function report(runId, suffix, method, body) {
    return request(`/api/agent/runs/${encodeURIComponent(runId)}${suffix}`, { method, body });
  }

  function denyApprovals(runId = null) {
    for (const [approvalId, waiter] of approvalWaiters) {
      if (runId !== null && waiter.runId !== runId) continue;
      approvalWaiters.delete(approvalId);
      waiter.resolve("deny");
    }
  }

  async function run(raw) {
    let data;
    try { data = validateRunEvent(raw, { ...identity, accountSessionId: getAccountSessionId() }); }
    catch (error) {
      if (raw?.run?.id) await report(raw.run.id, "", "PATCH", { status: "failed", error: safeRunError(error) }).catch(() => {});
      return;
    }
    const { run: current, input } = data;
    if (input.sessionMode === "main") knownGenerations.set(current.agentSessionId, current.contextGeneration);
    if (handledRuns.has(current.id)) return;
    handledRuns.add(current.id);
    const controller = new AbortController();
    activeRuns.set(current.id, controller);
    const assistantMessageIds = [];
    let reportTail = Promise.resolve();
    let reportError = null;
    const enqueue = (task) => {
      const next = reportTail.then(() => {
        if (reportError) throw reportError;
        return task();
      });
      reportTail = next.catch((error) => { reportError ??= error; });
      return next;
    };
    const onDelta = (delta, options = {}) => enqueue(() => report(current.id, "/delta", "POST", {
      delta: String(delta ?? ""), ...(options.paragraphEnd ? { paragraphEnd: true } : {}),
    }));
    const onMessage = (message) => enqueue(async () => {
      const content = typeof message === "string" ? message : message?.content;
      const response = await report(current.id, "/messages", "POST", { content: String(content ?? "") });
      const created = response?.message ?? response;
      if (created?.id) assistantMessageIds.push(created.id);
      return created ?? null;
    });
    const onActivity = (activity) => enqueue(() => report(current.id, "/activities", "POST", activity));
    const requestApproval = async (approvalRequest) => {
      const response = await report(current.id, "/approvals", "POST", {
        prompt: String(approvalRequest?.prompt ?? ""),
        options: Array.isArray(approvalRequest?.options) ? approvalRequest.options.map(String) : [],
      });
      const approval = response?.approval ?? response;
      if (!approval?.id) throw new DaemonRunError("invalid_response", "gateway did not create Approval");
      if (controller.signal.aborted) return "deny";
      return new Promise((resolve) => {
        const onAbort = () => {
          approvalWaiters.delete(approval.id);
          resolve("deny");
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        approvalWaiters.set(approval.id, {
          runId: current.id,
          resolve: (answer) => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve(answer);
          },
        });
      });
    };
    const persistProviderBinding = (providerState, ifVersion = null) => enqueue(async () => {
      if (input.sessionMode !== "main" || input.kind !== "cli") {
        throw new DaemonRunError("invalid_event", "isolated run cannot persist binding");
      }
      const response = await request(`/api/agent/provider-bindings/${encodeURIComponent(current.agentSessionId)}`, {
        method: "PUT",
        body: {
          generation: current.contextGeneration, accountId: current.accountId, agentId: current.agentId,
          runtimeRevision: current.runtimeRevision, providerState, ifVersion,
        },
      });
      return response?.providerBinding ?? response?.binding ?? response ?? null;
    });
    try {
      const result = await execute({
        ...data, signal: controller.signal, onDelta, onMessage, onActivity, requestApproval, persistProviderBinding,
      });
      if (controller.signal.aborted) {
        const code = getTerminalReason?.() === "gateway_unreachable" ? "gateway_unreachable" : "cancelled";
        throw new DaemonRunError(code, "run aborted");
      }
      await reportTail;
      if (reportError) throw reportError;
      if (!assistantMessageIds.length && typeof result?.content === "string" && result.content) await onMessage(result.content);
      await reportTail;
      if (reportError) throw reportError;
      if (input.kind === "api" && input.sessionMode === "main") {
        await report(current.id, "/api-result", "PUT", {
          agentSessionId: current.agentSessionId, generation: current.contextGeneration,
          baseHistoryVersion: input.historyVersion, assistantMessageIds,
          ...(result?.toolTranscript ? { toolTranscript: result.toolTranscript } : {}),
          ...(result?.usage ? { usage: result.usage } : {}),
        });
      }
      await report(current.id, "", "PATCH", { status: "completed" });
    } catch (error) {
      await reportTail;
      await report(current.id, "", "PATCH", { status: "failed", error: safeRunError(error) }).catch(() => {});
    } finally {
      denyApprovals(current.id);
      activeRuns.delete(current.id);
    }
  }

  function handleEnvelope(envelope) {
    if (envelope?.type === "run.requested") {
      void run(envelope.data);
      return true;
    }
    if (envelope?.type === "run.cancelled") {
      const runId = envelope.data?.runId ?? envelope.data?.run?.id;
      activeRuns.get(runId)?.abort();
      return true;
    }
    if (envelope?.type === "approval.answered") {
      const approvalId = envelope.data?.approvalId ?? envelope.data?.approval?.id;
      const answer = envelope.data?.answer ?? envelope.data?.approval?.answer ?? "deny";
      const waiter = approvalWaiters.get(approvalId);
      if (waiter) {
        approvalWaiters.delete(approvalId);
        waiter.resolve(typeof answer === "string" ? answer : "deny");
      }
      return true;
    }
    return false;
  }

  async function terminate() {
    denyApprovals();
    const patches = [];
    for (const [runId, controller] of activeRuns) {
      controller.abort();
      patches.push(report(runId, "", "PATCH", {
        status: "failed", error: safeRunError(new DaemonRunError("gateway_unreachable", "gateway unreachable")),
      }).catch(() => {}));
    }
    await Promise.allSettled(patches);
  }

  return {
    handleEnvelope,
    onStreamDisconnect: denyApprovals,
    getKnownGeneration: (agentSessionId) => knownGenerations.get(agentSessionId) ?? null,
    terminate,
  };
}
