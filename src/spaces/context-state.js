import { createHash } from "node:crypto";
import { newApiHistoryId, newProviderBindingId } from "../core/id.js";
import { ApiError } from "../core/errors.js";

const MEASUREMENTS = new Set(["provider_reported", "tokenizer", "estimate"]);
const nowIso = (now) => typeof now === "function" ? now() : now ?? new Date().toISOString();
const invalid = (message) => new ApiError("invalid_request", message);
const conflict = (message) => new ApiError("conflict", message);
function stripInternal({ _seq, ...record }) { return structuredClone(record); }
function publicSession({ _seq, checkpoints, ...record }) { return structuredClone(record); }
function findSession(store, id) {
  const session = store.find("agentSessions", id);
  if (!session) throw new ApiError("not_found", `agent session ${id} does not exist`);
  return session;
}
function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw invalid(`${name} must be a non-empty string`);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function providerFingerprintForRuntime(runtime) {
  const route = {
    kind: runtime?.kind ?? null,
    provider: runtime?.provider ?? null,
    model: runtime?.model ?? "",
    connection: runtime?.connection ?? {},
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(route))).digest("hex")}`;
}

export function getProviderBinding(store, { agentSessionId, generation, accountId } = {}) {
  const matches = store.list("providerBindings").filter((item) =>
    item.agentSessionId === agentSessionId && item.generation === generation &&
    (accountId === undefined || item.accountId === accountId));
  if (matches.length > 1) throw conflict(`agent session ${agentSessionId} generation ${generation} has multiple bindings`);
  return matches[0] ? stripInternal(matches[0]) : null;
}

export function compareAndSetProviderBinding(store, input = {}, { now } = {}) {
  const session = findSession(store, input.agentSessionId);
  if (!Number.isInteger(input.generation) || input.generation < 1) throw invalid("generation must be a positive integer");
  if (session.status !== "active" || session.generation !== input.generation) throw conflict("provider binding generation is stale");
  requireString(input.accountId, "accountId");
  requireString(input.providerFingerprint, "providerFingerprint");
  if (!input.providerState || typeof input.providerState !== "object" || Array.isArray(input.providerState)) {
    throw invalid("providerState must be an object");
  }
  if (input.ifVersion != null && (!Number.isInteger(input.ifVersion) || input.ifVersion < 0)) {
    throw invalid("ifVersion must be null or a non-negative integer");
  }
  const current = getProviderBinding(store, input);
  const expected = input.ifVersion ?? 0;
  const same = current && current.accountId === input.accountId &&
    current.providerFingerprint === input.providerFingerprint &&
    JSON.stringify(current.providerState) === JSON.stringify(input.providerState);
  if (current && current.version === expected + 1 && same) return current;
  if ((current?.version ?? 0) !== expected) throw conflict("provider binding version is stale");
  const timestamp = nowIso(now);
  if (!current) return stripInternal(store.insert("providerBindings", {
    id: newProviderBindingId(),
    agentSessionId: input.agentSessionId,
    generation: input.generation,
    accountId: input.accountId,
    providerFingerprint: input.providerFingerprint,
    providerState: structuredClone(input.providerState),
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  return stripInternal(store.update("providerBindings", current.id, {
    providerFingerprint: input.providerFingerprint,
    providerState: structuredClone(input.providerState),
    version: current.version + 1,
    updatedAt: timestamp,
  }));
}

export function getApiHistory(store, { agentSessionId, generation } = {}) {
  const matches = store.list("apiHistories").filter((item) =>
    item.agentSessionId === agentSessionId && item.generation === generation);
  if (matches.length > 1) throw conflict(`agent session ${agentSessionId} generation ${generation} has multiple histories`);
  return matches[0] ? stripInternal(matches[0]) : null;
}

function validateTurn(turn) {
  if (!turn || typeof turn !== "object" || Array.isArray(turn) ||
      !turn.input || typeof turn.input !== "object" || Array.isArray(turn.input)) throw invalid("turn.input is required");
  requireString(turn.input.sourceMessageId, "turn.input.sourceMessageId");
  if (!Array.isArray(turn.assistant) || turn.assistant.length === 0) throw invalid("turn.assistant must be a non-empty array");
  for (const message of turn.assistant) {
    requireString(message?.messageId, "turn.assistant.messageId");
    if (typeof message.content !== "string") throw invalid("turn.assistant.content must be a string");
  }
}

export function compareAndSetApiHistory(store, input = {}, { now } = {}) {
  const session = findSession(store, input.agentSessionId);
  if (!Number.isInteger(input.generation) || input.generation < 1) throw invalid("generation must be a positive integer");
  if (!Number.isInteger(input.baseHistoryVersion) || input.baseHistoryVersion < 0) {
    throw invalid("baseHistoryVersion must be a non-negative integer");
  }
  validateTurn(input.turn);
  if (session.status !== "active" || session.generation !== input.generation) {
    throw new ApiError("history_conflict", "API history generation is stale");
  }
  const current = getApiHistory(store, input);
  if (current?.version === input.baseHistoryVersion + 1 &&
      JSON.stringify(current.turns.at(-1)) === JSON.stringify(input.turn)) return current;
  if ((current?.version ?? 0) !== input.baseHistoryVersion) {
    throw new ApiError("history_conflict", "API history version is stale");
  }
  const timestamp = nowIso(now);
  if (!current) return stripInternal(store.insert("apiHistories", {
    id: newApiHistoryId(),
    agentSessionId: input.agentSessionId,
    generation: input.generation,
    version: 1,
    checkpoint: null,
    turns: [structuredClone(input.turn)],
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  return stripInternal(store.update("apiHistories", current.id, {
    version: current.version + 1,
    turns: [...current.turns, structuredClone(input.turn)],
    updatedAt: timestamp,
  }));
}

export function assessContextPressure(agentSession, { warningRatio, autoRatio, hardRatio } = {}) {
  if (!(warningRatio > 0 && warningRatio < autoRatio && autoRatio < hardRatio && hardRatio < 1)) {
    throw invalid("context pressure thresholds must be strictly increasing ratios between 0 and 1");
  }
  const ratio = Number(agentSession?.context?.pressureRatio ?? 0);
  const level = ratio >= hardRatio ? "hard" : ratio >= autoRatio ? "auto" : ratio >= warningRatio ? "warning" : "normal";
  return { ratio, level, shouldCompact: level === "auto" || level === "hard", mustCompact: level === "hard" };
}

export function updateContextPressure(store, input = {}, { now } = {}) {
  const session = findSession(store, input.agentSessionId);
  if (session.status !== "active" || session.generation !== input.generation) throw conflict("context generation is stale");
  if (!Number.isFinite(input.estimatedInputTokens) || input.estimatedInputTokens < 0) {
    throw invalid("estimatedInputTokens must be a non-negative number");
  }
  if (!Number.isFinite(input.effectiveLimitTokens) || input.effectiveLimitTokens <= 0) {
    throw invalid("effectiveLimitTokens must be a positive number");
  }
  if (!MEASUREMENTS.has(input.measurement)) throw invalid("measurement is invalid");
  return publicSession(store.update("agentSessions", session.id, {
    context: {
      ...session.context,
      estimatedInputTokens: input.estimatedInputTokens,
      effectiveLimitTokens: input.effectiveLimitTokens,
      pressureRatio: input.estimatedInputTokens / input.effectiveLimitTokens,
      measurement: input.measurement,
    },
    updatedAt: nowIso(now),
  }));
}

export function rotateContextGeneration(store, input = {}, { now } = {}) {
  const session = findSession(store, input.agentSessionId);
  if (!Number.isInteger(input.fromGeneration) || input.fromGeneration < 1) throw invalid("fromGeneration must be a positive integer");
  if (session.status !== "active" || session.generation !== input.fromGeneration) throw conflict("context generation is stale");
  if (input.recentTurns !== undefined && !Array.isArray(input.recentTurns)) throw invalid("recentTurns must be an array");
  if (input.providerBinding) {
    requireString(input.providerBinding.accountId, "providerBinding.accountId");
    requireString(input.providerBinding.providerFingerprint, "providerBinding.providerFingerprint");
    if (!input.providerBinding.providerState || typeof input.providerBinding.providerState !== "object" ||
        Array.isArray(input.providerBinding.providerState)) {
      throw invalid("providerBinding.providerState must be an object");
    }
  }
  const timestamp = nowIso(now);
  const nextGeneration = input.fromGeneration + 1;
  const checkpointVersion = (session.context?.checkpointVersion ?? 0) + (input.checkpoint === undefined ? 0 : 1);
  const checkpoints = [...(session.checkpoints ?? [])];
  if (input.checkpoint !== undefined) checkpoints.push({
    fromGeneration: input.fromGeneration,
    toGeneration: nextGeneration,
    version: checkpointVersion,
    checkpoint: structuredClone(input.checkpoint),
    createdAt: timestamp,
  });
  const updated = store.update("agentSessions", session.id, {
    generation: nextGeneration,
    context: {
      ...session.context,
      checkpointVersion,
      estimatedInputTokens: 0,
      pressureRatio: 0,
      measurement: "estimate",
    },
    checkpoints,
    updatedAt: timestamp,
  });
  for (const recall of store.list("memoryRecallSessions").filter((item) =>
    item.agentSessionId === session.id && item.generation === input.fromGeneration && item.status === "active")) {
    store.update("memoryRecallSessions", recall.id, {
      status: "frozen", frozenAt: timestamp, updatedAt: timestamp,
    });
  }
  if (input.createApiHistory === true) store.insert("apiHistories", {
    id: newApiHistoryId(),
    agentSessionId: session.id,
    generation: nextGeneration,
    version: 0,
    checkpoint: structuredClone(input.checkpoint ?? null),
    turns: structuredClone(input.recentTurns ?? []),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  if (input.providerBinding) compareAndSetProviderBinding(store, {
    agentSessionId: session.id,
    generation: nextGeneration,
    accountId: input.providerBinding.accountId,
    providerFingerprint: input.providerBinding.providerFingerprint,
    providerState: input.providerBinding.providerState,
    ifVersion: null,
  }, { now: timestamp });
  return publicSession(updated);
}
