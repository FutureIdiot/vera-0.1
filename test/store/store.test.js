import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../src/store/store.js";

async function withTempDataPath(fn) {
  const dir = await mkdtemp(join(tmpdir(), "vera-store-test-"));
  const dataPath = join(dir, "store.json");
  try {
    await fn(dataPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("insert/find/update/remove round-trip in memory", async () => {
  await withTempDataPath(async (dataPath) => {
    const store = await createStore({ dataPath, debounceMs: 10 });
    const agent = store.insert("agents", { id: "agt_1", name: "Iota" });
    assert.equal(store.find("agents", "agt_1").name, "Iota");
    assert.ok(typeof agent._seq === "number");

    store.update("agents", "agt_1", { name: "Iota2" });
    assert.equal(store.find("agents", "agt_1").name, "Iota2");

    const removed = store.remove("agents", "agt_1");
    assert.equal(removed, true);
    assert.equal(store.find("agents", "agt_1"), null);
    await store.close();
  });
});

test("persists to disk and reloads on next createStore call", async () => {
  await withTempDataPath(async (dataPath) => {
    const store = await createStore({ dataPath, debounceMs: 10 });
    store.insert("spaces", { id: "spc_1", name: "vera-dev" });
    await store.close(); // flush

    const reloaded = await createStore({ dataPath, debounceMs: 10 });
    const found = reloaded.find("spaces", "spc_1");
    assert.ok(found, "space should survive reload");
    assert.equal(found.name, "vera-dev");
    await reloaded.close();
  });
});

test("sessionState get/set is per (agentId, spaceId)", async () => {
  await withTempDataPath(async (dataPath) => {
    const store = await createStore({ dataPath, debounceMs: 10 });
    assert.equal(store.getSessionState("agt_1", "spc_1"), null);

    store.setSessionState("agt_1", "spc_1", { count: 1 });
    store.setSessionState("agt_1", "spc_2", { count: 99 });

    assert.deepEqual(store.getSessionState("agt_1", "spc_1"), { count: 1 });
    assert.deepEqual(store.getSessionState("agt_1", "spc_2"), { count: 99 });
    await store.close();
  });
});

test("_seq is monotonically increasing across collections", async () => {
  await withTempDataPath(async (dataPath) => {
    const store = await createStore({ dataPath, debounceMs: 10 });
    const a = store.insert("messages", { id: "msg_1" });
    const b = store.insert("activities", { id: "act_1" });
    const c = store.insert("messages", { id: "msg_2" });
    assert.ok(a._seq < b._seq);
    assert.ok(b._seq < c._seq);
    await store.close();
  });
});
