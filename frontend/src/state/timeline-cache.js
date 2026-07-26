export function timelineItemsMatch(orderedItems, latestFirstItems) {
  if (orderedItems.length !== latestFirstItems.length) return false;
  for (let index = 0; index < orderedItems.length; index += 1) {
    const incoming = latestFirstItems[latestFirstItems.length - index - 1];
    if (JSON.stringify(orderedItems[index]) !== JSON.stringify(incoming)) return false;
  }
  return true;
}

export function createTimelineCache({
  maxSpaces = 8,
  maxItems = 200,
} = {}) {
  const snapshots = new Map();

  function get(spaceId, spaceSessionId) {
    const snapshot = snapshots.get(spaceId);
    if (!snapshot || snapshot.spaceSessionId !== spaceSessionId) return null;
    snapshots.delete(spaceId);
    snapshots.set(spaceId, snapshot);
    return {
      ...snapshot,
      items: [...snapshot.items],
    };
  }

  function set(spaceId, {
    spaceSessionId,
    items = [],
    hasOlder = false,
    seq = 0,
  } = {}) {
    if (!spaceId || !spaceSessionId) return;
    snapshots.delete(spaceId);
    snapshots.set(spaceId, {
      spaceSessionId,
      items: items.slice(-maxItems),
      hasOlder: Boolean(hasOlder),
      seq: Number.isFinite(seq) ? seq : 0,
    });
    while (snapshots.size > maxSpaces) {
      snapshots.delete(snapshots.keys().next().value);
    }
  }

  function clear(spaceId) {
    if (spaceId) snapshots.delete(spaceId);
    else snapshots.clear();
  }

  return { get, set, clear };
}
