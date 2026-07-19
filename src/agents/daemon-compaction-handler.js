// Account-bound AgentSession compaction confirmation and native execution.
// It never emits chat output or mutates daemon connection state.

const MODES = new Set(["native", "checkpoint_new_binding", "gateway_history"]);

class DaemonCompactionError extends Error {
  constructor(message) {
    super(message);
    this.code = "invalid_event";
  }
}

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new DaemonCompactionError(`${field} is required`);
  return value.trim();
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DaemonCompactionError(`${field} must be an object`);
  }
  return value;
}

function exact(value, keys, field) {
  const record = object(value, field);
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) {
    throw new DaemonCompactionError(`${field} fields are invalid`);
  }
  return record;
}

function safeBinding(value, { accountId, agentSessionId, generation }) {
  const binding = object(value, "providerBinding");
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") {
      if (typeof node === "string" && (node.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(node))) {
        throw new DaemonCompactionError("providerBinding contains a host path");
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      const normalized = key.toLowerCase();
      const usageTokens = /^(input|output|total)tokens$/u.test(normalized);
      if (/(secret|password|path|memory|history)/u.test(normalized) ||
          (normalized.includes("token") && !usageTokens)) {
        throw new DaemonCompactionError("providerBinding contains unsafe fields");
      }
      visit(child);
    }
  };
  visit(binding);
  if (binding.accountId !== accountId || typeof binding.providerFingerprint !== "string" ||
      !binding.providerFingerprint || !binding.providerState || typeof binding.providerState !== "object" ||
      Array.isArray(binding.providerState) ||
      (binding.agentSessionId !== undefined && binding.agentSessionId !== agentSessionId) ||
      (binding.generation !== undefined && binding.generation !== generation)) {
    throw new DaemonCompactionError("providerBinding does not match the compaction target");
  }
  return binding;
}

function validateEvent(data, identity, knownGeneration) {
  const request = exact(data, ["jobId", "target", "account", "input"], "compaction request");
  const target = exact(request.target, ["agentId", "agentSessionId", "fromGeneration", "mode"], "target");
  const account = exact(request.account, ["id", "name", "ownerAgentId"], "account");
  text(request.jobId, "jobId");
  text(target.agentSessionId, "target.agentSessionId");
  if (target.agentId !== identity.agentId || account.id !== identity.accountId ||
      account.ownerAgentId !== identity.agentId || !Number.isInteger(target.fromGeneration) ||
      target.fromGeneration < 1 || !MODES.has(target.mode) || !["api", "cli"].includes(identity.runtime.kind) ||
      (identity.runtime.kind === "api") !== (target.mode === "gateway_history") ||
      (knownGeneration !== null && knownGeneration !== undefined && knownGeneration !== target.fromGeneration)) {
    throw new DaemonCompactionError("compaction target does not match this daemon");
  }
  if (target.mode === "native") {
    const input = exact(request.input, ["providerBinding"], "input");
    if (input.providerBinding !== null) safeBinding(input.providerBinding, {
      accountId: account.id, agentSessionId: target.agentSessionId, generation: target.fromGeneration,
    });
  } else {
    exact(request.input, ["checkpoint"], "input");
    object(request.input.checkpoint, "input.checkpoint");
  }
  return { ...request, target, account };
}

export function createDaemonCompactionHandler({
  identity, executor, request, getKnownGeneration,
} = {}) {
  if (!identity || typeof request !== "function") throw new TypeError("compaction handler dependencies are unavailable");
  const active = new Map();
  const handled = new Set();
  const confirmedGenerations = new Map();

  async function compact(raw) {
    const key = typeof raw?.jobId === "string" && typeof raw?.target?.agentId === "string"
      ? `${raw.jobId}:${raw.target.agentId}` : null;
    if (key && handled.has(key)) return;
    let data;
    const sessionId = raw?.target?.agentSessionId;
    const observed = typeof sessionId === "string" ? getKnownGeneration?.(sessionId) : null;
    const confirmed = typeof sessionId === "string" ? confirmedGenerations.get(sessionId) : null;
    const knownGeneration = observed == null ? confirmed : confirmed == null ? observed : Math.max(observed, confirmed);
    try { data = validateEvent(raw, identity, knownGeneration); }
    catch { return; }
    const { jobId, target, account, input } = data;
    const currentKey = `${jobId}:${target.agentId}`;
    handled.add(currentKey);
    const controller = new AbortController();
    const task = (async () => {
      const base = { agentSessionId: target.agentSessionId, fromGeneration: target.fromGeneration };
      let result;
      try {
        if (target.mode !== "native") {
          result = { ...base, status: "succeeded", checkpoint: input.checkpoint };
        } else {
          if (typeof executor?.compactSession !== "function") throw new Error("native compact is unavailable");
          const output = await executor.compactSession({
            jobId, target, account, input, runtime: identity.runtime, signal: controller.signal,
          });
          if (controller.signal.aborted) throw new Error("compaction was cancelled");
          exact(output, ["providerBinding"], "compactSession result");
          result = { ...base, status: "succeeded", providerBinding: safeBinding(output.providerBinding, {
            accountId: account.id, agentSessionId: target.agentSessionId, generation: target.fromGeneration,
          }) };
        }
      } catch {
        result = controller.signal.aborted
          ? { ...base, status: "cancelled" }
          : { ...base, status: "failed", error: { code: "context_capacity", message: "Context compaction failed" } };
      }
      const submitted = await request(
        `/api/agent/compactions/${encodeURIComponent(jobId)}/targets/${encodeURIComponent(target.agentId)}`,
        { method: "PUT", body: result },
      ).then(() => true, () => false);
      if (submitted && result.status === "succeeded") {
        confirmedGenerations.set(target.agentSessionId, target.fromGeneration + 1);
      }
      return { submitted, result };
    })().finally(() => active.delete(currentKey));
    active.set(currentKey, { controller, task });
    await task;
  }

  function abort() {
    for (const { controller } of active.values()) controller.abort();
  }

  return {
    handleEnvelope(envelope) {
      if (envelope?.type !== "agent-session.compact.requested") return false;
      void compact(envelope.data);
      return true;
    },
    onStreamDisconnect: abort,
    async terminate() {
      abort();
      await Promise.allSettled([...active.values()].map(({ task }) => task));
    },
  };
}
