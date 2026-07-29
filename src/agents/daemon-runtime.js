import { ApiError } from "../core/errors.js";
import { createEventHub } from "../api/sse.js";
import { createDaemonRunResults } from "./daemon-run-results.js";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const DIRECTED_DAEMON_EVENTS = new Set([
  "run.requested",
  "run-message.available",
  "run.activity-visibility.updated",
  "approval.answered",
  "agent-session.compact.requested",
  "account.upserted",
  "space.updated",
  "agent.updated",
  "account.presence.updated",
]);

function invalid(message) { throw new ApiError("invalid_request", message); }
function conflict(message) { throw new ApiError("conflict", message); }
function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) invalid(`${field} must be a non-empty string`);
  return value.trim();
}
function strictObject(value, { allowed, required = [], name = "body" }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object`);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    invalid(`${name} fields are invalid`);
  }
  return value;
}

export function createDaemonRuntime({
  store,
  hub,
  agentStates = null,
  controlService,
  config = {},
  runLifecycle = {},
  observation = null,
  runMessages = null,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  if (!controlService?.authenticateCurrentAccountSession) {
    throw new TypeError("controlService.authenticateCurrentAccountSession is required");
  }
  const channels = new Map();
  const heartbeatIntervalMs = config.agentDaemon?.heartbeatIntervalMs ?? 15000;
  const bufferSize = config.agentDaemon?.eventBufferSize ?? 200;

  function channelFor(accountId) {
    if (!channels.has(accountId)) channels.set(accountId, {
      hub: createEventHub({ bufferSize }),
      connection: null,
      sessionId: null,
    });
    return channels.get(accountId);
  }

  async function authenticate(headers) {
    return controlService.authenticateCurrentAccountSession(headers);
  }

  function assertRunAuthority(authority, run) {
    const agentSession = run?.agentSessionId ? store.find("agentSessions", run.agentSessionId) : null;
    const sessionMismatch = run?.agentSessionId !== null && (!agentSession ||
      agentSession.status !== "active" || agentSession.agentId !== authority.agent.id ||
      agentSession.accountId !== authority.account.id || agentSession.spaceSessionId !== run.spaceSessionId ||
      agentSession.generation !== run.contextGeneration);
    const isolatedMismatch = run?.role === "child" &&
      (run.agentSessionId !== null || run.contextGeneration !== null);
    if (!run || run.accountId !== authority.account.id || run.agentId !== authority.agent.id ||
        run.accountSessionId !== authority.session.id || run.executionTransport !== "daemon" ||
        run.runtimeRevision !== authority.session.runtimeRevision || run.runtimeRevision !== authority.agent.runtimeRevision ||
        run.workspaceHostId !== authority.session.runtimeHostId || run.workspaceHostId !== authority.account.workspace?.hostId ||
        run.status !== "running" || !run.executionLeaseId || sessionMismatch || isolatedMismatch) {
      throw new ApiError("forbidden", "Execution does not match the authenticated Account Session lease");
    }
  }

  async function runAuthority(runId, headers) {
    const authority = await authenticate(headers);
    const run = store.find("runs", runId);
    if (!run) throw new ApiError("not_found", `run ${runId} does not exist`);
    assertRunAuthority(authority, run);
    return { ...authority, run };
  }

  function invoke(name, payload) {
    const operation = runLifecycle[name];
    if (typeof operation !== "function") conflict(`daemon run lifecycle ${name} is unavailable`);
    return operation(payload);
  }

  async function openEvents(req, res) {
    const authority = await authenticate(req.headers);
    const channel = channelFor(authority.account.id);
    if (channel.sessionId !== authority.session.id) {
      channel.connection?.close();
      channel.hub = createEventHub({ bufferSize });
      channel.sessionId = authority.session.id;
    } else {
      channel.connection?.close();
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    const url = new URL(req.url, "http://localhost");
    const rawSince = url.searchParams.get("since") ?? req.headers["last-event-id"];
    const sinceSeq = rawSince == null ? 0 : Number(rawSince);
    const unsubscribe = channel.hub.subscribe({ write: (frame) => res.write(frame) }, {
      sinceSeq: Number.isFinite(sinceSeq) ? sinceSeq : 0,
    });
    const heartbeat = setTimer(() => {
      if (controlService.getSession(authority.account.id)?.id !== authority.session.id) {
        close();
        return;
      }
      channel.hub.publish("agent.heartbeat", { ts: new Date().toISOString() });
    }, heartbeatIntervalMs);
    heartbeat.unref?.();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimer(heartbeat);
      unsubscribe();
      if (channel.connection?.close === close) channel.connection = null;
      res.end?.();
    };
    channel.connection = { close };
    req.on?.("close", close);
    return { accountId: authority.account.id, agentId: authority.agent.id, sessionId: authority.session.id };
  }

  function dispatchEvent({ accountId, event }) {
    requiredText(accountId, "accountId");
    strictObject(event, { allowed: ["type", "data"], required: ["type", "data"], name: "event" });
    requiredText(event.type, "event.type");
    const channel = channelFor(accountId);
    const current = controlService.getSession(accountId);
    if (!current) conflict("Account daemon event channel has no active authenticated Session");
    if (channel.sessionId !== current.id) {
      channel.connection?.close();
      channel.hub = createEventHub({ bufferSize });
      channel.sessionId = current.id;
    }
    return channel.hub.publish(event.type, structuredClone(event.data));
  }

  function dispatchRun({ accountId, event }) {
    if (!DIRECTED_DAEMON_EVENTS.has(event?.type)) invalid("daemon event type is not dispatchable");
    if (event.type === "run.requested" && event?.data?.run?.accountId !== accountId) {
      invalid("dispatchRun requires a matching run.requested Account");
    }
    if (event.type === "run.activity-visibility.updated") {
      const run = store.find("runs", event?.data?.runId);
      if (!run || run.accountId !== accountId || run.status !== "running" ||
          !observation?.isVisibility?.(event?.data?.activityVisibility)) {
        invalid("dispatchRun requires a valid running Run visibility update");
      }
    }
    return dispatchEvent({ accountId, event });
  }

  async function createRunMessage(runId, body, headers) {
    strictObject(body, {
      allowed: ["kind", "recipient", "recipientAgentId", "content", "sourceMessageIds", "idempotencyKey"],
      required: ["kind", "content", "idempotencyKey"],
    });
    requiredText(body.kind, "kind");
    requiredText(body.content, "content");
    requiredText(body.idempotencyKey, "idempotencyKey");
    if (body.recipient !== undefined) strictObject(body.recipient, {
      allowed: ["type", "runId"], required: ["type"], name: "recipient",
    });
    if (body.recipientAgentId !== undefined) requiredText(body.recipientAgentId, "recipientAgentId");
    if (body.sourceMessageIds !== undefined &&
        (!Array.isArray(body.sourceMessageIds) || body.sourceMessageIds.some((id) => typeof id !== "string"))) {
      invalid("sourceMessageIds must be an array of strings");
    }
    const authority = await runAuthority(runId, headers);
    if (!runMessages) conflict("RunMessage service is unavailable");
    return body.kind === "delegate"
      ? runMessages.createDelegate(authority.run.id, structuredClone(body))
      : runMessages.createMessage(authority.run.id, structuredClone(body));
  }

  async function listRunMessages(runId, after, headers) {
    const authority = await runAuthority(runId, headers);
    if (!runMessages) conflict("RunMessage service is unavailable");
    return runMessages.inbox(authority.run.id, after);
  }

  async function consumeRunMessage(runId, runMessageId, body, headers) {
    strictObject(body, { allowed: [] });
    const authority = await runAuthority(runId, headers);
    if (!runMessages) conflict("RunMessage service is unavailable");
    return { runMessage: runMessages.consume(authority.run.id, runMessageId) };
  }

  async function updateRun(runId, body, headers) {
    strictObject(body, { allowed: ["status", "error", "agentState", "usage"] });
    if (Object.keys(body).length === 0) invalid("run update must not be empty");
    const authority = await runAuthority(runId, headers);
    if (body.status !== undefined && !TERMINAL_RUN_STATUSES.has(body.status)) {
      invalid("daemon may only submit a terminal Run status");
    }
    if (body.status === "failed") strictObject(body.error, {
      allowed: ["code", "message"], required: ["code", "message"], name: "error",
    });
    if (body.status !== "failed" && body.error !== undefined) invalid("error is only valid for failed Runs");
    const isApiMain = authority.run.role === "root" && authority.agent.runtimeProfile?.kind === "api";
    if (body.usage !== undefined) {
      strictObject(body.usage, {
        allowed: [
          "inputTokens", "outputTokens", "thinkingTokens", "cacheReadTokens",
          "totalTokens", "contextWindowTokens",
        ],
        required: ["inputTokens"],
        name: "usage",
      });
      if (Object.values(body.usage).some((value) => !Number.isFinite(value) || value < 0) ||
          (body.usage.contextWindowTokens !== undefined &&
            (!Number.isInteger(body.usage.contextWindowTokens) || body.usage.contextWindowTokens <= 0)) ||
          body.status !== "completed" || isApiMain || authority.run.role === "child") {
        invalid("usage is only valid for a completed main CLI Run");
      }
    }
    const input = structuredClone(body);
    if (body.agentState !== undefined) {
      agentStates?.declare?.({
        agentId: authority.agent.id,
        ownerAgentId: authority.account.ownerAgentId,
        accountId: authority.account.id,
        spaceId: authority.run.spaceId,
      }, body.agentState);
      delete input.agentState;
    }
    return invoke("updateRun", { ...authority, input });
  }

  async function submitOutput(kind, runId, body, headers) {
    if (kind === "createMessage") {
      strictObject(body, {
        allowed: ["target", "content", "fileIds", "agentRouting"],
        required: ["content"],
      });
      if (typeof body.content !== "string") invalid("content must be a string");
      if (body.agentRouting !== undefined && !["default", "none"].includes(body.agentRouting)) {
        invalid("agentRouting must be default or none");
      }
      if (body.target !== undefined && (!body.target || typeof body.target !== "object" || Array.isArray(body.target))) {
        invalid("target must be an object");
      }
      if (body.fileIds !== undefined && (!Array.isArray(body.fileIds) || body.fileIds.some((id) => typeof id !== "string"))) {
        invalid("fileIds must be an array of strings");
      }
    } else if (kind === "appendDelta") {
      strictObject(body, { allowed: ["delta", "paragraphEnd"], required: ["delta"] });
      if (typeof body.delta !== "string") invalid("delta must be a string");
      if (body.paragraphEnd !== undefined && typeof body.paragraphEnd !== "boolean") invalid("paragraphEnd must be boolean");
    } else if (kind === "upsertActivity") {
      strictObject(body, {
        allowed: ["phase", "kind", "label", "summary", "detail", "toolStatus", "callId"],
        required: ["phase", "kind", "summary"],
      });
      requiredText(body.phase, "phase");
      requiredText(body.kind, "kind");
      requiredText(body.summary, "summary");
      if (!new Set([
        "reasoning", "command", "read", "edit", "search", "plan",
        "compact", "tool", "status", "usage", "error",
      ]).has(body.kind)) {
        invalid("kind must be a supported Activity kind");
      }
      if (/[\r\n]/u.test(body.summary) || body.summary.length > (config.activity?.summaryMaxLength ?? 160)) {
        invalid("summary must be a bounded single line");
      }
      for (const field of ["kind", "label", "summary", "detail", "toolStatus", "callId"]) {
        if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "string") {
          invalid(`${field} must be a string or null`);
        }
      }
    } else if (kind === "createApproval") {
      strictObject(body, { allowed: ["prompt", "options"], required: ["prompt", "options"] });
      if (typeof body.prompt !== "string" || !Array.isArray(body.options) ||
          body.options.length === 0 || body.options.some((option) => typeof option !== "string" || !option)) {
        invalid("approval prompt and options are invalid");
      }
    }
    const authority = await runAuthority(runId, headers);
    if (kind === "createMessage" && body.target !== undefined) {
      const keys = Object.keys(body.target).sort().join(",");
      const direct = body.target.type === "direct" &&
        keys === "accountIds,type" &&
        Array.isArray(body.target.accountIds) &&
        body.target.accountIds.length > 0 &&
        new Set(body.target.accountIds).size === body.target.accountIds.length &&
        body.target.accountIds.every((id) => typeof id === "string");
      const broadcast = body.target.type === "broadcast" && keys === "type";
      const space = store.find("spaces", authority.run.spaceId);
      const seatIds = new Set((space?.seats ?? []).map((seat) => seat.accountId));
      if (!direct && !broadcast) {
        invalid("target must be an exact broadcast or seated Account direct target");
      }
      if (direct && body.target.accountIds.some((id) => !seatIds.has(id))) {
        throw new ApiError("forbidden", "direct output target is not seated in this Space");
      }
      if (direct && store.list("messages").some((message) => message.runId === authority.run.id)) {
        throw new ApiError(
          "conflict",
          "direct output target must be frozen before the Run starts streaming",
        );
      }
    }
    if (kind === "upsertActivity" && body.detail &&
        observation?.visibilityForRun?.(authority.run) !== "observed") {
      throw new ApiError("forbidden", "Activity detail is only accepted for the observed private Space");
    }
    return invoke(kind, {
      ...authority,
      input: structuredClone(body),
      dispatchRun,
      dispatchEvent,
    });
  }

  const runResults = createDaemonRunResults({
    store,
    hub,
    runLifecycle,
    authenticate,
    runAuthority,
    assertRunAuthority,
  });

  return {
    openEvents,
    dispatchEvent,
    dispatchRun,
    createRunMessage,
    listRunMessages,
    consumeRunMessage,
    updateRun,
    createMessage: (id, body, headers) => submitOutput("createMessage", id, body, headers),
    appendDelta: (id, body, headers) => submitOutput("appendDelta", id, body, headers),
    upsertActivity: (id, body, headers) => submitOutput("upsertActivity", id, body, headers),
    createApproval: (id, body, headers) => submitOutput("createApproval", id, body, headers),
    saveProviderBinding: runResults.saveProviderBinding,
    rotateProviderBinding: runResults.rotateProviderBinding,
    saveApiResult: runResults.saveApiResult,
    submitCompaction: runResults.submitCompaction,
  };
}
