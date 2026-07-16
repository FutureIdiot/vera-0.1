// Per-Agent M4 Write Hook coordinator. Automatic timing reads only the
// per-Agent Data -> Memory config; manual Digest bypasses this module.

import { cronMatches, parseFiveFieldCron } from "../core/cron.js";
import { dreamScheduleMatches, nextDreamRunAt } from "./memory-dream-scheduler.js";

export { cronMatches, parseFiveFieldCron } from "../core/cron.js";

const MINUTE_MS = 60_000;
const unicodeLength = (value) => typeof value === "string" ? Array.from(value).length : 0;
const pairKey = (agentId, spaceSessionId) => `${agentId}\0${spaceSessionId}`;

function completedMessages(store, spaceSessionId) {
  return store.list("messages").filter((message) =>
    message.spaceSessionId === spaceSessionId && message.status === "completed").sort((a, b) => a._seq - b._seq);
}
function automaticPairs(store, onlySpaceSessionId, onlyAgentId) {
  const pairs = new Map();
  for (const agentSession of store.list("agentSessions")) {
    if (!agentSession?.agentId || (onlyAgentId && agentSession.agentId !== onlyAgentId)) continue;
    if (onlySpaceSessionId && agentSession.spaceSessionId !== onlySpaceSessionId) continue;
    const spaceSession = store.find("spaceSessions", agentSession.spaceSessionId);
    if (!spaceSession?.spaceId) continue;
    pairs.set(pairKey(agentSession.agentId, spaceSession.id), {
      agentId: agentSession.agentId, spaceId: spaceSession.spaceId, spaceSessionId: spaceSession.id,
    });
  }
  return [...pairs.values()];
}
function lastSuccessfulWatermarkSeq(store, agentId, spaceSessionId) {
  let watermark = -Infinity;
  for (const job of store.list("memoryDigestJobs")) {
    if (job.agentId !== agentId || job.spaceSessionId !== spaceSessionId ||
        job.mode !== "incremental" || job.status !== "succeeded") continue;
    const message = store.find("messages", job.range?.toMessageId);
    const toSeq = job.range?.toSeq ?? message?._seq;
    if (toSeq > watermark) watermark = toSeq;
  }
  return watermark;
}

