// Account-bound Forge generation. It uses an isolated executor entrypoint and
// only returns the final Capsule; provider reasoning and tool events stay local.

class DaemonForgeError extends Error {
  constructor(message) {
    super(message);
    this.code = "invalid_event";
  }
}

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new DaemonForgeError(`${field} is required`);
  return value.trim();
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DaemonForgeError(`${field} must be an object`);
  }
  return value;
}

function exact(value, keys, field) {
  const record = object(value, field);
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) {
    throw new DaemonForgeError(`${field} fields are invalid`);
  }
  return record;
}

function validateRequest(data, identity) {
  const request = exact(data, ["draftId", "target", "source", "limits"], "Forge request");
  const target = exact(
    request.target,
    ["accountId", "agentId", "runtimeRevision", "model"],
    "Forge target",
  );
  const source = exact(
    request.source,
    ["spaceId", "spaceSessionId", "sourceSeq", "messages"],
    "Forge source",
  );
  const limits = exact(request.limits, ["chunkChars", "capsuleChars"], "Forge limits");
  text(request.draftId, "draftId");
  text(source.spaceId, "source.spaceId");
  text(source.spaceSessionId, "source.spaceSessionId");
  if (target.agentId !== identity.agentId || target.accountId !== identity.accountId ||
      target.runtimeRevision !== identity.runtime.revision ||
      !text(target.model, "target.model") ||
      !Number.isInteger(source.sourceSeq) || source.sourceSeq < 0 ||
      !Array.isArray(source.messages) ||
      !Number.isInteger(limits.chunkChars) || limits.chunkChars < 1000 ||
      !Number.isInteger(limits.capsuleChars) || limits.capsuleChars < 1000) {
    throw new DaemonForgeError("Forge request does not match this daemon");
  }
  for (const message of source.messages) {
    exact(message, ["messageId", "author", "target", "content", "fileIds", "createdAt"], "Forge message");
    text(message.messageId, "message.messageId");
    object(message.author, "message.author");
    object(message.target, "message.target");
    if (typeof message.content !== "string" || !Array.isArray(message.fileIds) ||
        message.fileIds.some((id) => typeof id !== "string") ||
        (message.createdAt !== null && typeof message.createdAt !== "string")) {
      throw new DaemonForgeError("Forge message is invalid");
    }
  }
  return { ...request, target, source, limits };
}

export function createDaemonForgeHandler({ identity, executor, request } = {}) {
  if (!identity || typeof request !== "function") throw new TypeError("Forge handler dependencies are unavailable");
  const active = new Map();
  const handled = new Set();

  async function execute(raw) {
    let data;
    try { data = validateRequest(raw, identity); } catch { return; }
    const key = `${data.draftId}:${data.target.accountId}`;
    if (handled.has(key)) return;
    handled.add(key);
    const controller = new AbortController();
    const task = (async () => {
      let body;
      try {
        if (typeof executor?.executeForge !== "function") throw new Error("Forge executor is unavailable");
        const output = await executor.executeForge({
          target: data.target,
          source: data.source,
          limits: data.limits,
          signal: controller.signal,
        });
        if (controller.signal.aborted || typeof output?.content !== "string" || !output.content.trim()) {
          throw new Error("Forge executor returned no content");
        }
        body = {
          status: "succeeded",
          content: output.content,
          execution: {
            runtimeRevision: identity.runtime.revision,
            model: data.target.model,
            fallbackUsed: false,
          },
        };
      } catch {
        body = controller.signal.aborted
          ? { status: "cancelled" }
          : { status: "failed", error: { code: "forge_failed", message: "Forge context generation failed" } };
      }
      await request(
        `/api/agent/forges/${encodeURIComponent(data.draftId)}/targets/${encodeURIComponent(data.target.agentId)}`,
        { method: "PUT", body },
      ).catch(() => {});
    })().finally(() => active.delete(key));
    active.set(key, { controller, task });
    await task;
  }

  function cancel(data) {
    if (data?.agentId !== identity.agentId || data?.accountId !== identity.accountId ||
        typeof data?.draftId !== "string") return;
    active.get(`${data.draftId}:${data.accountId}`)?.controller.abort();
  }

  function abortAll() {
    for (const { controller } of active.values()) controller.abort();
  }

  return {
    handleEnvelope(envelope) {
      if (envelope?.type === "context-forge.requested") {
        void execute(envelope.data);
        return true;
      }
      if (envelope?.type === "context-forge.cancelled") {
        cancel(envelope.data);
        return true;
      }
      return false;
    },
    onStreamDisconnect: abortAll,
    async terminate() {
      abortAll();
      await Promise.allSettled([...active.values()].map(({ task }) => task));
    },
  };
}
