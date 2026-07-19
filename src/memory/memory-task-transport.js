// Agent-only Memory task transport. It is deliberately separate from Account
// Sessions and chat Runs: the gateway freezes/validates the task, while a
// matching executor Agent only receives the minimal proposal payload.

import { randomUUID } from "node:crypto";
import { ApiError } from "../core/errors.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

function invalid(message) {
  throw new ApiError("invalid_request", message);
}

function safeSnapshot(snapshot) {
  return {
    ownerAgentId: snapshot.ownerAgentId,
    executorAgentId: snapshot.executorAgentId,
    runtimeRevision: snapshot.runtimeRevision,
    kind: snapshot.kind,
    provider: snapshot.provider,
    modelMode: snapshot.modelMode,
    taskModel: snapshot.taskModel,
    verificationId: snapshot.verificationId,
  };
}

function validateResult(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("Memory task result must be an object");
  const allowed = new Set(["attempt", "status", "proposals", "execution", "error"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) invalid("Memory task result has unknown fields");
  if (!Number.isInteger(body.attempt) || body.attempt < 1) invalid("attempt must be a positive integer");
  if (!TERMINAL.has(body.status)) invalid("status must be succeeded, failed, or cancelled");
  if (body.status === "succeeded") {
    if (!Array.isArray(body.proposals)) invalid("succeeded result requires proposals");
    if (!body.execution || typeof body.execution !== "object" || Array.isArray(body.execution)) {
      invalid("succeeded result requires execution");
    }
    const keys = Object.keys(body.execution).sort();
    if (keys.join(",") !== "fallbackUsed,runtimeRevision,taskModel") {
      invalid("execution fields must be exactly fallbackUsed, runtimeRevision, taskModel");
    }
  } else if (body.proposals !== undefined || body.execution !== undefined) {
    invalid("failed or cancelled result must not include proposals or execution");
  }
  return structuredClone(body);
}

function unavailable(message = "Memory task daemon is unavailable") {
  return Object.assign(new Error(message), { code: "memory_task_unavailable" });
}

export function createMemoryTaskTransport({
  taskRuntime,
  timeoutMs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!taskRuntime || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("createMemoryTaskTransport requires taskRuntime and timeoutMs");
  }
  const subscribers = new Map();
  const pending = new Map();
  const terminal = new Map();
  let seq = 0;

  function publish(agentId, type, data) {
    const listeners = subscribers.get(agentId);
    if (!listeners?.size) return false;
    const envelope = { seq: ++seq, type, ts: new Date().toISOString(), data };
    const frame = `id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`;
    for (const listener of listeners) listener.write(frame);
    return true;
  }

  function subscribe(agentId, listener) {
    if (typeof agentId !== "string" || !agentId || !listener?.write) invalid("Memory task subscriber is invalid");
    const listeners = subscribers.get(agentId) ?? new Set();
    listeners.add(listener);
    subscribers.set(agentId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) subscribers.delete(agentId);
    };
  }

  function settle(record, error, value) {
    if (!pending.has(record.dispatchId)) return;
    pending.delete(record.dispatchId);
    clearTimer(record.timer);
    record.signal?.removeEventListener?.("abort", record.onAbort);
    if (error) record.reject(error);
    else record.resolve(value);
  }

  function dispatch({ jobId, kind, memoryTaskSnapshot, payload, signal, attempt = 1 } = {}) {
    taskRuntime.validateSnapshot(memoryTaskSnapshot);
    if (typeof jobId !== "string" || !jobId || !new Set(["digest", "dream"]).has(kind)) {
      return Promise.reject(unavailable("Memory task dispatch is invalid"));
    }
    if (!Number.isInteger(attempt) || attempt < 1) return Promise.reject(unavailable("Memory task attempt is invalid"));
    const dispatchId = `mtd_${randomUUID().replaceAll("-", "")}`;
    return new Promise((resolve, reject) => {
      const record = {
        dispatchId,
        jobId,
        kind,
        attempt,
        memoryTaskSnapshot: structuredClone(memoryTaskSnapshot),
        resolve,
        reject,
        signal,
        timer: null,
        onAbort: null,
      };
      record.onAbort = () => {
        publish(memoryTaskSnapshot.executorAgentId, "memory-task.cancelled", { dispatchId, attempt });
        settle(record, unavailable("Memory task was cancelled"));
      };
      pending.set(dispatchId, record);
      if (signal?.aborted) return record.onAbort();
      signal?.addEventListener?.("abort", record.onAbort, { once: true });
      record.timer = setTimer(() => settle(record, unavailable("Memory task daemon timed out")), timeoutMs);
      const sent = publish(memoryTaskSnapshot.executorAgentId, "memory-task.requested", {
        dispatchId,
        jobId,
        attempt,
        kind,
        memoryTaskSnapshot: safeSnapshot(memoryTaskSnapshot),
        payload: structuredClone(payload),
      });
      if (!sent) settle(record, unavailable());
    });
  }

  function submitResult(agentId, dispatchId, body) {
    const input = validateResult(body);
    const completed = terminal.get(dispatchId);
    if (completed) {
      if (completed.agentId === agentId && JSON.stringify(completed.body) === JSON.stringify(input)) {
        return structuredClone(completed.response);
      }
      throw new ApiError("conflict", "Memory task result is already terminal");
    }
    const record = pending.get(dispatchId);
    if (!record) throw new ApiError("not_found", `Memory task dispatch ${dispatchId} does not exist`);
    if (record.memoryTaskSnapshot.executorAgentId !== agentId) {
      throw new ApiError("forbidden", "Memory task belongs to another executor Agent");
    }
    if (record.attempt !== input.attempt) throw new ApiError("conflict", "Memory task attempt is stale");
    taskRuntime.validateSnapshot(record.memoryTaskSnapshot);
    if (input.status === "succeeded" &&
        (input.execution.runtimeRevision !== record.memoryTaskSnapshot.runtimeRevision ||
         input.execution.taskModel !== record.memoryTaskSnapshot.taskModel ||
         input.execution.fallbackUsed !== false)) {
      throw new ApiError("conflict", "Memory task execution does not match the frozen runtime");
    }
    const response = { accepted: true };
    terminal.set(dispatchId, { agentId, body: input, response });
    if (terminal.size > 1000) terminal.delete(terminal.keys().next().value);
    if (input.status === "succeeded") settle(record, null, {
      proposals: input.proposals,
      execution: input.execution,
    });
    else settle(record, unavailable(`Memory task ${input.status}`));
    return response;
  }

  return {
    subscribe,
    dispatch,
    submitResult,
    heartbeat(agentId) {
      return publish(agentId, "agent.heartbeat", { ts: new Date().toISOString() });
    },
    pendingCount() { return pending.size; },
  };
}

export { safeSnapshot as projectMemoryTaskSnapshot };
