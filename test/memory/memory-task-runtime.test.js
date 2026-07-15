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
  store.insert("agents", { id: "agt_executor", name: "Executor" });
  store.insert("accounts", {
    id: "acc_executor", owningAgentId: "agt_executor", kind: "cli", provider: "codex",
    model: "chat-model", connection: { command: "codex", args: [], secretRef: "secret-ref" },
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
      ownerAgentId: "agt_owner", executorAgentId: "agt_executor", accountId: "acc_executor",
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
    store.update("accounts", "acc_executor", { connection: { command: "codex-new", args: [], secretRef: "secret-ref" } });
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

test("zero or multiple owning Accounts are unavailable in the Phase 5 transition", async () => {
  await fixture(async ({ store, runtime }) => {
    assert.throws(() => runtime.recordVerification({ taskKind: "digest", executorAgentId: "agt_owner", model: "x" }),
      (error) => error.code === "memory_task_unavailable");
    store.insert("accounts", {
      id: "acc_executor_two", owningAgentId: "agt_executor", kind: "api", provider: "ollama",
      model: "other", connection: { baseUrl: "http://127.0.0.1:11434" },
    });
    assert.throws(() => runtime.recordVerification({ taskKind: "digest", executorAgentId: "agt_executor", model: "x" }),
      (error) => error.code === "memory_task_unavailable");
    const options = runtime.listOptions({ ownerAgentId: "agt_owner", taskKind: "digest" });
    assert.equal(options.executors.every((item) => item.availability === "unavailable"), true);
  });
});
