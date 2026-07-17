import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../src/store/store.js";
import { createMemoryTaskRuntime } from "../../src/memory/memory-task-runtime.js";

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "vera-memory-task-runtime-test-"));
  const store = await createStore({ dataPath: join(root, "data"), debounceMs: 5 });
  store.insert("agents", { id: "agt_owner", name: "Owner" });
  store.insert("agents", {
    id: "agt_executor", name: "Executor",
    runtimeProfile: { schemaVersion: 1, kind: "cli", provider: "codex", model: "chat-model" },
    runtimeBinding: { connection: { command: "codex", args: [], secretRef: "secret-ref" } },
    runtimeRevision: "sha256:runtime-one",
  });
  store.insert("accounts", {
    id: "acc_executor", ownerAgentId: "agt_executor",
  });
  const runtime = createMemoryTaskRuntime({ store, now: () => "2026-07-15T00:00:00.000Z" });
  try { await fn({ store, runtime }); }
  finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}

test("verified inherit task resolves a frozen secret-free executor snapshot", async () => {
  await fixture(async ({ runtime }) => {
    const verification = runtime.recordVerification({ taskKind: "digest", executorAgentId: "agt_executor", model: "chat-model" });
    const snapshot = runtime.resolveTaskSnapshot({
      ownerAgentId: "agt_owner", taskKind: "digest",
      taskConfig: { executorAgentId: "agt_executor", modelMode: "inherit", model: null },
    });
    assert.deepEqual(snapshot, {
      ownerAgentId: "agt_owner", executorAgentId: "agt_executor", runtimeRevision: "sha256:runtime-one",
      kind: "cli", provider: "codex", modelMode: "inherit", taskModel: "chat-model",
      verificationId: verification.id, connectionFingerprint: verification.connectionFingerprint,
    });
    assert.equal(JSON.stringify(snapshot).includes("secret-ref"), false);
    assert.equal("connection" in snapshot, false);
  });
});

test("Digest and Dream verification records never cross-qualify", async () => {
  await fixture(async ({ runtime }) => {
    runtime.recordVerification({ taskKind: "digest", executorAgentId: "agt_executor", model: "cheap-model" });
    const config = { executorAgentId: "agt_executor", modelMode: "fixed", model: "cheap-model" };
    assert.equal(runtime.resolveTaskSnapshot({ ownerAgentId: "agt_owner", taskKind: "digest", taskConfig: config }).taskModel, "cheap-model");
    assert.throws(() => runtime.resolveTaskSnapshot({ ownerAgentId: "agt_owner", taskKind: "dream", taskConfig: config }),
      (error) => error.code === "memory_task_unavailable");
    runtime.recordVerification({ taskKind: "dream", executorAgentId: "agt_executor", model: "cheap-model" });
    assert.equal(runtime.resolveTaskSnapshot({ ownerAgentId: "agt_owner", taskKind: "dream", taskConfig: config }).taskModel, "cheap-model");
  });
});

test("connection changes invalidate exact verification and safe options", async () => {
  await fixture(async ({ store, runtime }) => {
    runtime.recordVerification({ taskKind: "digest", executorAgentId: "agt_executor", model: "chat-model" });
    const combined = runtime.listOptions({ ownerAgentId: "agt_owner" });
    assert.equal(combined.digest.executors.find((item) => item.agentId === "agt_executor").models.length, 1);
    assert.equal(combined.dream.executors.find((item) => item.agentId === "agt_executor").models.length, 0);
    assert.equal(runtime.listOptions({ ownerAgentId: "agt_owner", taskKind: "digest" }).executors
      .find((item) => item.agentId === "agt_executor").models.length, 1);
    store.update("agents", "agt_executor", {
      runtimeBinding: { connection: { command: "codex-new", args: [], secretRef: "secret-ref" } },
    });
    const option = runtime.listOptions({ ownerAgentId: "agt_owner", taskKind: "digest" }).executors
      .find((item) => item.agentId === "agt_executor");
    assert.deepEqual(option.models, []);
    assert.equal(option.availability, "unavailable");
    assert.throws(() => runtime.resolveTaskSnapshot({
      ownerAgentId: "agt_owner", taskKind: "digest",
      taskConfig: { executorAgentId: "agt_executor", modelMode: "inherit", model: null },
    }), (error) => error.code === "memory_task_unavailable");
  });
});

test("Memory task execution depends on Agent runtime, not Account ownership count", async () => {
  await fixture(async ({ store, runtime }) => {
    assert.throws(() => runtime.recordVerification({ taskKind: "digest", executorAgentId: "agt_owner", model: "x" }),
      (error) => error.code === "memory_task_unavailable");
    store.insert("accounts", {
      id: "acc_executor_two", ownerAgentId: "agt_executor",
    });
    runtime.recordVerification({ taskKind: "digest", executorAgentId: "agt_executor", model: "x" });
    const options = runtime.listOptions({ ownerAgentId: "agt_owner", taskKind: "digest" });
    assert.equal(options.executors.find((item) => item.agentId === "agt_executor").availability, "available");
  });
});
