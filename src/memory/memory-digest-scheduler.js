// M2 automatic digest trigger coordinator. It owns only trigger timing and the
// realtime Unicode-character watermark calculation; digestService remains the
// single job creation/pipeline facade. Manual submissions bypass this module.

import { cronMatches, parseFiveFieldCron } from "../core/cron.js";

export { cronMatches, parseFiveFieldCron } from "../core/cron.js";

const MINUTE_MS = 60_000;

function readSettings(settingsStore, supplied) {
  return supplied ?? settingsStore?.getAll?.() ?? {};
}

function unicodeLength(value) {
  return typeof value === "string" ? Array.from(value).length : 0;
}

function pairKey(agentId, spaceId) {
  return `${agentId}\u0000${spaceId}`;
}

function completedMessages(store, spaceId) {
  return store.list("messages")
    .filter((message) => message.spaceId === spaceId && message.status === "completed")
    .sort((a, b) => a._seq - b._seq);
}

function automaticPairs(store, onlySpaceId) {
  const pairs = new Map();
  for (const space of store.list("spaces")) {
    if (onlySpaceId && space.id !== onlySpaceId) continue;
    for (const seat of space.seats ?? []) {
      if (!seat?.agentId) continue;
      pairs.set(pairKey(seat.agentId, space.id), { agentId: seat.agentId, spaceId: space.id });
    }
  }
  return [...pairs.values()];
}

function lastSuccessfulWatermarkSeq(store, agentId, spaceId) {
  let watermark = -Infinity;
  for (const job of store.list("memoryDigestJobs")) {
    if (job.agentId !== agentId || job.spaceId !== spaceId || job.mode !== "incremental" || job.status !== "succeeded") continue;
    const message = store.find("messages", job.range?.toMessageId);
    const toSeq = job.range?.toSeq ?? message?._seq;
    if (toSeq > watermark) watermark = toSeq;
  }
  return watermark;
}

export function createMemoryDigestScheduler({
  store,
  digestService,
  settingsStore,
  clock = { now: () => new Date() },
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
} = {}) {
  if (!store || !digestService?.enqueueIncremental) {
    throw new Error("createMemoryDigestScheduler requires store and digestService.enqueueIncremental");
  }

  let settings = {};
  let cron = null;
  let timer = null;
  let started = false;
  let closed = false;
  let lastTickMinute = null;

  function report(error) {
    logger?.error?.("memory digest automatic trigger failed", {
      code: typeof error?.code === "string" ? error.code : "internal",
    });
  }

  function enqueue(input) {
    Promise.resolve()
      .then(() => digestService.enqueueIncremental(input))
      .catch(report);
  }

  function pendingWindow(agentId, spaceId) {
    if (typeof digestService.getIncrementalWindow === "function") {
      const resolved = digestService.getIncrementalWindow({ agentId, spaceId });
      if (!resolved) return { messages: [], charCount: 0 };
      return { messages: resolved.messages, charCount: resolved.range.charCount };
    }
    const watermark = lastSuccessfulWatermarkSeq(store, agentId, spaceId);
    const messages = completedMessages(store, spaceId).filter((message) => message._seq > watermark);
    return {
      messages,
      charCount: messages.reduce((sum, message) => sum + unicodeLength(message.content), 0),
    };
  }

  function enqueueScheduledCatchUp() {
    for (const pair of automaticPairs(store)) {
      const { messages } = pendingWindow(pair.agentId, pair.spaceId);
      if (messages.length === 0) continue;
      enqueue({ ...pair, trigger: "scheduled", toMessageId: messages.at(-1).id });
    }
  }

  function scheduleNextTick() {
    if (!started || closed || settings["memory.digestTrigger"] !== "scheduled" || !cron) return;
    const nowMs = clock.now().getTime();
    const nextMinute = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
    timer = setTimeoutFn(onTimer, Math.max(1, nextMinute - nowMs));
    timer?.unref?.();
  }

  function onTimer() {
    timer = null;
    if (!started || closed || settings["memory.digestTrigger"] !== "scheduled" || !cron) return;
    const now = clock.now();
    const currentMinute = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
    const firstMinute = lastTickMinute === null ? currentMinute : lastTickMinute + MINUTE_MS;
    let matched = false;
    for (let minute = firstMinute; minute <= currentMinute; minute += MINUTE_MS) {
      if (cronMatches(cron, new Date(minute))) {
        matched = true;
        break;
      }
    }
    lastTickMinute = currentMinute;
    if (matched) enqueueScheduledCatchUp();
    scheduleNextTick();
  }

  function stopTimer() {
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
  }

  function refreshSettings(nextSettings) {
    const previous = settings;
    settings = readSettings(settingsStore, nextSettings);
    const enteredScheduled = previous["memory.digestTrigger"] !== "scheduled";
    const scheduleChanged = previous["memory.digestSchedule"] !== settings["memory.digestSchedule"];
    stopTimer();
    cron = settings["memory.digestTrigger"] === "scheduled"
      ? parseFiveFieldCron(settings["memory.digestSchedule"])
      : null;
    if (started && !closed && cron) {
      lastTickMinute = Math.floor(clock.now().getTime() / MINUTE_MS) * MINUTE_MS;
      if (enteredScheduled || scheduleChanged) enqueueScheduledCatchUp();
      scheduleNextTick();
    }
  }

  function onMessageCommitted(message) {
    if (closed || settings["memory.digestTrigger"] !== "realtime" || message?.status !== "completed") return;
    const threshold = Number(settings["memory.digestRealtimeThresholdChars"]);
    if (!Number.isInteger(threshold) || threshold < 1) return;
    for (const pair of automaticPairs(store, message.spaceId)) {
      const window = pendingWindow(pair.agentId, pair.spaceId);
      if (window.charCount < threshold || window.messages.length === 0) continue;
      enqueue({ ...pair, trigger: "realtime", toMessageId: window.messages.at(-1).id });
    }
  }

  function start() {
    if (started || closed) return;
    started = true;
    refreshSettings();
  }

  function close() {
    if (closed) return;
    closed = true;
    stopTimer();
  }

  return { onMessageCommitted, refreshSettings, start, close };
}
