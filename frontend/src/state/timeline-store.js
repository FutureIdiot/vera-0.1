// 时间线状态：合并 Message / Activity / Approval 三种 itemType，按 SSE 事件
// 语义（docs/api-contract.md 四、客户端义务）就地更新。纯逻辑，不碰 DOM——
// 前端 UI 状态只是后端 gateway 的缓存（AGENTS.md「单一事实来源」）。

function key(itemType, id) {
  return `${itemType}:${id}`;
}

export function createTimelineStore({ maxItems = 200 } = {}) {
  const items = new Map(); // key -> item（带 itemType 字段）
  const order = []; // key 的插入顺序 = 显示顺序（时间升序）
  const listeners = new Set();

  function getOrderedItems() {
    return order.map((k) => items.get(k));
  }

  function notify(changedKey, removedKeys = []) {
    const snapshot = getOrderedItems();
    for (const listener of listeners) listener(snapshot, changedKey, removedKeys);
  }

  function trim() {
    const removedKeys = [];
    while (order.length > maxItems) {
      const removedKey = order.shift();
      items.delete(removedKey);
      removedKeys.push(removedKey);
    }
    return removedKeys;
  }

  function upsert(itemType, record) {
    const k = key(itemType, record.id);
    if (!items.has(k)) order.push(k);
    items.set(k, { ...record, itemType });
    return { changedKey: k, removedKeys: trim() };
  }

  function patch(itemType, id, fields) {
    const k = key(itemType, id);
    const existing = items.get(k);
    if (!existing) return null;
    items.set(k, { ...existing, ...fields });
    return { changedKey: k, removedKeys: [] };
  }

  // 初始 hydrate：GET timeline 按契约倒序返回（最新在前），这里翻正为时间升序，
  // 与实时事件的追加顺序保持一致。stream.reset 后重新调用一次即可。
  function hydrate(timelineItems) {
    items.clear();
    order.length = 0;
    const ascending = [...timelineItems].reverse();
    for (const item of ascending) upsert(item.itemType, item);
    trim();
    notify(null); // null 表示"整体重渲染"，区别于单条增量变化
  }

  function ingestEvent(envelope) {
    const { type, data } = envelope;
    switch (type) {
      case "message.created": {
        const change = upsert("message", data.message);
        notify(change.changedKey, change.removedKeys);
        return;
      }
      case "message.delta": {
        const k = key("message", data.messageId);
        const existing = items.get(k);
        if (!existing) return; // 契约保证 created 先于 delta，正常不会发生
        items.set(k, { ...existing, content: (existing.content ?? "") + data.delta, status: "streaming" });
        notify(k);
        return;
      }
      case "message.completed": {
        const change = patch("message", data.message.id, data.message);
        if (change) notify(change.changedKey);
        return;
      }
      case "activity.created": {
        const change = upsert("activity", data.activity);
        notify(change.changedKey, change.removedKeys);
        return;
      }
      case "activity.updated": {
        const change = patch("activity", data.activity.id, data.activity);
        if (change) notify(change.changedKey);
        return;
      }
      case "approval.requested": {
        const change = upsert("approval", data.approval);
        notify(change.changedKey, change.removedKeys);
        return;
      }
      case "approval.answered": {
        const change = patch("approval", data.approval.id, data.approval);
        if (change) notify(change.changedKey);
        return;
      }
      default:
        // 未知 type（含 run.*/agent.state.updated/space.updated/agent.updated/
        // stream.reset）：时间线不关心，静默忽略（客户端义务：向前兼容）。
        return;
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function clear() {
    const removedKeys = [...order];
    items.clear();
    order.length = 0;
    notify(null, removedKeys);
  }

  return { hydrate, ingestEvent, getOrderedItems, subscribe, clear };
}
