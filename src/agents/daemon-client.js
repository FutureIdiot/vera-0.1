// Process-local Agent daemon transport. Persistent secrets are loaded through
// daemon-credentials; AccountSession state never leaves this object.

import { randomUUID } from "node:crypto";
import { createDaemonCompactionHandler } from "./daemon-compaction-handler.js";
import { createMemoryTaskWorker } from "./memory-task-worker.js";
import { createDaemonRunHandler } from "./daemon-run-handler.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const CONFIG_EVENTS = new Set([
  "account.upserted", "account.presence.updated", "agent.updated", "space.updated", "config.updated",
]);

export class DaemonClientError extends Error {
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.name = "DaemonClientError";
    this.code = code;
    this.status = status;
  }
}

function gatewayBase(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new DaemonClientError("invalid_config", "gateway URL is invalid"); }
  const localHttp = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !localHttp)) {
    throw new DaemonClientError("invalid_config", "gateway URL is not allowed");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new DaemonClientError("invalid_config", `${field} is required`);
  return value.trim();
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DaemonClientError("invalid_event", `${field} must be an object`);
  }
  return value;
}

function normalizedRuntime(value) {
  const runtime = object(value, "runtime");
  const model = requiredText(runtime.model, "runtime.model");
  const capabilities = runtime.runtimeCapabilities == null
    ? {}
    : object(runtime.runtimeCapabilities, "runtime.runtimeCapabilities");
  const source = capabilities.models === undefined ? [model] : capabilities.models;
  if (!Array.isArray(source) || source.length === 0) {
    throw new DaemonClientError("invalid_config", "runtime models are required");
  }
  const models = source.map((item) => requiredText(item, "runtime model"));
  if (models.includes("default") || new Set(models).size !== models.length || !models.includes(model)) {
    throw new DaemonClientError("invalid_config", "runtime models must be unique and include the default model");
  }
  return {
    ...runtime,
    model,
    runtimeCapabilities: { ...capabilities, models },
  };
}

async function responseJson(response) {
  try { return await response.json(); } catch { return null; }
}

async function* sseEnvelopes(body) {
  if (!body) throw new DaemonClientError("gateway_unreachable", "event stream has no body");
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
      let envelope;
      try { envelope = JSON.parse(data); } catch { throw new DaemonClientError("invalid_event", "event data is invalid"); }
      yield envelope;
    }
  }
}

