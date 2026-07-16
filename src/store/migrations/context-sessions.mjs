// P5-C1 one-time migration: replace the legacy Account+Space opaque
// sessionStates map with Vera-owned SpaceSession / AgentSession records.
// The migration is deliberately idempotent because split collection files are
// flushed before meta.json; a crash in that window must be safe to replay.

import { copyFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import {
  newAgentSessionId,
  newApiHistoryId,
  newProviderBindingId,
  newSpaceSessionId,
} from "../../core/id.js";
import { providerFingerprintForAccount } from "../../spaces/context-state.js";

const MIGRATION_VERSION = 1;

function nextSeq(data) {
  data._seq = (data._seq ?? 0) + 1;
  return data._seq;
}

function pushRecord(data, collection, record) {
  const stored = { ...record, _seq: nextSeq(data) };
  data[collection].push(stored);
  return stored;
}

function activeSessionForSpace(data, space) {
  const pointed = space.activeSpaceSessionId
    ? data.spaceSessions.find((item) => item.id === space.activeSpaceSessionId && item.spaceId === space.id)
    : null;
  if (pointed) return pointed;
  return data.spaceSessions.find((item) => item.spaceId === space.id && item.status === "active") ?? null;
}

function ensureSpaceSession(data, space, now) {
  let session = activeSessionForSpace(data, space);
  if (!session) {
    session = pushRecord(data, "spaceSessions", {
      id: typeof space.activeSpaceSessionId === "string" && space.activeSpaceSessionId
        ? space.activeSpaceSessionId
        : newSpaceSessionId(),
      spaceId: space.id,
      status: "active",
      createdAt: space.createdAt ?? now,
      archivedAt: null,
      archiveReason: null,
    });
  }
  session.status = "active";
  session.archivedAt = null;
  session.archiveReason = null;
  space.activeSpaceSessionId = session.id;
  for (const other of data.spaceSessions) {
    if (other.spaceId !== space.id || other.id === session.id || other.status !== "active") continue;
    other.status = "archived";
    other.archivedAt ??= now;
    other.archiveReason ??= "new_command";
  }
  return session;
}

function ensureAgentSession(data, { spaceSessionId, agentId, now }) {
  let session = data.agentSessions.find((item) =>
    item.spaceSessionId === spaceSessionId && item.agentId === agentId);
  if (session) return session;
  session = pushRecord(data, "agentSessions", {
    id: newAgentSessionId(),
    spaceSessionId,
    agentId,
    status: "active",
    generation: 1,
    context: {
      checkpointVersion: 0,
      estimatedInputTokens: 0,
      effectiveLimitTokens: 0,
      pressureRatio: 0,
      measurement: "estimate",
    },
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
  });
  return session;
}

function splitLegacySessionKey(key) {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) return null;
  return { accountId: key.slice(0, separator), spaceId: key.slice(separator + 1) };
}

function minimalInput(message) {
  return {
    sourceMessageId: message.id,
    author: structuredClone(message.author ?? null),
    target: structuredClone(message.target ?? null),
    content: message.content ?? "",
    createdAt: message.createdAt ?? null,
  };
}

function rebuildApiHistories(data, agentSessionByKey, now) {
  const messages = new Map(data.messages.map((message) => [message.id, message]));
  const turnsByAgentSession = new Map();
  const orderedRuns = [...data.runs].sort((a, b) => (a._seq ?? 0) - (b._seq ?? 0));
  for (const run of orderedRuns) {
    if (run.status !== "completed" || !run.agentId || !run.triggerMessageId) continue;
    const account = run.accountId ? data.accounts.find((item) => item.id === run.accountId) : null;
    if (account?.kind !== "api") continue;
    const agentSession = agentSessionByKey.get(`${run.spaceSessionId}:${run.agentId}`);
    const trigger = messages.get(run.triggerMessageId);
    const replies = (run.replyMessageIds ?? []).map((id) => messages.get(id));
    if (!agentSession || !trigger || trigger.status !== "completed" || replies.length === 0 || replies.some((item) =>
      !item || item.runId !== run.id || item.status !== "completed" ||
      item.author?.type !== "agent" || item.author.agentId !== run.agentId)) continue;
    const turns = turnsByAgentSession.get(agentSession.id) ?? [];
    turns.push({
      runId: run.id,
      input: minimalInput(trigger),
      assistant: replies.map((item) => ({
        messageId: item.id,
        content: item.content ?? "",
        createdAt: item.createdAt ?? null,
      })),
    });
    turnsByAgentSession.set(agentSession.id, turns);
  }
  for (const [agentSessionId, turns] of turnsByAgentSession) {
    if (data.apiHistories.some((item) => item.agentSessionId === agentSessionId && item.generation === 1)) continue;
    pushRecord(data, "apiHistories", {
      id: newApiHistoryId(),
      agentSessionId,
      generation: 1,
      version: turns.length,
      checkpoint: null,
      turns,
      createdAt: now,
      updatedAt: now,
    });
  }
}

