import { createHash } from "node:crypto";
import { ApiError } from "../core/errors.js";
import { parseFiveFieldCron } from "../core/cron.js";

const COLLECTION = "memoryConfigs";
const PROVIDER_ID = "vera.markdown";
const MIGRATION_ID = "_migration:memory-config-v1";
const BODY_KEYS = new Set(["provider", "digest", "dream", "ifMatch"]);

function invalid(message) { return new ApiError("invalid_request", message); }
function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be an object`);
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw invalid(`${label} must contain exactly ${expected.join(", ")}`);
  }
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}
function versionFor(config) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(config))).digest("hex")}`;
}
function validTimeZone(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}
function validateClockTime(value) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) throw invalid("schedule time must be HH:mm");
  const [hour, minute] = value.split(":").map(Number);
  if (hour > 23 || minute > 59) throw invalid("schedule time must be HH:mm");
}
function validateCron(value, label) {
  try { parseFiveFieldCron(value); }
  catch { throw invalid(`${label} must be a valid five-field cron expression`); }
}
function validateExecutor(store, executorAgentId) {
  if (executorAgentId === null) return;
  if (typeof executorAgentId !== "string" || !store.find("agents", executorAgentId)) {
    throw invalid("executorAgentId must be null or an existing Agent id");
  }
}
function validateModelSelection(store, value, label) {
  validateExecutor(store, value.executorAgentId);
  if (!new Set(["inherit", "fixed"]).has(value.modelMode)) throw invalid(`${label}.modelMode must be inherit or fixed`);
  if (value.modelMode === "inherit" && value.model !== null) throw invalid(`${label}.model must be null in inherit mode`);
  if (value.modelMode === "fixed" && (typeof value.model !== "string" || !value.model.trim())) {
    throw invalid(`${label}.model must be a non-empty string in fixed mode`);
  }
}
function validateProvider(value) {
  exactKeys(value, ["providerId", "config"], "provider");
  if (value.providerId !== PROVIDER_ID) {
    throw new ApiError("memory_provider_unsupported", `Memory Provider ${value.providerId} is unsupported`);
  }
  if (!value.config || typeof value.config !== "object" || Array.isArray(value.config) || Object.keys(value.config).length) {
    throw invalid("vera.markdown provider config must be an empty object");
  }
  return { providerId: PROVIDER_ID, config: {} };
}
function validateDigest(store, value) {
  exactKeys(value, ["executorAgentId", "modelMode", "model", "trigger"], "digest");
  validateModelSelection(store, value, "digest");
  const trigger = value.trigger;
  if (trigger?.mode === "manual") exactKeys(trigger, ["mode"], "digest.trigger");
  else if (trigger?.mode === "realtime") {
    exactKeys(trigger, ["mode", "thresholdChars"], "digest.trigger");
    if (!Number.isInteger(trigger.thresholdChars) || trigger.thresholdChars < 1) throw invalid("digest.trigger.thresholdChars must be a positive integer");
  } else if (trigger?.mode === "scheduled") {
    exactKeys(trigger, ["mode", "cron", "timezone"], "digest.trigger");
    validateCron(trigger.cron, "digest.trigger.cron");
    if (!validTimeZone(trigger.timezone)) throw invalid("digest.trigger.timezone must be an IANA timezone");
  } else throw invalid("digest.trigger.mode must be manual, scheduled, or realtime");
  return structuredClone(value);
}
function validateDream(store, value) {
  exactKeys(value, ["executorAgentId", "modelMode", "model", "schedule"], "dream");
  validateModelSelection(store, value, "dream");
  const schedule = value.schedule;
  if (schedule?.mode === "manual") exactKeys(schedule, ["mode"], "dream.schedule");
  else if (schedule?.mode === "daily") {
    exactKeys(schedule, ["mode", "timezone", "time"], "dream.schedule");
    if (!validTimeZone(schedule.timezone)) throw invalid("dream.schedule.timezone must be an IANA timezone");
    validateClockTime(schedule.time);
  } else if (schedule?.mode === "weekly") {
    exactKeys(schedule, ["mode", "timezone", "weekday", "time"], "dream.schedule");
    if (!validTimeZone(schedule.timezone)) throw invalid("dream.schedule.timezone must be an IANA timezone");
    if (!Number.isInteger(schedule.weekday) || schedule.weekday < 1 || schedule.weekday > 7) throw invalid("dream.schedule.weekday must be from 1 to 7");
    validateClockTime(schedule.time);
  } else if (schedule?.mode === "custom") {
    exactKeys(schedule, ["mode", "timezone", "cron"], "dream.schedule");
    if (!validTimeZone(schedule.timezone)) throw invalid("dream.schedule.timezone must be an IANA timezone");
    validateCron(schedule.cron, "dream.schedule.cron");
  } else throw invalid("dream.schedule.mode must be manual, daily, weekly, or custom");
  return structuredClone(value);
}

