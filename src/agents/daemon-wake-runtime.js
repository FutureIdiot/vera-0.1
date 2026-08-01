import { ApiError } from "../core/errors.js";
import { newWakeRequestId } from "../core/id.js";
import { createEventHub } from "../api/sse.js";

const WAKE_EVENT = "account.wake.requested";

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new ApiError("invalid_request", `${field} is required`);
  return value.trim();
}

export function createDaemonWakeRuntime({
  store,
  controlService,
  bufferSize = 32,
  keepaliveMs = 15000,
  now = () => new Date(),
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  if (!store || !controlService?.authenticateAgent) {
    throw new TypeError("createDaemonWakeRuntime requires store and controlService");
  }
  const channels = new Map();

  function channelFor(accountId) {
    if (!channels.has(accountId)) channels.set(accountId, {
      hub: createEventHub({ bufferSize }),
      connection: null,
    });
    return channels.get(accountId);
  }

  function ownerAccount(accountId, agentId) {
    const account = store.find("accounts", accountId);
    if (!account) throw new ApiError("not_found", `account ${accountId} does not exist`);
    if (account.ownerAgentId !== agentId) {
      throw new ApiError("delegation_unavailable", "Agent is not the Account owner");
    }
    return account;
  }

  async function authenticateSupervisor(req, accountId) {
    const { agent } = await controlService.authenticateAgent(req.headers);
    const account = ownerAccount(accountId, agent.id);
    return { account, agent };
  }

  async function openEvents(req, res) {
    const url = new URL(req.url, "http://localhost");
    const accountId = requiredText(url.searchParams.get("accountId"), "accountId");
    const { agent } = await authenticateSupervisor(req, accountId);
    const channel = channelFor(accountId);
    channel.connection?.close();
    channel.hub = createEventHub({ bufferSize });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    const unsubscribe = channel.hub.subscribe({ write: (frame) => res.write(frame) }, { sinceSeq: 0 });
    const keepalive = setTimer(() => res.write(": wake-keepalive\n\n"), keepaliveMs);
    keepalive.unref?.();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimer(keepalive);
      unsubscribe();
      if (channel.connection?.close === close) channel.connection = null;
      res.end?.();
    };
    channel.connection = { close };
    req.on?.("close", close);
    return { accountId, agentId: agent.id };
  }

  function requestWake(accountId) {
    const safeAccountId = requiredText(accountId, "accountId");
    const account = store.find("accounts", safeAccountId);
    if (!account) throw new ApiError("not_found", `account ${safeAccountId} does not exist`);
    if (!account.ownerAgentId) throw new ApiError("conflict", "Account has no owner Agent");
    if (account.presence === "online") return { requestId: null, state: "online" };
    const channel = channels.get(safeAccountId);
    if (!channel?.connection) {
      throw new ApiError("wake_unavailable", "Account wake supervisor is not connected");
    }
    const requestId = newWakeRequestId();
    const requestedAt = now().toISOString();
    channel.hub.publish(WAKE_EVENT, { accountId: safeAccountId, requestId, requestedAt });
    return { requestId, state: "queued" };
  }

  return { openEvents, requestWake };
}
