// Persistent M3 recall sidecar. It deliberately stores only identity bindings,
// delivered slugs, frozen safe projections/cursors, and non-semantic signals.

import { randomUUID } from "node:crypto";
import { ApiError } from "../core/errors.js";

const SESSION_COLLECTION = "memoryRecallSessions";
const SIGNAL_COLLECTION = "memorySignals";
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SNAPSHOTS = 16;

const opaque = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const stripInternal = ({ _seq, ...value }) => value;
const sessionKey = ({ agentId, accountId, spaceId }) => `${agentId}:${accountId}:${spaceId}`;
function invalid(message) { return new ApiError("invalid_request", message); }

function requireIdentity(value) {
  for (const key of ["agentId", "accountId", "spaceId"]) {
    if (typeof value?.[key] !== "string" || !value[key]) throw invalid(`${key} is required`);
  }
}

export function createMemoryRetrievalState({ store, now }) {
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
    if (typeof context?.agentId !== "string" || !context.agentId ||
        typeof context?.memorySessionId !== "string" || !context.memorySessionId) {
      throw invalid("trusted retrieval context requires agentId and memorySessionId");
    }
    const session = store.find(SESSION_COLLECTION, context.memorySessionId);
    if (!session || session.agentId !== context.agentId) {
      throw new ApiError("memory_cursor_invalid", "Memory recall session is invalid");
    }
    return session;
  }
  function currentSession(identity) {
    return [...store.list(SESSION_COLLECTION)].reverse().find((item) =>
      item.agentId === identity.agentId && item.accountId === identity.accountId && item.spaceId === identity.spaceId) ?? null;
  }
  async function ensureSession(identity) {
    requireIdentity(identity);
    return withLock(sessionKey(identity), async () => {
      if (identity.reset) removeIdentity(identity);
      const existing = currentSession(identity);
      if (existing) return stripInternal(existing);
      const createdAt = now();
      return stripInternal(store.insert(SESSION_COLLECTION, {
        id: opaque("mrs"), agentId: identity.agentId, accountId: identity.accountId,
        spaceId: identity.spaceId, deliveredSlugs: [], cursors: [], createdAt, updatedAt: createdAt,
      }));
    });
  }
  function removeIdentity(identity) {
    for (const item of [...store.list(SESSION_COLLECTION)]) {
      if (item.agentId === identity.agentId && item.accountId === identity.accountId && item.spaceId === identity.spaceId) {
        store.remove(SESSION_COLLECTION, item.id);
      }
    }
  }
  async function resetSession(identity) {
    requireIdentity(identity);
    await withLock(sessionKey(identity), async () => removeIdentity(identity));
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
      item.kind === kind && item.memorySessionId === session.id && item.retrievalId === retrievalId).map((item) => item.slug));
    for (const node of nodes) if (!seen.has(node.slug)) store.insert(SIGNAL_COLLECTION, {
      id: opaque("mus"), agentId: context.agentId, memorySessionId: session.id,
      ...(context.runId ? { runId: context.runId } : {}), ...(retrievalId ? { retrievalId } : {}),
      slug: node.slug, kind, createdAt: now(),
    });
  }
  function addDelivered(session, slugs) {
    return store.update(SESSION_COLLECTION, session.id, {
      deliveredSlugs: [...new Set([...(session.deliveredSlugs ?? []), ...slugs])], updatedAt: now(),
    });
  }
  function hasUsage(memorySessionId, slug, kind) {
    return store.list(SIGNAL_COLLECTION).some((item) =>
      item.kind === kind && item.memorySessionId === memorySessionId && item.slug === slug);
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
