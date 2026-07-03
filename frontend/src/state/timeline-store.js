// 时间线状态：合并 Message / Activity / Approval 三种 itemType，按 SSE 事件
// 语义（docs/api-contract.md 四、客户端义务）就地更新。纯逻辑，不碰 DOM——
// 前端 UI 状态只是后端 gateway 的缓存（AGENTS.md「单一事实来源」）。

function key(itemType, id) {
  return `${itemType}:${id}`;
}

export function createTimelineStore() {
  const items = new Map(); // key -> item（带 itemType 字段）
  const order = []; // key 的插入顺序 = 显示顺序（时间升序）
  const listeners = new Set();

  function getOrderedItems() {
    return order.map((k) => items.get(k));
  }

  function notify(changedKey) {
    const snapshot = getOrderedItems();
    for (const listener of listeners) listener(snapshot, changedKey);
  }

  function upsert(itemType, record) {
    const k = key(itemType, record.id);
    if (!items.has(k)) order.push(k);
    items.set(k, { ...record, itemType });
    return k;
  }

  function patch(itemType, id, fields) {
    const k = key(itemType, id);
    const existing = items.get(k);
    if (!existing) return null;
    items.set(k, { ...existing, ...fields });
    return k;
  }

  // 初始 hydrate：GET timeline 按契约倒序返回（最新在前），这里翻正为时间升序，
  // 与实时事件的追加顺序保持一致。stream.reset 后重新调用一次即可。
  function hydrate(timelineItems) {
    items.clear();
    order.length = 0;
    const ascending = [...timelineItems].reverse();
    for (const item of ascending) upsert(item.itemType, item);
    notify(null); // null 表示"整体重渲染"，区别于单条增量变化
  }

  function ingestEvent(envelope) {
    const { type, data } = envelope;
    switch (type) {
      case "message.created": {
        notify(upsert("message", data.message));
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
        const k = patch("message", data.message.id, data.message);
        if (k) notify(k);
        return;
      }
      case "activity.created": {
        notify(upsert("activity", data.activity));
        return;
      }
      case "activity.updated": {
        const k = patch("activity", data.activity.id, data.activity);
        if (k) notify(k);
        return;
      }
      case "approval.requested": {
        notify(upsert("approval", data.approval));
        return;
      }
      case "approval.answered": {
        const k = patch("approval", data.approval.id, data.approval);
        if (k) notify(k);
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

  return { hydrate, ingestEvent, getOrderedItems, subscribe };
}
