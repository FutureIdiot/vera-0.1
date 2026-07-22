// Agent-only Memory task transport. This worker never receives or sends an
// Account Key, AccountSession Token, Workspace, or chat Run context.

class MemoryTaskWorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new MemoryTaskWorkerError("invalid_event", `${field} is required`);
  return value.trim();
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryTaskWorkerError("invalid_event", `${field} must be an object`);
  }
  return value;
}

async function responseJson(response) {
  try { return await response.json(); } catch { return null; }
}

async function* envelopes(body) {
  if (!body) throw new MemoryTaskWorkerError("gateway_unreachable", "Memory worker stream has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/gu, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /u, ""))
        .join("\n");
      if (!data) continue;
      try { yield JSON.parse(data); }
      catch { throw new MemoryTaskWorkerError("invalid_event", "Memory worker event data is invalid"); }
    }
  }
}

function validateRequest(data, identity) {
  const allowed = new Set(["dispatchId", "jobId", "attempt", "kind", "memoryTaskSnapshot", "payload"]);
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).some((key) => !allowed.has(key)) || Object.keys(data).some((key) => data[key] === undefined)) {
    throw new MemoryTaskWorkerError("invalid_event", "Memory task request is invalid");
  }
  const snapshot = object(data.memoryTaskSnapshot, "memoryTaskSnapshot");
  const snapshotKeys = [
    "ownerAgentId", "executorAgentId", "runtimeRevision", "kind", "provider", "modelMode", "taskModel", "verificationId",
  ];
  const models = identity.runtime.runtimeCapabilities?.models ?? [identity.runtime.model];
  if (Object.keys(snapshot).sort().join(",") !== [...snapshotKeys].sort().join(",") ||
      !text(data.dispatchId, "dispatchId") || !text(data.jobId, "jobId") ||
      !Number.isInteger(data.attempt) || data.attempt < 1 || !["digest", "dream"].includes(data.kind) ||
      !text(snapshot.ownerAgentId, "memoryTaskSnapshot.ownerAgentId") ||
      !text(snapshot.executorAgentId, "memoryTaskSnapshot.executorAgentId") ||
      !text(snapshot.runtimeRevision, "memoryTaskSnapshot.runtimeRevision") ||
      !text(snapshot.kind, "memoryTaskSnapshot.kind") || !text(snapshot.provider, "memoryTaskSnapshot.provider") ||
      !["inherit", "fixed"].includes(snapshot.modelMode) || !text(snapshot.taskModel, "memoryTaskSnapshot.taskModel") ||
      !text(snapshot.verificationId, "memoryTaskSnapshot.verificationId") ||
      snapshot.executorAgentId !== identity.agentId || snapshot.runtimeRevision !== identity.runtime.revision ||
      snapshot.kind !== identity.runtime.kind || snapshot.provider !== identity.runtime.provider ||
      !models.includes(snapshot.taskModel) ||
      !data.payload || typeof data.payload !== "object" || Array.isArray(data.payload)) {
    throw new MemoryTaskWorkerError("invalid_event", "Memory task snapshot does not match this worker");
  }
  return { ...data, memoryTaskSnapshot: snapshot };
}

