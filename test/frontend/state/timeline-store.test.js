import test from "node:test";
import assert from "node:assert/strict";

import { createTimelineStore } from "../../../frontend/src/state/timeline-store.js";

function message(id, fields = {}) {
  return { id, content: id, status: "completed", itemType: "message", ...fields };
}

test("hydrate converts the API newest-first order to display order", () => {
  const store = createTimelineStore();
  const notifications = [];
  store.subscribe((items, changedKey, removedKeys) => notifications.push({ items, changedKey, removedKeys }));

  store.hydrate([message("msg_3"), message("msg_2"), message("msg_1")]);

  assert.deepEqual(store.getOrderedItems().map((item) => item.id), ["msg_1", "msg_2", "msg_3"]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].changedKey, null);
});

test("Message, Activity, and Approval events update records by item key", () => {
  const store = createTimelineStore();

  store.ingestEvent({
    type: "message.created",
    data: { message: { id: "msg_1", content: "hel", status: "streaming" } },
  });
  store.ingestEvent({ type: "message.delta", data: { messageId: "msg_1", delta: "lo" } });
  store.ingestEvent({
    type: "message.completed",
    data: { message: { id: "msg_1", content: "hello", status: "completed" } },
  });
  store.ingestEvent({
    type: "activity.created",
    data: { activity: { id: "act_1", phase: "tool", toolStatus: "running" } },
  });
  store.ingestEvent({
    type: "activity.updated",
    data: { activity: { id: "act_1", toolStatus: "completed" } },
  });
  store.ingestEvent({
    type: "approval.requested",
    data: { approval: { id: "apr_1", prompt: "Allow?", status: "pending" } },
  });
  store.ingestEvent({
    type: "approval.answered",
    data: { approval: { id: "apr_1", status: "answered", answer: "allow" } },
  });

  assert.deepEqual(store.getOrderedItems(), [
    { id: "msg_1", content: "hello", status: "completed", itemType: "message" },
    { id: "act_1", phase: "tool", toolStatus: "completed", itemType: "activity" },
    { id: "apr_1", prompt: "Allow?", status: "answered", answer: "allow", itemType: "approval" },
  ]);
});

test("duplicate creates replace the keyed record without changing its position", () => {
  const store = createTimelineStore();
  store.ingestEvent({ type: "message.created", data: { message: { id: "msg_1", content: "first" } } });
  store.ingestEvent({ type: "message.created", data: { message: { id: "msg_2", content: "second" } } });
  store.ingestEvent({ type: "message.created", data: { message: { id: "msg_1", content: "replaced" } } });

  assert.deepEqual(store.getOrderedItems().map((item) => [item.id, item.content]), [
    ["msg_1", "replaced"],
    ["msg_2", "second"],
  ]);
});

test("unknown events and patches for missing records are ignored", () => {
  const store = createTimelineStore();
  let notificationCount = 0;
  store.subscribe(() => {
    notificationCount += 1;
  });

  store.ingestEvent({ type: "run.started", data: { run: { id: "run_1" } } });
  store.ingestEvent({ type: "message.delta", data: { messageId: "msg_missing", delta: "x" } });
  store.ingestEvent({
    type: "approval.answered",
    data: { approval: { id: "apr_missing", status: "answered" } },
  });

  assert.equal(notificationCount, 0);
  assert.deepEqual(store.getOrderedItems(), []);
});

test("hydrate retains only the newest maxItems records", () => {
  const store = createTimelineStore({ maxItems: 200 });
  const newestFirst = Array.from({ length: 250 }, (_, index) => message(`msg_${250 - index}`));

  store.hydrate(newestFirst);

  const ids = store.getOrderedItems().map((item) => item.id);
  assert.equal(ids.length, 200);
  assert.equal(ids[0], "msg_51");
  assert.equal(ids.at(-1), "msg_250");
});

test("prependOlder deduplicates history and shifts the bounded window toward older items", () => {
  const store = createTimelineStore({ maxItems: 3 });
  store.hydrate([
    { itemType: "message", id: "m4" },
    { itemType: "message", id: "m3" },
  ]);
  store.prependOlder([
    { itemType: "message", id: "m3" },
    { itemType: "message", id: "m2" },
    { itemType: "message", id: "m1" },
  ]);
  assert.deepEqual(store.getOrderedItems().map((item) => item.id), ["m1", "m2", "m3"]);
});

test("live inserts stay bounded and report keys removed from the front", () => {
  const store = createTimelineStore({ maxItems: 3 });
  const notifications = [];
  store.subscribe((items, changedKey, removedKeys) => {
    notifications.push({ ids: items.map((item) => item.id), changedKey, removedKeys });
  });

  for (let index = 1; index <= 4; index += 1) {
    store.ingestEvent({
      type: "message.created",
      data: { message: { id: `msg_${index}`, content: String(index) } },
    });
  }

  assert.deepEqual(store.getOrderedItems().map((item) => item.id), ["msg_2", "msg_3", "msg_4"]);
  assert.deepEqual(notifications.at(-1), {
    ids: ["msg_2", "msg_3", "msg_4"],
    changedKey: "message:msg_4",
    removedKeys: ["message:msg_1"],
  });

  const beforeMissingPatch = notifications.length;
  store.ingestEvent({ type: "message.delta", data: { messageId: "msg_1", delta: "late" } });
  assert.equal(notifications.length, beforeMissingPatch);
  assert.deepEqual(store.getOrderedItems().map((item) => item.id), ["msg_2", "msg_3", "msg_4"]);
});

test("unsubscribe stops notifications and clear reports all removed keys", () => {
  const store = createTimelineStore();
  const notifications = [];
  const unsubscribe = store.subscribe((items, changedKey, removedKeys) => {
    notifications.push({ items, changedKey, removedKeys });
  });

  store.hydrate([message("msg_2"), message("msg_1")]);
  store.clear();

  assert.deepEqual(notifications.at(-1).removedKeys, ["message:msg_1", "message:msg_2"]);
  assert.equal(notifications.at(-1).changedKey, null);
  assert.deepEqual(store.getOrderedItems(), []);

  unsubscribe();
  store.ingestEvent({ type: "message.created", data: { message: { id: "msg_3" } } });
  assert.equal(notifications.length, 2);
});
