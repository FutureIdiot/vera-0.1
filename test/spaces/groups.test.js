import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "../../src/store/store.js";
import { createGroup, updateGroup } from "../../src/spaces/groups.js";

test("Group member updates synchronize every Space seat while preserving remaining rules", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-groups-test-"));
  const store = await createStore({ dataPath, debounceMs: 1 });
  try {
    for (const id of ["acc_a", "acc_b", "acc_c"]) {
      store.insert("accounts", { id, name: id, ownerAgentId: null });
    }
    assert.throws(
      () => createGroup(store, {
        name: "Removed topic",
        topic: "must fail",
        accountIds: ["acc_a", "acc_b"],
      }),
      (error) => error.code === "invalid_request",
    );
    const group = createGroup(store, {
      name: "Team",
      accountIds: ["acc_a", "acc_b"],
    });
    store.insert("spaces", {
      id: "spc_group",
      name: "Grouped",
      groupId: group.id,
      seats: [
        { accountId: "acc_a", responseMode: "silent", respondTo: ["user", "acc_b"] },
        { accountId: "acc_b", responseMode: "default", blockAccountIds: ["acc_a"] },
      ],
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
    });

    const result = updateGroup(store, group.id, {
      name: "Team Next",
      accountIds: ["acc_a", "acc_c"],
    });

    assert.equal(result.group.name, "Team Next");
    assert.throws(
      () => updateGroup(store, group.id, { topic: "must fail" }),
      (error) => error.code === "invalid_request",
    );
    assert.equal(result.spaces.length, 1);
    assert.deepEqual(result.spaces[0].seats, [
      { accountId: "acc_a", responseMode: "silent", respondTo: ["user"] },
      { accountId: "acc_c", responseMode: "default" },
    ]);
  } finally {
    await store.close();
    await rm(dataPath, { recursive: true, force: true });
  }
});

test("Group membership cannot change while one of its Spaces has active work", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-groups-busy-test-"));
  const store = await createStore({ dataPath, debounceMs: 1 });
  try {
    for (const id of ["acc_a", "acc_b", "acc_c"]) {
      store.insert("accounts", { id, name: id, ownerAgentId: null });
    }
    const group = createGroup(store, {
      name: "Team",
      accountIds: ["acc_a", "acc_b"],
    });
    store.insert("spaces", {
      id: "spc_group",
      name: "Grouped",
      groupId: group.id,
      seats: [
        { accountId: "acc_a", responseMode: "default" },
        { accountId: "acc_b", responseMode: "default" },
      ],
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
    });
    store.insert("runs", {
      id: "run_busy",
      spaceId: "spc_group",
      status: "running",
    });

    assert.throws(
      () => updateGroup(store, group.id, { accountIds: ["acc_a", "acc_c"] }),
      (error) => error.code === "conflict",
    );
    assert.deepEqual(store.find("groups", group.id).accountIds, ["acc_a", "acc_b"]);
    assert.deepEqual(
      store.find("spaces", "spc_group").seats.map((seat) => seat.accountId),
      ["acc_a", "acc_b"],
    );
  } finally {
    await store.close();
    await rm(dataPath, { recursive: true, force: true });
  }
});
