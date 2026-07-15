// Rebuildable M4 long-term Memory weight. Every input comes from the active
// Memory authority or the non-semantic memorySignals sidecar.

import { extractMemoryLinks } from "./memory-retrieval-text.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHANNEL_WEIGHTS = Object.freeze({
  inboundLinks: 0.25,
  usage: 0.30,
  userEdit: 0.15,
  pin: 0.20,
  typeDecay: 0.10,
});
const USAGE_VALUES = Object.freeze({
  detail_opened: 4,
  auto_injected: 1,
  search_returned: 1,
  fetch_more_returned: 1,
});
const TYPE_HALF_LIFE_DAYS = Object.freeze({
  project_rule: 3650,
  preference: 1825,
  correction: 1095,
  architecture: 730,
  decision: 730,
  workflow: 365,
  bug: 180,
  open_question: 90,
});
const DEFAULT_TYPE_HALF_LIFE_DAYS = 365;
const USAGE_HALF_LIFE_DAYS = 30;
const USER_EDIT_HALF_LIFE_DAYS = 180;

const clamp01 = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
const round6 = (value) => Math.round(clamp01(value) * 1e6) / 1e6;

function timestamp(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function decay(value, nowMs, halfLifeDays) {
  const then = timestamp(value);
  if (then === null) return 0;
  const ageDays = Math.max(0, nowMs - then) / DAY_MS;
  return clamp01(0.5 ** (ageDays / halfLifeDays));
}

function normalizeByMaximum(values) {
  const maximum = Math.max(0, ...values.values());
  return new Map([...values].map(([slug, value]) => [slug, maximum ? clamp01(value / maximum) : 0]));
}

function signalMatchesAgent(signal, agentId) {
  return !agentId || signal?.agentId === agentId;
}

export function calculateMemoryDerivedWeights({ memories, signals = [], agentId = null, now = new Date().toISOString() } = {}) {
  if (!Array.isArray(memories)) throw new TypeError("memories must be an array");
  if (!Array.isArray(signals)) throw new TypeError("signals must be an array");
  const nowMs = timestamp(now);
  if (nowMs === null) throw new TypeError("now must be an ISO8601 timestamp");

  const active = memories.filter((memory) => memory && typeof memory.slug === "string" &&
    (memory.status ?? "active") === "active").sort((a, b) => a.slug.localeCompare(b.slug));
  const slugs = new Set(active.map((memory) => memory.slug));
  const inboundRaw = new Map(active.map((memory) => [memory.slug, 0]));
  for (const memory of active) {
    for (const linkedSlug of new Set(extractMemoryLinks(memory))) {
      if (linkedSlug !== memory.slug && slugs.has(linkedSlug)) {
        inboundRaw.set(linkedSlug, inboundRaw.get(linkedSlug) + 1);
      }
    }
  }
  const inbound = normalizeByMaximum(inboundRaw);

  const usageRaw = new Map(active.map((memory) => [memory.slug, 0]));
  const latestUsage = new Map();
  const latestEdit = new Map();
  const pins = new Set();
  for (const signal of signals) {
    if (!signalMatchesAgent(signal, agentId) || !slugs.has(signal?.slug)) continue;
    const usageValue = USAGE_VALUES[signal.kind];
    if (usageValue) {
      usageRaw.set(signal.slug, usageRaw.get(signal.slug) + usageValue);
      const current = latestUsage.get(signal.slug);
      if (!current || String(signal.createdAt) > String(current)) latestUsage.set(signal.slug, signal.createdAt);
    } else if (signal.kind === "user_edited") {
      const current = latestEdit.get(signal.slug);
      if (!current || String(signal.createdAt) > String(current)) latestEdit.set(signal.slug, signal.createdAt);
    }
    if ((signal.id === `pin:${signal.agentId}:${signal.slug}` || signal.kind === "pinned") && signal.pinned === true) {
      pins.add(signal.slug);
    }
  }
  const usageLog = new Map([...usageRaw].map(([slug, value]) => [slug, Math.log1p(value)]));
  const usageCount = normalizeByMaximum(usageLog);

  return new Map(active.map((memory) => {
    const type = String(memory.type ?? "unknown").toLowerCase().replaceAll("-", "_");
    const typeHalfLife = TYPE_HALF_LIFE_DAYS[type] ?? DEFAULT_TYPE_HALF_LIFE_DAYS;
    const components = {
      inboundLinks: inbound.get(memory.slug) ?? 0,
      usage: 0.7 * (usageCount.get(memory.slug) ?? 0) +
        0.3 * decay(latestUsage.get(memory.slug), nowMs, USAGE_HALF_LIFE_DAYS),
      userEdit: decay(latestEdit.get(memory.slug), nowMs, USER_EDIT_HALF_LIFE_DAYS),
      pin: pins.has(memory.slug) ? 1 : 0,
      typeDecay: decay(memory.createdAt, nowMs, typeHalfLife),
    };
    const weight = Object.entries(CHANNEL_WEIGHTS).reduce((sum, [key, factor]) => sum + components[key] * factor, 0);
    return [memory.slug, round6(weight)];
  }));
}