function defaultTaskConfig(kind) {
  return kind === "digest"
    ? { executorAgentId: null, modelMode: "inherit", model: null, trigger: { mode: "manual" } }
    : { executorAgentId: null, modelMode: "inherit", model: null, schedule: { mode: "manual" } };
}
function legacyDigest(template, timezone) {
  if (template?.digestTrigger === "realtime") {
    return { executorAgentId: null, modelMode: "inherit", model: null,
      trigger: { mode: "realtime", thresholdChars: template.digestRealtimeThresholdChars } };
  }
  if (template?.digestTrigger === "scheduled") {
    return { executorAgentId: null, modelMode: "inherit", model: null,
      trigger: { mode: "scheduled", cron: template.digestSchedule, timezone } };
  }
  return defaultTaskConfig("digest");
}
function stripRecord(record) {
  return {
    agentId: record.agentId,
    provider: structuredClone(record.provider),
    digest: structuredClone(record.digest),
    dream: structuredClone(record.dream),
  };
}

export function createMemoryConfigService({ store, settingsStore = null, config, validateTaskSelection = null } = {}) {
  if (!store || !config?.memory) throw new Error("createMemoryConfigService requires store and config.memory");

  function requireAgent(agentId) {
    if (!store.find("agents", agentId)) throw new ApiError("not_found", `agent ${agentId} does not exist`);
  }
  function find(agentId) { return store.find(COLLECTION, agentId); }
  function create(agentId, digest = defaultTaskConfig("digest")) {
    const publicConfig = {
      agentId,
      provider: { providerId: PROVIDER_ID, config: {} },
      digest,
      dream: defaultTaskConfig("dream"),
    };
    return store.insert(COLLECTION, { id: agentId, ...publicConfig, version: versionFor(publicConfig) });
  }
  function response(record) {
    const publicConfig = stripRecord(record);
    return { config: publicConfig, version: record.version ?? versionFor(publicConfig) };
  }
  function ensureAgentConfig(agentId) {
    requireAgent(agentId);
    return response(find(agentId) ?? create(agentId));
  }
  async function initializeExistingAgents() {
    let marker = store.find(COLLECTION, MIGRATION_ID);
    if (!marker) {
      const template = settingsStore?.getLegacyMemoryDigestTemplate?.() ?? {
        digestTrigger: "scheduled",
        digestSchedule: "0 3 * * *",
        digestRealtimeThresholdChars: config.memory.digestRealtimeThresholdChars,
      };
      marker = store.insert(COLLECTION, {
        id: MIGRATION_ID,
        migration: "memory-config-v1",
        status: "prepared",
        template: structuredClone(template),
        pending: store.list("agents").map((agent) => ({
          agentId: agent.id,
          digest: legacyDigest(template, config.memory.scheduleTimezone),
        })),
      });
      await store.flush?.();
    }
    if (marker.status !== "completed") {
      for (const item of marker.pending ?? []) {
        if (store.find("agents", item.agentId) && !find(item.agentId)) create(item.agentId, item.digest);
      }
      await store.flush?.();
      await settingsStore?.clearLegacyMemoryDigestSettings?.();
      marker = store.update(COLLECTION, MIGRATION_ID, {
        status: "completed",
        completedAt: new Date().toISOString(),
        pending: [],
      });
      await store.flush?.();
    }
    // Agents introduced after the one-time template snapshot always receive
    // the new M4 manual defaults, including after a crash/restart.
    for (const agent of store.list("agents")) if (!find(agent.id)) create(agent.id);
    await store.flush?.();
  }
  async function patchConfig(agentId, body) {
    requireAgent(agentId);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Memory config patch must be an object");
    for (const key of Object.keys(body)) if (!BODY_KEYS.has(key)) throw invalid(`unknown Memory config field: ${key}`);
    if (typeof body.ifMatch !== "string" || !body.ifMatch) throw invalid("ifMatch is required");
    if (!["provider", "digest", "dream"].some((key) => Object.hasOwn(body, key))) throw invalid("Memory config patch must replace provider, digest, or dream");
    const current = find(agentId) ?? create(agentId);
    if (current.version !== body.ifMatch) throw new ApiError("conflict", "Memory config was modified");
    const next = stripRecord(current);
    if (body.provider !== undefined) next.provider = validateProvider(body.provider);
    if (body.digest !== undefined) next.digest = validateDigest(store, body.digest);
    if (body.dream !== undefined) next.dream = validateDream(store, body.dream);
    if (typeof validateTaskSelection === "function") {
      if (body.digest !== undefined) await validateTaskSelection({ ownerAgentId: agentId, taskKind: "digest", taskConfig: next.digest });
      if (body.dream !== undefined) await validateTaskSelection({ ownerAgentId: agentId, taskKind: "dream", taskConfig: next.dream });
    }
    const version = versionFor(next);
    const updated = store.update(COLLECTION, agentId, { ...next, version });
    return response(updated);
  }
  function getConfig(agentId) { return ensureAgentConfig(agentId); }
  function getProviderSnapshot(agentId) {
    const { config: current } = ensureAgentConfig(agentId);
    const providerVersion = versionFor(current.provider);
    return {
      providerId: current.provider.providerId,
      bindingVersion: providerVersion,
      configVersion: versionFor(current.provider.config),
    };
  }
  function listAll() {
    return store.list("agents").map((agent) => ensureAgentConfig(agent.id));
  }

  return { initializeExistingAgents, ensureAgentConfig, getConfig, getProviderSnapshot, listAll, patchConfig };
}
