import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "../../src/store/store.js";
import { createObservationService } from "../../src/spaces/observation.js";

test("observation is process-local CAS state and only one active private Space is observable", async () => {
  const root = await mkdtemp(join(tmpdir(), "vera-observation-"));
  const store = await createStore({ dataPath: root, debounceMs: 1 });
  const events = [];
  const dispatched = [];
  try {
    store.insert("spaces", {
      id: "spc_private", name: "Private", seats: [{ accountId: "acc_a" }],
      archivedAt: null, createdAt: "2026-07-25T00:00:00.000Z",
    });
    store.insert("spaces", {
      id: "spc_group", name: "Group", seats: [{ accountId: "acc_a" }, { accountId: "acc_b" }],
      archivedAt: null, createdAt: "2026-07-25T00:00:00.000Z",
    });
    store.insert("runs", {
      id: "run_private", accountId: "acc_a", spaceId: "spc_private",
      status: "running", executionTransport: "daemon",
    });
    const observation = createObservationService({
      store,
      hub: { publish(type, data) { events.push({ type, data }); } },
      dispatchRunVisibility(value) { dispatched.push(value); },
    });

    assert.deepEqual(observation.get(), { observedSpaceId: null, revision: 0 });
    assert.equal(observation.visibilityForSpace("spc_private"), "status-only");
    assert.deepEqual(observation.update({ spaceId: "spc_private", ifRevision: 0 }), {
      observedSpaceId: "spc_private",
      revision: 1,
    });
    assert.equal(observation.visibilityForSpace("spc_private"), "observed");
    assert.equal(dispatched.at(-1).event.data.activityVisibility, "observed");
    assert.deepEqual(events.at(-1), {
      type: "observation.updated",
      data: { observation: { observedSpaceId: "spc_private", revision: 1 } },
    });

    assert.throws(
      () => observation.update({ spaceId: null, ifRevision: 0 }),
      (error) => error.code === "conflict",
    );
    assert.throws(
      () => observation.update({ spaceId: "spc_group", ifRevision: 1 }),
      (error) => error.code === "conflict",
    );
    assert.equal(observation.projectActivity({ spaceId: "spc_private", detail: "public" }).detail, "public");
    assert.equal(observation.projectActivity({ spaceId: "spc_private", detail: "public" }, { archived: true }).detail, null);

    store.update("spaces", "spc_private", {
      seats: [{ accountId: "acc_a" }, { accountId: "acc_b" }],
    });
    observation.reconcileSpace("spc_private");
    assert.deepEqual(observation.get(), { observedSpaceId: null, revision: 2 });
    assert.equal(dispatched.at(-1).event.data.activityVisibility, "status-only");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
