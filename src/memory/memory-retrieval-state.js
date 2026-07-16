// Persistent M3 recall sidecar. It deliberately stores only identity bindings,
// delivered slugs, frozen safe projections/cursors, and non-semantic signals.

import { randomUUID } from "node:crypto";
import { ApiError } from "../core/errors.js";

const SESSION_COLLECTION = "memoryRecallSessions";
const SIGNAL_COLLECTION = "memorySignals";
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SNAPSHOTS = 16;
const USAGE_KINDS = new Set(["auto_injected", "search_returned", "fetch_more_returned", "detail_opened"]);

const opaque = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const stripInternal = ({ _seq, ...value }) => value;
const sessionKey = ({ agentSessionId }) => agentSessionId;
function invalid(message) { return new ApiError("invalid_request", message); }

function requireIdentity(value) {
  for (const key of ["agentId", "agentSessionId"]) {
    if (typeof value?.[key] !== "string" || !value[key]) throw invalid(`${key} is required`);
  }
  if (!Number.isInteger(value.generation) || value.generation < 1) throw invalid("generation must be a positive integer");
}

export function createMemoryRetrievalState({ store, now }) {
  for (const session of [...store.list(SESSION_COLLECTION)]) {
    if (typeof session.agentSessionId !== "string" || !session.agentSessionId ||
        !Number.isInteger(session.generation) || session.generation < 1 ||
        ["accountId", "spaceId", "memorySessionId"].some((key) => Object.hasOwn(session, key))) {
      store.remove(SESSION_COLLECTION, session.id);
    }
  }
  for (const signal of [...store.list(SIGNAL_COLLECTION)]) {
    if (USAGE_KINDS.has(signal.kind) && (
      typeof signal.agentSessionId !== "string" || !signal.agentSessionId ||
      !Number.isInteger(signal.generation) || signal.generation < 1 ||
      ["accountId", "spaceId", "memorySessionId"].some((key) => Object.hasOwn(signal, key))
    )) store.remove(SIGNAL_COLLECTION, signal.id);
  }
  const tails = new Map();
  function withLock(key, task) {
    const prior = tails.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(task);
    tails.set(key, next);
    const cleanup = () => { if (tails.get(key) === next) tails.delete(key); };
    void next.then(cleanup, cleanup);
    return next;
  }
  function findSession(context) {
    requireIdentity(context);
    const session = currentSession(context);
    if (!session || session.status !== "active") {
      throw new ApiError("memory_cursor_invalid", "Memory recall session is invalid");
    }
    return session;
  }
  function currentSession(identity) {
    return [...store.list(SESSION_COLLECTION)].reverse().find((item) =>
      item.agentId === identity.agentId && item.agentSessionId === identity.agentSessionId &&
      item.generation === identity.generation) ?? null;
  }
  async function ensureSession(identity) {
    requireIdentity(identity);
    return withLock(sessionKey(identity), async () => {
      const existing = currentSession(identity);
      if (existing?.status === "active") return stripInternal(existing);
      if (existing) throw new ApiError("memory_cursor_invalid", "Memory recall generation is frozen");
      const siblings = store.list(SESSION_COLLECTION).filter((item) =>
        item.agentId === identity.agentId && item.agentSessionId === identity.agentSessionId);
      const latestGeneration = Math.max(0, ...siblings.map((item) => item.generation));
      if (latestGeneration > identity.generation) {
        throw new ApiError("memory_cursor_invalid", "Memory recall generation is stale");
      }
      const createdAt = now();
      for (const prior of siblings) {
        if (prior.status === "active") {
          store.update(SESSION_COLLECTION, prior.id, { status: "frozen", frozenAt: createdAt, updatedAt: createdAt });
        }
      }
      return stripInternal(store.insert(SESSION_COLLECTION, {
        id: opaque("mrs"), agentId: identity.agentId, agentSessionId: identity.agentSessionId,
        generation: identity.generation, status: "active", deliveredSlugs: [], cursors: [], createdAt, updatedAt: createdAt,
      }));
    });
  }
  async function resetSession(identity) {
    requireIdentity(identity);
    await withLock(sessionKey(identity), async () => {
      const session = currentSession(identity);
      if (session?.status === "active") {
        const timestamp = now();
        store.update(SESSION_COLLECTION, session.id, { status: "frozen", frozenAt: timestamp, updatedAt: timestamp });
      }
    });
  }
  function saveCursor(session, data) {
    const timestamp = now();
    const cursor = {
      id: opaque("mrc"), createdAt: timestamp,
      expiresAt: new Date(Date.parse(timestamp) + CURSOR_TTL_MS).toISOString(), ...data,
    };
    const current = store.find(SESSION_COLLECTION, session.id) ?? session;
    const appended = [...(current.cursors ?? []), cursor];
    const retained = [...new Set(appended.map((item) => item.retrievalId))].slice(-MAX_SNAPSHOTS);
    const cursors = appended.filter((item) => retained.includes(item.retrievalId));
    store.update(SESSION_COLLECTION, session.id, { cursors, updatedAt: now() });
    return cursor.id;
  }
  function cacheCursor(session, cursorId, cached) {
    const latest = store.find(SESSION_COLLECTION, session.id);
    const cursors = latest.cursors.map((item) => item.id === cursorId ? { ...item, cached } : item);
    store.update(SESSION_COLLECTION, session.id, { cursors, updatedAt: now() });
  }
  function selectCursor(session, cursorId, direction, selectedBudget) {
    const latest = store.find(SESSION_COLLECTION, session.id);
    let selected = null;
    const cursors = latest.cursors.map((item) => {
      if (item.id !== cursorId) return item;
      selected = { ...item, direction, selectedBudget };
      return selected;
    });
    store.update(SESSION_COLLECTION, session.id, { cursors, updatedAt: now() });
    return selected;
  }
  function addUsage(context, retrievalId, nodes, kind) {
    const session = findSession(context);
    const seen = new Set(store.list(SIGNAL_COLLECTION).filter((item) =>
      item.kind === kind && item.agentId === session.agentId && item.agentSessionId === session.agentSessionId &&
      item.generation === session.generation && item.retrievalId === retrievalId).map((item) => item.slug));
    for (const node of nodes) if (!seen.has(node.slug)) store.insert(SIGNAL_COLLECTION, {
      id: opaque("mus"), agentId: session.agentId, agentSessionId: session.agentSessionId, generation: session.generation,
      ...(context.runId ? { runId: context.runId } : {}), ...(retrievalId ? { retrievalId } : {}),
      slug: node.slug, kind, createdAt: now(),
    });
  }
  function addDelivered(session, slugs) {
    return store.update(SESSION_COLLECTION, session.id, {
      deliveredSlugs: [...new Set([...(session.deliveredSlugs ?? []), ...slugs])], updatedAt: now(),
    });
  }
  function hasUsage(context, slug, kind) {
    const session = findSession(context);
    return store.list(SIGNAL_COLLECTION).some((item) =>
      item.kind === kind && item.agentId === session.agentId && item.agentSessionId === session.agentSessionId &&
      item.generation === session.generation && item.slug === slug);
  }
  function getPin(agentId, slug) {
    const signal = store.find(SIGNAL_COLLECTION, `pin:${agentId}:${slug}`);
    return signal ? stripInternal(signal) : { slug, pinned: false };
  }
  function setPinned(agentId, slug, pinned) {
    const id = `pin:${agentId}:${slug}`;
    const existing = store.find(SIGNAL_COLLECTION, id);
    const value = { id, agentId, slug, pinned, pinnedAt: pinned ? now() : null, updatedAt: now() };
    return stripInternal(existing ? store.update(SIGNAL_COLLECTION, id, value) : store.insert(SIGNAL_COLLECTION, value));
  }
  function recordUserEdit(agentId, slug) {
    const id = `edit:${agentId}:${slug}`;
    const existing = store.find(SIGNAL_COLLECTION, id);
    const value = { id, agentId, slug, kind: "user_edited", createdAt: now() };
    return stripInternal(existing ? store.update(SIGNAL_COLLECTION, id, value) : store.insert(SIGNAL_COLLECTION, value));
  }
  return {
    ensureSession, resetSession, findSession, saveCursor, cacheCursor, selectCursor,
    addUsage, addDelivered, hasUsage, getPin, setPinned, recordUserEdit,
    withCursorLock: (cursorId, task) => withLock(`cursor:${cursorId}`, task),
    withSessionLock: (sessionId, task) => withLock(`session:${sessionId}`, task),
    listSignals: () => store.list(SIGNAL_COLLECTION).map(stripInternal),
  };
}
