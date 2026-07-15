import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../src/store/store.js";
import {
  BUILT_IN_UNITS,
  ensureUnitBindings,
  getUnitBinding,
  listUnitBindings,
  updateUnitBinding,
} from "../../src/agents/unit-bindings.js";

const AGENT_ID = "agt_unit_bindings";

async function withStore(run) {
  const parent = await mkdtemp(join(tmpdir(), "vera-unit-bindings-"));
  const dataPath = join(parent, "data");
  const store = await createStore({ dataPath, debounceMs: 5 });
  store.insert("agents", { id: AGENT_ID, name: "Binding Owner" });
  try {
    await run(store, dataPath);
  } finally {
    await store.close();
    await rm(parent, { recursive: true, force: true });
  }
}

test("ensure gives existing Agents the three enabled gateway built-ins once", async () => {
  await withStore(async (store) => {
    const first = ensureUnitBindings(store, AGENT_ID);
    const second = ensureUnitBindings(store, AGENT_ID);

    assert.deepEqual(first.map(({ unitId, kind, name, enabled, runtime, availability }) => ({
      unitId, kind, name, enabled, runtime, availability,
    })), BUILT_IN_UNITS.map((unit) => ({ ...unit, enabled: true })));
    assert.deepEqual(second, first);
    assert.equal(store.list("unitBindings").length, 3);
    for (const binding of first) {
      assert.equal(binding.agentId, AGENT_ID);
      assert.match(binding.version, /^ubv_[0-9a-f]{32}$/u);
      assert.equal("executorAgentId" in binding, false);
    }
  });
});

test("list requires a valid kind, filters manifest order, and ensures defaults", async () => {
  await withStore(async (store) => {
    assert.deepEqual(
      listUnitBindings(store, AGENT_ID, { kind: "hook" }).map((item) => item.unitId),
      ["vera.memory.recall", "vera.memory.write"],
    );
    assert.deepEqual(
      listUnitBindings(store, AGENT_ID, { kind: "mcp" }).map((item) => item.unitId),
      ["vera.memory"],
    );
    assert.throws(
      () => listUnitBindings(store, AGENT_ID),
      (error) => error.code === "invalid_request",
    );
    assert.throws(
      () => listUnitBindings(store, AGENT_ID, { kind: "skill" }),
      (error) => error.code === "invalid_request",
    );
  });
});

test("PATCH changes only enabled with ifMatch and advances the opaque version", async () => {
  await withStore(async (store) => {
    const before = getUnitBinding(store, AGENT_ID, "vera.memory.recall");
    const updated = updateUnitBinding(store, AGENT_ID, before.unitId, {
      enabled: false,
      ifMatch: before.version,
    });

    assert.equal(updated.enabled, false);
    assert.notEqual(updated.version, before.version);
    assert.deepEqual(
      { ...updated, enabled: before.enabled, version: before.version },
      before,
    );
    assert.deepEqual(getUnitBinding(store, AGENT_ID, before.unitId), updated);
  });
});

test("PATCH rejects stale versions, executorAgentId, immutable and unknown fields without mutation", async () => {
  await withStore(async (store) => {
    const current = getUnitBinding(store, AGENT_ID, "vera.memory.write");

    assert.throws(
      () => updateUnitBinding(store, AGENT_ID, current.unitId, { enabled: false, ifMatch: "ubv_stale" }),
      (error) => error.code === "conflict"
        && error.details.reason === "version_mismatch"
        && error.details.current.binding.version === current.version,
    );

    const invalidPatches = [
      null,
      [],
      {},
      { enabled: false },
      { ifMatch: current.version },
      { enabled: "false", ifMatch: current.version },
      { enabled: false, ifMatch: "" },
      { enabled: false, ifMatch: current.version, executorAgentId: AGENT_ID },
      { enabled: false, ifMatch: current.version, runtime: "daemon" },
      { enabled: false, ifMatch: current.version, surprise: true },
    ];
    for (const patch of invalidPatches) {
      assert.throws(
        () => updateUnitBinding(store, AGENT_ID, current.unitId, patch),
        (error) => error.code === "invalid_request",
      );
    }
    assert.deepEqual(getUnitBinding(store, AGENT_ID, current.unitId), current);
  });
});

test("unknown Agents and units return not_found", async () => {
  await withStore(async (store) => {
    assert.throws(
      () => ensureUnitBindings(store, "agt_missing"),
      (error) => error.code === "not_found",
    );
    assert.throws(
      () => listUnitBindings(store, "agt_missing", { kind: "mcp" }),
      (error) => error.code === "not_found",
    );
    assert.throws(
      () => getUnitBinding(store, AGENT_ID, "unknown.unit"),
      (error) => error.code === "not_found",
    );
    assert.throws(
      () => updateUnitBinding(store, AGENT_ID, "unknown.unit", { enabled: false, ifMatch: "any" }),
      (error) => error.code === "not_found",
    );
  });
});

test("bindings persist across store restart", async () => {
  const parent = await mkdtemp(join(tmpdir(), "vera-unit-bindings-persist-"));
  const dataPath = join(parent, "data");
  try {
    const firstStore = await createStore({ dataPath, debounceMs: 5 });
    firstStore.insert("agents", { id: AGENT_ID, name: "Binding Owner" });
    const before = getUnitBinding(firstStore, AGENT_ID, "vera.memory");
    const disabled = updateUnitBinding(firstStore, AGENT_ID, before.unitId, {
      enabled: false,
      ifMatch: before.version,
    });
    await firstStore.close();

    const secondStore = await createStore({ dataPath, debounceMs: 5 });
    assert.deepEqual(getUnitBinding(secondStore, AGENT_ID, before.unitId), disabled);
    assert.equal(secondStore.list("unitBindings").length, 3);
    await secondStore.close();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
