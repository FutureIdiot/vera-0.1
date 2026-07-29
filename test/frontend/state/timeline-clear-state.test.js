import test from "node:test";
import assert from "node:assert/strict";

import { createTimelineClearState } from "../../../frontend/src/state/timeline-clear-state.js";

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}

function message(id, createdAt) {
  return { id, itemType: "message", createdAt };
}

test("timeline clear state survives remount and keeps only items after the local cutoff", () => {
  const storage = createStorage();
  const first = createTimelineClearState({
    storage,
    now: () => new Date("2026-07-30T10:00:00.000Z"),
  });
  const before = [
    message("msg_2", "2026-07-30T09:59:00.000Z"),
    message("msg_1", "2026-07-30T09:58:00.000Z"),
  ];

  first.mark("spc_1", "sps_1", before);
  assert.deepEqual(first.filter("spc_1", "sps_1", before), []);

  const remounted = createTimelineClearState({ storage });
  const after = message("msg_3", "2026-07-30T10:01:00.000Z");
  assert.deepEqual(
    remounted.filter("spc_1", "sps_1", [after, ...before]).map((item) => item.id),
    ["msg_3"],
  );
});

test("restoring a SpaceSession removes only that Session's local clear marker", () => {
  const storage = createStorage();
  const state = createTimelineClearState({
    storage,
    now: () => new Date("2026-07-30T10:00:00.000Z"),
  });
  const items = [message("msg_1", "2026-07-30T09:59:00.000Z")];

  state.mark("spc_1", "sps_1", items);
  state.mark("spc_1", "sps_2", items);
  state.restore("spc_1", "sps_1");

  assert.deepEqual(state.filter("spc_1", "sps_1", items), items);
  assert.deepEqual(state.filter("spc_1", "sps_2", items), []);
});