export function createDaemonClient({
  gatewayUrl, agentId, accountId, runtime, workspace, credentialStore, executor,
  memoryExecutor = null,
  fetchImpl = globalThis.fetch, daemonBootId = `boot_${randomUUID()}`,
  maxConnectionFailures = 3, reconnectBaseMs = 250, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const baseUrl = gatewayBase(gatewayUrl);
  const identity = {
    agentId: requiredText(agentId, "agentId"), accountId: requiredText(accountId, "accountId"),
    runtime: normalizedRuntime(runtime), workspace: object(workspace, "workspace"),
  };
  requiredText(identity.runtime.revision, "runtime.revision");
  requiredText(identity.workspace.hostId, "workspace.hostId");
  if (!credentialStore?.load || !(typeof executor === "function" || executor?.execute) || typeof fetchImpl !== "function") {
    throw new DaemonClientError("invalid_config", "daemon dependencies are unavailable");
  }
  const memoryWorker = createMemoryTaskWorker({
    gatewayUrl: baseUrl,
    agentId: identity.agentId,
    runtime: identity.runtime,
    memoryExecutor,
    fetchImpl,
    maxConnectionFailures,
    reconnectBaseMs,
    sleep,
  });
  let credentials = null;
  let session = null;
  let running = false;
  let loopPromise = null;
  let streamAbort = null;
  let heartbeatTimer = null;
  let lastHeartbeat = 0;
  let lastEventId = null;
  let terminal = null;

  function authHeaders({ accountKey = false } = {}) {
    const headers = { Authorization: `Bearer ${credentials.agentToken}` };
    if (accountKey) headers["X-Vera-Account-Key"] = credentials.accountKey;
    else headers["X-Vera-Account-Session"] = session.token;
    return headers;
  }

  async function request(path, { method = "GET", body, accountKey = false, signal } = {}) {
    const headers = authHeaders({ accountKey });
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: "error",
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new DaemonClientError("gateway_unreachable", "gateway request failed");
    }
    if (!response.ok) {
      const payload = await responseJson(response);
      throw new DaemonClientError(payload?.error?.code ?? "gateway_error", "gateway rejected daemon request", { status: response.status });
    }
    if (response.status === 204) return null;
    return responseJson(response);
  }

  const runHandler = createDaemonRunHandler({
    identity,
    executor,
    request,
    getAccountSessionId: () => session?.id ?? null,
    getTerminalReason: () => terminal,
  });
  const compactionHandler = createDaemonCompactionHandler({
    identity,
    executor,
    request,
    getKnownGeneration: runHandler.getKnownGeneration,
  });

  function loginBody() {
    const { hostId, kind, provider, model, revision, runtimeCapabilities = null } = identity.runtime;
    return {
      accountId: identity.accountId, daemonBootId,
      runtime: { hostId, kind, provider, model, revision, runtimeCapabilities },
      workspace: identity.workspace,
    };
  }

  async function login({ resume = false } = {}) {
    if (!resume && !credentials.accountKey) {
      throw new DaemonClientError("account_reauthentication_required", "Account Key is required to start daemon");
    }
    const payload = await request("/api/agent/login", {
      method: "POST", body: loginBody(), accountKey: !resume,
    });
    const next = payload?.accountSession;
    const token = resume ? session?.token : next?.token;
    if (!next?.id || !token) throw new DaemonClientError("invalid_response", "gateway did not issue AccountSession");
    session = { id: next.id, token, gatewayBootId: next.gatewayBootId };
    const interval = Number(payload?.heartbeatIntervalMs);
    return Number.isFinite(interval) && interval > 0 ? interval : 15000;
  }

  async function handleEnvelope(envelope) {
    if (Number.isFinite(envelope?.seq)) lastEventId = envelope.seq;
    if (envelope?.type === "agent.heartbeat") {
      lastHeartbeat = Date.now();
      return;
    }
    if (envelope?.type === "stream.reset") {
      throw new DaemonClientError("stream_reset", "event stream requires a login snapshot refresh");
    }
    if (runHandler.handleEnvelope(envelope)) return;
    if (compactionHandler.handleEnvelope(envelope)) return;
    if (CONFIG_EVENTS.has(envelope?.type)) await executor?.onConfig?.(envelope);
  }

  async function terminate(code) {
    if (!running) return;
    running = false;
    terminal = code;
    clearInterval(heartbeatTimer);
    streamAbort?.abort();
    await runHandler.terminate();
    await compactionHandler.terminate();
    await memoryWorker.stop();
    await executor?.shutdown?.();
  }

  function monitorHeartbeat(intervalMs) {
    clearInterval(heartbeatTimer);
    lastHeartbeat = Date.now();
    heartbeatTimer = setInterval(() => {
      if (running && Date.now() - lastHeartbeat >= intervalMs * 3) void terminate("gateway_unreachable");
    }, intervalMs);
    heartbeatTimer.unref?.();
  }

  async function connectionLoop() {
    let failures = 0;
    while (running) {
      streamAbort = new AbortController();
      try {
        const response = await fetchImpl(`${baseUrl}/api/agent/events`, {
          method: "GET", headers: {
            ...authHeaders(), Accept: "text/event-stream",
            ...(lastEventId === null ? {} : { "Last-Event-ID": String(lastEventId) }),
          },
          signal: streamAbort.signal, redirect: "error",
        });
        if (!response.ok) {
          const payload = await responseJson(response);
          throw new DaemonClientError(payload?.error?.code ?? "gateway_error", "event stream rejected", { status: response.status });
        }
        for await (const envelope of sseEnvelopes(response.body)) {
          failures = 0;
          await handleEnvelope(envelope);
        }
        if (running) throw new DaemonClientError("gateway_unreachable", "event stream ended");
      } catch (error) {
        if (!running) break;
        runHandler.onStreamDisconnect();
        compactionHandler.onStreamDisconnect();
        failures += 1;
        if (error?.code === "account_reauthentication_required") {
          await terminate("account_reauthentication_required");
          break;
        }
        if (failures >= maxConnectionFailures) {
          await terminate("gateway_unreachable");
          break;
        }
        await sleep(reconnectBaseMs * (2 ** (failures - 1)));
        try { monitorHeartbeat(await login({ resume: true })); }
        catch (loginError) {
          if (loginError?.code === "account_reauthentication_required") {
            await terminate("account_reauthentication_required");
            break;
          }
        }
      }
    }
    return { reason: terminal ?? "stopped" };
  }

  return {
    async start() {
      if (running) return this;
      credentials = await credentialStore.load({ agentId: identity.agentId, accountId: identity.accountId });
      if (!credentials?.agentToken) throw new DaemonClientError("account_reauthentication_required", "daemon credentials are unavailable");
      const interval = await login();
      running = true;
      monitorHeartbeat(interval);
      loopPromise = connectionLoop();
      memoryWorker.start({ token: credentials.agentToken });
      return this;
    },
    wait() { return loopPromise ?? Promise.resolve({ reason: terminal ?? "not_started" }); },
    async stop() {
      await terminate("stopped");
      await Promise.allSettled([loopPromise].filter(Boolean));
      return loopPromise;
    },
    get state() { return { running, reason: terminal, accountSessionId: session?.id ?? null, daemonBootId }; },
  };
}
