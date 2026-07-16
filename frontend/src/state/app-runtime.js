import { createHttpClient } from "../api/http-client.js";
import { createEventsClient } from "../api/events-client.js";
import { createSpacesClient } from "../api/spaces-client.js";
import { createReconnectingEventStream } from "../hooks/reconnecting-event-stream.js";

export function createAppRuntime({
  platform,
  maxBufferedEvents = 500,
  reconnectOptions = {},
  resetRetryDelayMs = 1000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  reportError = console.error,
} = {}) {
  const spaces = createSpacesClient(createHttpClient(platform));
  const events = createEventsClient(platform);
  const listeners = new Set();
  const recentEvents = [];
  let bootstrap = null;
  let stream = null;
  let closed = false;
  let resetting = false;
  let resetPending = false;
  let resetOverflow = false;
  let resetBuffer = [];
  let resetRetryTimer = null;

  function remember(envelope) {
    recentEvents.push(envelope);
    if (recentEvents.length > maxBufferedEvents) recentEvents.splice(0, recentEvents.length - maxBufferedEvents);
  }

  function publish(envelope) {
    applyBootstrapEvent(envelope);
    remember(envelope);
    for (const listener of listeners) listener(envelope);
  }

  function applyBootstrapEvent(envelope) {
    if (!bootstrap) return;
    const upsert = (items, item) => {
      if (!item?.id) return items;
      const index = items.findIndex((candidate) => candidate.id === item.id);
      if (index === -1) return [...items, item];
      const next = [...items];
      next[index] = item;
      return next;
    };
    if (envelope.type === "space.updated" && envelope.data?.space) {
      const space = envelope.data.space;
      bootstrap.spaces = space.archivedAt
        ? bootstrap.spaces.filter((candidate) => candidate.id !== space.id)
        : upsert(bootstrap.spaces, space);
    } else if (envelope.type === "space-session.created" && envelope.data?.spaceId && envelope.data?.spaceSession?.id) {
      bootstrap.spaces = bootstrap.spaces.map((space) => space.id === envelope.data.spaceId
        ? { ...space, activeSpaceSessionId: envelope.data.spaceSession.id }
        : space);
    } else if (envelope.type === "agent.updated" && envelope.data?.agent) {
      bootstrap.agents = upsert(bootstrap.agents, envelope.data.agent);
    } else if (envelope.type === "account.upserted" && envelope.data?.account) {
      bootstrap.accounts = upsert(bootstrap.accounts, envelope.data.account);
    } else if (envelope.type === "account.presence.updated" && envelope.data?.accountId) {
      bootstrap.accounts = bootstrap.accounts.map((account) => account.id === envelope.data.accountId
        ? { ...account, presence: envelope.data.presence, lastSeenAt: envelope.data.lastSeenAt }
        : account);
    } else if (envelope.type === "agent.state.updated" && envelope.data?.agentState) {
      const state = envelope.data.agentState;
      const index = bootstrap.agentStates.findIndex((candidate) => candidate.agentId === state.agentId && candidate.spaceId === state.spaceId);
      bootstrap.agentStates = index === -1
        ? [...bootstrap.agentStates, state]
        : bootstrap.agentStates.map((candidate, candidateIndex) => candidateIndex === index ? state : candidate);
    }
  }

  async function reset() {
    if (closed || resetting) return;
    resetting = true;
    resetPending = true;
    resetOverflow = false;
    resetBuffer = [];
    try {
      const nextBootstrap = await spaces.fetchBootstrap();
      if (closed) return;
      if (resetOverflow) {
        resetting = false;
        void reset();
        return;
      }
      bootstrap = nextBootstrap;
      const resetEnvelope = { type: "runtime.reset", seq: nextBootstrap.seq, data: { bootstrap: nextBootstrap } };
      recentEvents.length = 0;
      for (const listener of listeners) listener(resetEnvelope);

      const buffered = resetBuffer.filter((envelope) => envelope.seq > nextBootstrap.seq);
      resetBuffer = [];
      for (const envelope of buffered) publish(envelope);
      const latestSeq = buffered.reduce((latest, envelope) => Math.max(latest, envelope.seq), nextBootstrap.seq);
      stream?.resetSince(latestSeq);
      resetPending = false;
    } catch (err) {
      reportError("vera: failed to reset app runtime", err);
      const degraded = { type: "runtime.degraded", seq: bootstrap?.seq ?? 0, data: { reason: "reset_failed" } };
      for (const listener of listeners) listener(degraded);
      if (!closed && resetRetryTimer === null) {
        resetRetryTimer = setTimer(() => {
          resetRetryTimer = null;
          void reset();
        }, resetRetryDelayMs);
      }
    } finally {
      resetting = false;
    }
  }

  return {
    async start() {
      if (bootstrap) return;
      closed = false;
      bootstrap = await spaces.fetchBootstrap();
      stream = createReconnectingEventStream({
        ...reconnectOptions,
        connect: (options) => events.connect(options),
        initialSince: bootstrap.seq,
        onEvent: (envelope) => {
          if (resetPending) {
            resetBuffer.push(envelope);
            if (resetBuffer.length > maxBufferedEvents) {
              resetOverflow = true;
              resetBuffer.splice(0, resetBuffer.length - maxBufferedEvents);
            }
          } else publish(envelope);
        },
        onReset: () => {
          if (!resetPending) void reset();
        },
        onStatus: (status) => {
          const envelope = { type: "runtime.connection", seq: bootstrap?.seq ?? 0, data: { status } };
          for (const listener of listeners) listener(envelope);
        },
      });
    },
    getBootstrap() {
      if (!bootstrap) throw new Error("app runtime is not started");
      return bootstrap;
    },
    mergeSpace(space) {
      const envelope = { type: "space.updated", seq: bootstrap?.seq ?? 0, data: { space } };
      applyBootstrapEvent(envelope);
      for (const listener of listeners) listener(envelope);
    },
    mergeAgent(agent) {
      const envelope = { type: "agent.updated", seq: bootstrap?.seq ?? 0, data: { agent } };
      applyBootstrapEvent(envelope);
      for (const listener of listeners) listener(envelope);
    },
    mergeAccount(account) {
      const envelope = { type: "account.upserted", seq: bootstrap?.seq ?? 0, data: { account } };
      applyBootstrapEvent(envelope);
      for (const listener of listeners) listener(envelope);
    },
    removeAgent(agentId) {
      if (!bootstrap) return;
      bootstrap.agents = bootstrap.agents.filter((agent) => agent.id !== agentId);
      bootstrap.accounts = bootstrap.accounts.filter((account) => account.owningAgentId !== agentId);
    },
    removeAccount(accountId) {
      if (!bootstrap) return;
      bootstrap.accounts = bootstrap.accounts.filter((account) => account.id !== accountId);
    },
    subscribe(listener, { since = null } = {}) {
      listeners.add(listener);
      for (const envelope of recentEvents) {
        if (since === null || envelope.seq > since) listener(envelope);
      }
      return () => listeners.delete(listener);
    },
    reconnect() {
      stream?.reconnectNow();
    },
    close() {
      if (closed) return;
      closed = true;
      stream?.close();
      stream = null;
      if (resetRetryTimer !== null) clearTimer(resetRetryTimer);
      resetRetryTimer = null;
      listeners.clear();
      recentEvents.length = 0;
      resetBuffer = [];
      resetPending = false;
      resetOverflow = false;
      bootstrap = null;
    },
  };
}
