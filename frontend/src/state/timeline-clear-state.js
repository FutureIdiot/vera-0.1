const STORAGE_KEY = "vera.timeline-clear-state.v1";
const MAX_ENTRIES = 128;

function entryKey(spaceId, spaceSessionId) {
  return `${spaceId}\u0000${spaceSessionId}`;
}

function itemKey(item) {
  return item?.itemType && item?.id ? `${item.itemType}:${item.id}` : null;
}

function timestamp(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function validEntry(entry) {
  return entry &&
    typeof entry.spaceId === "string" && entry.spaceId &&
    typeof entry.spaceSessionId === "string" && entry.spaceSessionId &&
    timestamp(entry.cutoffCreatedAt) !== null &&
    timestamp(entry.clearedAt) !== null &&
    Array.isArray(entry.cutoffKeys) &&
    entry.cutoffKeys.every((key) => typeof key === "string");
}

export function createTimelineClearState({
  storage = globalThis.localStorage,
  now = () => new Date(),
} = {}) {
  const entries = new Map();

  try {
    const stored = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null");
    if (stored?.schemaVersion === 1 && Array.isArray(stored.entries)) {
      for (const entry of stored.entries.filter(validEntry).slice(-MAX_ENTRIES)) {
        entries.set(entryKey(entry.spaceId, entry.spaceSessionId), structuredClone(entry));
      }
    }
  } catch {
    // Device-local UI state must never prevent Chat from mounting.
  }

  function persist() {
    try {
      const ordered = [...entries.values()]
        .sort((left, right) => timestamp(left.clearedAt) - timestamp(right.clearedAt))
        .slice(-MAX_ENTRIES);
      entries.clear();
      for (const entry of ordered) entries.set(entryKey(entry.spaceId, entry.spaceSessionId), entry);
      storage?.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, entries: ordered }));
    } catch {
      // Keep the current mount's in-memory behavior when device storage fails.
    }
  }

  function get(spaceId, spaceSessionId) {
    if (!spaceId || !spaceSessionId) return null;
    return entries.get(entryKey(spaceId, spaceSessionId)) ?? null;
  }

  function mark(spaceId, spaceSessionId, items = []) {
    if (!spaceId || !spaceSessionId) return null;
    const datedItems = items
      .map((item) => ({ item, createdAt: timestamp(item?.createdAt) }))
      .filter(({ createdAt }) => createdAt !== null);
    const current = now();
    const clearedAt = current instanceof Date ? current : new Date(current);
    const cutoff = datedItems.length > 0
      ? Math.max(...datedItems.map(({ createdAt }) => createdAt))
      : clearedAt.getTime();
    const entry = {
      spaceId,
      spaceSessionId,
      cutoffCreatedAt: new Date(cutoff).toISOString(),
      cutoffKeys: datedItems
        .filter(({ createdAt }) => createdAt === cutoff)
        .map(({ item }) => itemKey(item))
        .filter(Boolean),
      clearedAt: clearedAt.toISOString(),
    };
    entries.set(entryKey(spaceId, spaceSessionId), entry);
    persist();
    return structuredClone(entry);
  }

  function filter(spaceId, spaceSessionId, items = []) {
    const entry = get(spaceId, spaceSessionId);
    if (!entry) return [...items];
    const cutoff = timestamp(entry.cutoffCreatedAt);
    const cutoffKeys = new Set(entry.cutoffKeys);
    return items.filter((item) => {
      const createdAt = timestamp(item?.createdAt);
      if (createdAt === null || createdAt < cutoff) return false;
      if (createdAt > cutoff) return true;
      const key = itemKey(item);
      return Boolean(key) && !cutoffKeys.has(key);
    });
  }

  function restore(spaceId, spaceSessionId) {
    if (!spaceId || !spaceSessionId) return;
    if (entries.delete(entryKey(spaceId, spaceSessionId))) persist();
  }

  return { filter, get, mark, restore };
}
