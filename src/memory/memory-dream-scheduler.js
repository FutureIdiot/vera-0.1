// Deterministic per-Agent Dream scheduler with IANA timezone matching. It only
// creates jobs; the Dream service owns idempotency, execution and persistence.

import { createHash } from "node:crypto";
import { cronMatches, parseFiveFieldCron } from "../core/cron.js";

const MINUTE_MS = 60_000;
const WEEKDAY = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });
const FORMATTERS = new Map();

function formatterFor(timezone) {
  if (FORMATTERS.has(timezone)) return FORMATTERS.get(timezone);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short",
    });
    formatter.format(new Date(0));
    FORMATTERS.set(timezone, formatter);
    return formatter;
  } catch { throw new Error(`invalid IANA timezone: ${timezone}`); }
}
function zonedParts(date, timezone) {
  const parts = Object.fromEntries(formatterFor(timezone).formatToParts(date)
    .filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), weekday: WEEKDAY[parts.weekday],
  };
}
function parsedTime(value) {
  const match = /^(\d{2}):(\d{2})$/u.exec(value ?? "");
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error("Dream schedule time must be HH:mm");
  return { hour: Number(match[1]), minute: Number(match[2]) };
}
export function dreamScheduleMatches(schedule, date) {
  if (!schedule || schedule.mode === "manual") return false;
  const local = zonedParts(date, schedule.timezone);
  if (schedule.mode === "daily" || schedule.mode === "weekly") {
    const time = parsedTime(schedule.time);
    if (local.hour !== time.hour || local.minute !== time.minute) return false;
    if (schedule.mode === "weekly") return local.weekday === Number(schedule.weekday) % 7;
    return true;
  }
  if (schedule.mode === "custom") {
    const cron = parseFiveFieldCron(schedule.cron);
    return cronMatches(cron, {
      getMinutes: () => local.minute,
      getHours: () => local.hour,
      getDate: () => local.day,
      getMonth: () => local.month - 1,
      getDay: () => local.weekday,
    });
  }
  throw new Error(`unsupported Dream schedule mode: ${schedule.mode}`);
}

export function nextDreamRunAt(schedule, after = new Date(), { maxMinutes = 370 * 24 * 60 } = {}) {
  if (!schedule || schedule.mode === "manual") return null;
  const start = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let offset = 0; offset < maxMinutes; offset += 1) {
    const candidate = new Date(start + offset * MINUTE_MS);
    if (dreamScheduleMatches(schedule, candidate)) return candidate.toISOString();
  }
  return null;
}

function scheduleKey(agentId, slot, configVersion, providerBindingVersion) {
  return `sha256:${createHash("sha256").update(`${agentId}|${slot}|${configVersion}|${providerBindingVersion}`).digest("hex")}`;
}

export function createMemoryDreamScheduler({
  configService,
  dreamService,
  clock = { now: () => new Date() },
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  catchUpMinutes = 8 * 24 * 60,
  logger = console,
} = {}) {
  if (!configService?.listAll || !dreamService?.enqueue) throw new Error("Dream scheduler requires configService.listAll and dreamService.enqueue");
  let timer = null;
  let started = false;
  let closed = false;
  let lastTickMinute = null;

  function report(error) {
    logger?.error?.("memory Dream automatic trigger failed", { code: typeof error?.code === "string" ? error.code : "internal" });
  }
  function enqueue(agentId, slot, record) {
    const providerBindingVersion = configService.getProviderSnapshot?.(agentId)?.bindingVersion
      ?? record.config.provider.providerId;
    const key = scheduleKey(agentId, slot, record.version, providerBindingVersion);
    Promise.resolve(dreamService.enqueue({ agentId, trigger: "scheduled", scheduleKey: key })).catch(report);
  }
  function latestMatchingSlot(record, fromMinute, toMinute) {
    for (let minute = toMinute; minute >= fromMinute; minute -= MINUTE_MS) {
      if (dreamScheduleMatches(record.config.dream.schedule, new Date(minute))) return new Date(minute).toISOString();
    }
    return null;
  }
  function tick({ catchUp = false } = {}) {
    const current = Math.floor(clock.now().getTime() / MINUTE_MS) * MINUTE_MS;
    const first = catchUp
      ? current - Math.max(0, catchUpMinutes - 1) * MINUTE_MS
      : lastTickMinute === null ? current : lastTickMinute + MINUTE_MS;
    for (const record of configService.listAll()) {
      if (record.config.dream.schedule.mode === "manual") continue;
      try {
        const slot = latestMatchingSlot(record, first, current);
        if (slot) enqueue(record.config.agentId, slot, record);
      } catch (error) { report(error); }
    }
    lastTickMinute = current;
  }
  function onTimer() {
    timer = null;
    if (!started || closed) return;
    tick();
    scheduleNext();
  }
  function scheduleNext() {
    if (!started || closed) return;
    const nowMs = clock.now().getTime();
    const next = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
    timer = setTimeoutFn(onTimer, Math.max(1, next - nowMs));
    timer?.unref?.();
  }
  function start() {
    if (started || closed) return;
    started = true;
    tick({ catchUp: true });
    scheduleNext();
  }
  function refresh() {
    if (!started || closed) return;
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
    lastTickMinute = Math.floor(clock.now().getTime() / MINUTE_MS) * MINUTE_MS;
    scheduleNext();
  }
  function close() {
    closed = true;
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
  }
  return { start, refresh, close, nextRunAt: (agentId) => {
    const record = configService.listAll().find((item) => item.config.agentId === agentId);
    return record ? nextDreamRunAt(record.config.dream.schedule, clock.now()) : null;
  } };
}
