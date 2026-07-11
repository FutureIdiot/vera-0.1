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
    remember(envelope);
    for (const listener of listeners) listener(envelope);
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
      });
    },
    getBootstrap() {
      if (!bootstrap) throw new Error("app runtime is not started");
      return bootstrap;
    },
    subscribe(listener, { since = null } = {}) {
      listeners.add(listener);
      for (const envelope of recentEvents) {
        if (since === null || envelope.seq > since) listener(envelope);
      }
      return () => listeners.delete(listener);
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
