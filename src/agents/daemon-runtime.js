import { ApiError } from "../core/errors.js";
import { createEventHub } from "../api/sse.js";
import { createDaemonRunResults } from "./daemon-run-results.js";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const DIRECTED_DAEMON_EVENTS = new Set([
  "run.requested",
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
    const isolatedMismatch = run?.role === "subagent" &&
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
    return dispatchEvent({ accountId, event });
  }

  async function createSubagent(runId, body, headers) {
    strictObject(body, { allowed: ["task", "context"], required: ["task"] });
    requiredText(body.task, "task");
    if (body.context !== undefined &&
        (typeof body.context !== "string" && (!body.context || typeof body.context !== "object" || Array.isArray(body.context)))) {
      invalid("context must be a string or object");
    }
    const authority = await runAuthority(runId, headers);
    return invoke("createSubagent", { ...authority, input: structuredClone(body), dispatchRun });
  }

  async function updateRun(runId, body, headers) {
    strictObject(body, { allowed: ["status", "error", "agentState"] });
    if (Object.keys(body).length === 0) invalid("run update must not be empty");
    const authority = await runAuthority(runId, headers);
    if (body.status !== undefined && !TERMINAL_RUN_STATUSES.has(body.status)) {
      invalid("daemon may only submit a terminal Run status");
    }
    if (body.status === "failed") strictObject(body.error, {
      allowed: ["code", "message"], required: ["code", "message"], name: "error",
    });
    if (body.status !== "failed" && body.error !== undefined) invalid("error is only valid for failed Runs");
    const isApiMain = authority.run.role !== "subagent" && authority.agent.runtimeProfile?.kind === "api";
    if (body.status === "completed" && isApiMain) {
      const committed = Number.isInteger(authority.run.apiResultVersion) || store.list("apiHistories").some((history) =>
        history.agentSessionId === authority.run.agentSessionId &&
        history.generation === authority.run.contextGeneration &&
        history.turns?.some((turn) => turn.runId === authority.run.id));
      if (!committed) throw new ApiError("history_conflict", "API result must be committed before Run completion");
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
      strictObject(body, { allowed: ["target", "content", "fileIds"], required: ["content"] });
      if (typeof body.content !== "string") invalid("content must be a string");
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
      strictObject(body, { allowed: ["phase", "label", "detail", "toolStatus", "callId"], required: ["phase"] });
      requiredText(body.phase, "phase");
      for (const field of ["label", "detail", "toolStatus", "callId"]) {
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
    createSubagent,
    updateRun,
    createMessage: (id, body, headers) => submitOutput("createMessage", id, body, headers),
    appendDelta: (id, body, headers) => submitOutput("appendDelta", id, body, headers),
    upsertActivity: (id, body, headers) => submitOutput("upsertActivity", id, body, headers),
    createApproval: (id, body, headers) => submitOutput("createApproval", id, body, headers),
    saveProviderBinding: runResults.saveProviderBinding,
    saveApiResult: runResults.saveApiResult,
    submitCompaction: runResults.submitCompaction,
  };
}