export function createMemoryDigestScheduler({
  store, digestService, configService = null, settingsStore = null,
  isWriteEnabled = () => true,
  clock = { now: () => new Date() }, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
  logger = console,
} = {}) {
  if (!store || !digestService?.enqueueIncremental) throw new Error("createMemoryDigestScheduler requires store and digestService.enqueueIncremental");
  let legacySettings = settingsStore?.getAll?.() ?? {};
  let timer = null;
  let started = false;
  let closed = false;
  let lastTickMinute = null;

  function triggerFor(agentId) {
    if (configService) return configService.getConfig(agentId).config.digest.trigger;
    const mode = legacySettings["memory.digestTrigger"] ?? "manual";
    if (mode === "realtime") return { mode, thresholdChars: legacySettings["memory.digestRealtimeThresholdChars"] };
    if (mode === "scheduled") return { mode, cron: legacySettings["memory.digestSchedule"], timezone: "UTC" };
    return { mode: "manual" };
  }
  function report(error) { logger?.error?.("memory digest automatic trigger failed", { code: typeof error?.code === "string" ? error.code : "internal" }); }
  function enqueue(input) { Promise.resolve().then(() => digestService.enqueueIncremental(input)).catch(report); }

  function pendingWindow(agentId, spaceId, spaceSessionId) {
    if (typeof digestService.getIncrementalWindow === "function") {
      const resolved = digestService.getIncrementalWindow({ agentId, spaceId, spaceSessionId });
      if (!resolved) return { messages: [], charCount: 0 };
      return { messages: resolved.messages, charCount: resolved.range.charCount };
    }
    const watermark = lastSuccessfulWatermarkSeq(store, agentId, spaceSessionId);
    const messages = completedMessages(store, spaceSessionId).filter((message) => message._seq > watermark);
    return { messages, charCount: messages.reduce((sum, message) => sum + unicodeLength(message.content), 0) };
  }
  function getPendingContext(agentId) {
    const spaces = automaticPairs(store, null, agentId).map(({ spaceId, spaceSessionId }) => {
      const window = pendingWindow(agentId, spaceId, spaceSessionId);
      return { spaceId, spaceSessionId, messageCount: window.messages.length, charCount: window.charCount };
    }).filter((item) => item.messageCount > 0);
    return { messageCount: spaces.reduce((sum, item) => sum + item.messageCount, 0), charCount: spaces.reduce((sum, item) => sum + item.charCount, 0), spaces };
  }
  function enqueueCatchUp(agentId = null) {
    for (const pair of automaticPairs(store, null, agentId)) {
      const trigger = triggerFor(pair.agentId);
      if (trigger.mode !== "scheduled" || !isWriteEnabled(pair.agentId)) continue;
      const { messages } = pendingWindow(pair.agentId, pair.spaceId, pair.spaceSessionId);
      if (messages.length) enqueue({ ...pair, trigger: "scheduled", toMessageId: messages.at(-1).id });
    }
  }
  function scheduledMatches(trigger, date) {
    try {
      if (!configService) return cronMatches(parseFiveFieldCron(trigger.cron), date);
      return dreamScheduleMatches({ mode: "custom", cron: trigger.cron, timezone: trigger.timezone }, date);
    } catch { return false; }
  }
  function tick() {
    const current = Math.floor(clock.now().getTime() / MINUTE_MS) * MINUTE_MS;
    const first = lastTickMinute === null ? current : lastTickMinute + MINUTE_MS;
    for (const pair of automaticPairs(store)) {
      const trigger = triggerFor(pair.agentId);
      if (trigger.mode !== "scheduled" || !isWriteEnabled(pair.agentId)) continue;
      let matched = false;
      for (let minute = first; minute <= current; minute += MINUTE_MS) if (scheduledMatches(trigger, new Date(minute))) { matched = true; break; }
      if (!matched) continue;
      const { messages } = pendingWindow(pair.agentId, pair.spaceId, pair.spaceSessionId);
      if (messages.length) enqueue({ ...pair, trigger: "scheduled", toMessageId: messages.at(-1).id });
    }
    lastTickMinute = current;
  }
  function scheduleNext() {
    if (!started || closed) return;
    const nowMs = clock.now().getTime();
    const nextMinute = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
    timer = setTimeoutFn(onTimer, Math.max(1, nextMinute - nowMs));
    timer?.unref?.();
  }
  function onTimer() { timer = null; if (!started || closed) return; tick(); scheduleNext(); }
  function stopTimer() { if (timer !== null) clearTimeoutFn(timer); timer = null; }

  function refreshSettings(nextSettings) {
    legacySettings = nextSettings ?? settingsStore?.getAll?.() ?? legacySettings;
    if (!configService && started && !closed) { stopTimer(); lastTickMinute = Math.floor(clock.now().getTime() / MINUTE_MS) * MINUTE_MS; scheduleNext(); }
  }
  function refreshAgent(agentId) {
    if (!started || closed) return;
    if (triggerFor(agentId).mode === "scheduled") enqueueCatchUp(agentId);
  }
  function onMessageCommitted(message) {
    if (closed || message?.status !== "completed" || !message.spaceSessionId) return;
    for (const pair of automaticPairs(store, message.spaceSessionId)) {
      const trigger = triggerFor(pair.agentId);
      if (trigger.mode !== "realtime" || !isWriteEnabled(pair.agentId)) continue;
      const window = pendingWindow(pair.agentId, pair.spaceId, pair.spaceSessionId);
      if (!Number.isInteger(trigger.thresholdChars) || window.charCount < trigger.thresholdChars || !window.messages.length) continue;
      enqueue({ ...pair, trigger: "realtime", toMessageId: window.messages.at(-1).id });
    }
  }
  function start() {
    if (started || closed) return;
    started = true;
    lastTickMinute = Math.floor(clock.now().getTime() / MINUTE_MS) * MINUTE_MS;
    enqueueCatchUp();
    scheduleNext();
  }
  function close() { closed = true; stopTimer(); }
  function nextRunAt(agentId) {
    const trigger = triggerFor(agentId);
    return trigger.mode === "scheduled"
      ? nextDreamRunAt({ mode: "custom", cron: trigger.cron, timezone: trigger.timezone }, clock.now())
      : null;
  }
  return { onMessageCommitted, getPendingContext, refreshSettings, refreshAgent, nextRunAt, start, close };
}