export function createMemoryTaskWorker({
  gatewayUrl, agentId, runtime, memoryExecutor = null, fetchImpl = globalThis.fetch,
  maxConnectionFailures = 3, reconnectBaseMs = 250,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const identity = { agentId: text(agentId, "agentId"), runtime: object(runtime, "runtime") };
  text(identity.runtime.revision, "runtime.revision");
  if (typeof fetchImpl !== "function") throw new MemoryTaskWorkerError("invalid_config", "Memory worker fetch is unavailable");
  let agentToken = null;
  let running = false;
  let streamAbort = null;
  let loopPromise = null;
  const active = new Map();
  const handled = new Set();

  async function request(path, body) {
    let response;
    try {
      response = await fetchImpl(`${gatewayUrl}${path}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${agentToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
      });
    } catch {
      throw new MemoryTaskWorkerError("gateway_unreachable", "Memory worker request failed");
    }
    if (!response.ok) {
      const payload = await responseJson(response);
      throw new MemoryTaskWorkerError(payload?.error?.code ?? "gateway_error", "Memory worker result was rejected");
    }
    return responseJson(response);
  }

  function submit(dispatchId, body) {
    return request(`/api/agent/memory-tasks/${encodeURIComponent(dispatchId)}/result`, body);
  }

  async function execute(raw) {
    let task;
    try { task = validateRequest(raw, identity); }
    catch {
      if (raw?.dispatchId && Number.isInteger(raw?.attempt)) {
        await submit(raw.dispatchId, {
          attempt: raw.attempt,
          status: "failed",
          error: { code: "memory_task_unavailable", message: "Memory task snapshot is unavailable" },
        }).catch(() => {});
      }
      return;
    }
    const key = `${task.dispatchId}:${task.attempt}`;
    if (handled.has(key)) return;
    handled.add(key);
    if (handled.size > 1000) handled.delete(handled.values().next().value);
    const controller = new AbortController();
    active.set(key, controller);
    try {
      const method = task.kind === "digest" ? "digestMemory" : "dreamMemory";
      const executeTask = typeof memoryExecutor === "function" ? memoryExecutor : memoryExecutor?.[method];
      if (typeof executeTask !== "function") throw new MemoryTaskWorkerError("memory_task_unavailable", "Memory task executor is unavailable");
      const result = await executeTask.call(memoryExecutor, {
        runtime: { ...identity.runtime, agentId: identity.agentId },
        taskModel: task.memoryTaskSnapshot.taskModel,
        payload: task.payload,
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new MemoryTaskWorkerError("cancelled", "Memory task was cancelled");
      if (!Array.isArray(result?.proposals)) throw new MemoryTaskWorkerError("executor_failed", "Memory task result is invalid");
      await submit(task.dispatchId, {
        attempt: task.attempt,
        status: "succeeded",
        proposals: result.proposals,
        execution: {
          runtimeRevision: task.memoryTaskSnapshot.runtimeRevision,
          taskModel: task.memoryTaskSnapshot.taskModel,
          fallbackUsed: false,
        },
      });
    } catch (error) {
      const cancelled = controller.signal.aborted || error?.code === "cancelled";
      await submit(task.dispatchId, {
        attempt: task.attempt,
        status: cancelled ? "cancelled" : "failed",
        error: {
          code: cancelled ? "cancelled" : error?.code === "memory_task_unavailable" ? "memory_task_unavailable" : "executor_failed",
          message: cancelled ? "Memory task was cancelled" : "Memory task execution failed",
        },
      }).catch(() => {});
    } finally {
      active.delete(key);
    }
  }

  function abortAll() {
    for (const controller of active.values()) controller.abort();
  }

  async function handle(envelope) {
    if (envelope?.type === "memory-task.requested") {
      void execute(envelope.data);
    } else if (envelope?.type === "memory-task.cancelled") {
      active.get(`${envelope.data?.dispatchId}:${envelope.data?.attempt}`)?.abort();
    }
  }

  async function loop() {
    let failures = 0;
    while (running && failures < maxConnectionFailures) {
      streamAbort = new AbortController();
      try {
        const response = await fetchImpl(`${gatewayUrl}/api/agent/memory-tasks/events`, {
          method: "GET",
          headers: { Authorization: `Bearer ${agentToken}`, Accept: "text/event-stream" },
          signal: streamAbort.signal,
          redirect: "error",
        });
        if (!response.ok) throw new MemoryTaskWorkerError("gateway_error", "Memory worker stream rejected");
        for await (const envelope of envelopes(response.body)) {
          if (envelope?.type === "agent.heartbeat") failures = 0;
          await handle(envelope);
        }
        if (running) throw new MemoryTaskWorkerError("gateway_unreachable", "Memory worker stream ended");
      } catch {
        if (!running) break;
        abortAll();
        failures += 1;
        if (failures < maxConnectionFailures) await sleep(reconnectBaseMs * (2 ** (failures - 1)));
      }
    }
  }

  return {
    start({ token } = {}) {
      if (running) return this;
      agentToken = text(token, "agentToken");
      running = true;
      loopPromise = loop();
      return this;
    },
    wait() { return loopPromise ?? Promise.resolve(); },
    async stop() {
      running = false;
      streamAbort?.abort();
      abortAll();
      await loopPromise;
    },
  };
}