export function needsContextSessionsMigration({ data }) {
  if ((data.contextSessionsMigrationVersion ?? 0) < MIGRATION_VERSION) return true;
  if (data.sessionStates && Object.keys(data.sessionStates).length > 0) return true;
  if (data.spaces.some((space) => !space.activeSpaceSessionId)) return true;
  const knownSpaceIds = new Set(data.spaces.map((space) => space.id));
  if (["messages", "runs", "activities", "approvals"].some((collection) =>
    data[collection].some((record) => knownSpaceIds.has(record.spaceId) && !record.spaceSessionId))) return true;
  return data.runs.some((run) => knownSpaceIds.has(run.spaceId) &&
    (!run.role || run.parentRunId === undefined || !run.accountId ||
      (run.role !== "subagent" && (!run.agentSessionId || !Number.isInteger(run.contextGeneration)))));
}

export async function migrateContextSessions({ data, markDirty, now = new Date().toISOString() }) {
  for (const name of [
    "spaceSessions", "agentSessions", "providerBindings", "apiHistories",
    "contextCompactionJobs", "contextControlRequests",
  ]) data[name] ??= [];
  data.sessionStates ??= {};

  const activeBySpace = new Map();
  const agentSessionByKey = new Map();
  for (const space of data.spaces) {
    const spaceSession = ensureSpaceSession(data, space, now);
    activeBySpace.set(space.id, spaceSession);
    for (const seat of space.seats ?? []) {
      const agentSession = ensureAgentSession(data, { spaceSessionId: spaceSession.id, agentId: seat.agentId, now });
      agentSessionByKey.set(`${spaceSession.id}:${seat.agentId}`, agentSession);
    }
  }

  for (const collection of ["messages", "runs", "activities", "approvals"]) {
    for (const record of data[collection]) {
      if (!record.spaceSessionId && activeBySpace.has(record.spaceId)) {
        record.spaceSessionId = activeBySpace.get(record.spaceId).id;
      }
    }
  }

  for (const run of data.runs) {
    run.role ??= "main";
    run.parentRunId ??= null;
    if (run.accountId === undefined) {
      const owned = data.accounts.filter((account) => account.owningAgentId === run.agentId);
      if (owned.length !== 1) {
        throw new Error(`P5-C1 migration cannot uniquely resolve Home Account for Run ${run.id}`);
      }
      run.accountId = owned[0].id;
    }
    if (run.role === "subagent") {
      run.agentSessionId = null;
      run.contextGeneration = null;
      continue;
    }
    const spaceSession = activeBySpace.get(run.spaceId);
    if (!spaceSession) continue;
    const agentSession = ensureAgentSession(data, {
      spaceSessionId: spaceSession.id,
      agentId: run.agentId,
      now,
    });
    agentSessionByKey.set(`${spaceSession.id}:${run.agentId}`, agentSession);
    run.agentSessionId ??= agentSession.id;
    run.contextGeneration ??= 1;
  }

  for (const [key, providerState] of Object.entries(data.sessionStates)) {
    const parsed = splitLegacySessionKey(key);
    if (!parsed || providerState == null) continue;
    const account = data.accounts.find((item) => item.id === parsed.accountId);
    const space = data.spaces.find((item) => item.id === parsed.spaceId);
    if (!account || account.kind !== "cli" || !space) continue;
    const ownerAccounts = data.accounts.filter((item) => item.owningAgentId === account.owningAgentId);
    const matchingSeats = (space.seats ?? []).filter((seat) => seat.agentId === account.owningAgentId);
    if (ownerAccounts.length !== 1 || matchingSeats.length !== 1) continue;
    const spaceSession = activeBySpace.get(space.id);
    const agentSession = ensureAgentSession(data, {
      spaceSessionId: spaceSession.id,
      agentId: account.owningAgentId,
      now,
    });
    agentSessionByKey.set(`${spaceSession.id}:${account.owningAgentId}`, agentSession);
    if (data.providerBindings.some((item) => item.agentSessionId === agentSession.id && item.generation === 1)) continue;
    pushRecord(data, "providerBindings", {
      id: newProviderBindingId(),
      agentSessionId: agentSession.id,
      generation: 1,
      accountId: account.id,
      providerFingerprint: providerFingerprintForAccount(account),
      providerState: structuredClone(providerState),
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  rebuildApiHistories(data, agentSessionByKey, now);
  data.sessionStates = {};
  data.contextSessionsMigrationVersion = MIGRATION_VERSION;
  markDirty([
    "spaces", "messages", "runs", "activities", "approvals", "spaceSessions", "agentSessions",
    "providerBindings", "apiHistories", "contextCompactionJobs", "contextControlRequests", "meta",
  ]);
}

export async function retireLegacySessionStatesFile(path) {
  try {
    await copyFile(path, `${path}.legacy`, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== "EEXIST" && error.code !== "ENOENT") throw error;
  }
  try {
    await unlink(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
