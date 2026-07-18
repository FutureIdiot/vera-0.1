import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/core/config.js";
import { createSettingsStore } from "../../src/core/settings-store.js";
import { createStore } from "../../src/store/store.js";
import { createMemoryConfigService } from "../../src/memory/memory-config.js";

async function fixture(fn, settings = null) {
  const root = await mkdtemp(join(tmpdir(), "vera-memory-config-test-"));
  const dataPath = join(root, "data");
  const config = loadConfig({ VERA_DATA_PATH: dataPath, VERA_MEMORY_SCHEDULE_TIMEZONE: "Asia/Tokyo" });
  const store = await createStore({ dataPath, debounceMs: 5 });
  store.insert("agents", { id: "agt_owner", name: "Owner" });
  await store.flush();
  if (settings) await writeFile(join(dataPath, "settings.json"), JSON.stringify(settings), "utf8");
  const settingsStore = await createSettingsStore({ dataPath, config, debounceMs: 5 });
  const service = createMemoryConfigService({ store, settingsStore, config });
  try { await fn({ root, dataPath, config, store, settingsStore, service }); }
  finally { await settingsStore.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
}

test("M4 runtime config defaults and env overrides are centralized", () => {
  const defaults = loadConfig({});
  assert.equal(defaults.memory.scheduleTimezone, "UTC");
  assert.equal(defaults.memory.dreamBatchSize, 256);
  assert.equal(defaults.codex.dreamTimeoutMs, 600000);
  assert.equal(defaults.ollama.dreamTimeoutMs, 600000);
  const custom = loadConfig({
    VERA_MEMORY_SCHEDULE_TIMEZONE: "Asia/Tokyo",
    VERA_MEMORY_DREAM_BATCH_SIZE: "64",
    VERA_CODEX_MEMORY_DREAM_TIMEOUT_MS: "700000",
    VERA_OLLAMA_MEMORY_DREAM_TIMEOUT_MS: "800000",
  });
  assert.deepEqual({ timezone: custom.memory.scheduleTimezone, batch: custom.memory.dreamBatchSize },
    { timezone: "Asia/Tokyo", batch: 64 });
  assert.equal(custom.codex.dreamTimeoutMs, 700000);
  assert.equal(custom.ollama.dreamTimeoutMs, 800000);
  assert.equal(loadConfig({ VERA_MEMORY_SCHEDULE_TIMEZONE: "Invalid/Zone" }).memory.scheduleTimezone, "UTC");
  assert.equal(loadConfig({ VERA_MEMORY_DREAM_BATCH_SIZE: "257" }).memory.dreamBatchSize, 256);
});

test("legacy global Digest settings migrate once into every existing Agent and leave Settings", async () => {
  await fixture(async ({ dataPath, store, settingsStore, service }) => {
    store.insert("agents", { id: "agt_second", name: "Second" });
    assert.equal("memory.digestTrigger" in settingsStore.getAll(), false);
    assert.deepEqual(settingsStore.getLegacyMemoryDigestTemplate(), {
      digestTrigger: "realtime",
      digestSchedule: "5 4 * * *",
      digestRealtimeThresholdChars: 2222,
    });
    await service.initializeExistingAgents();
    assert.equal(store.find("memoryConfigs", "_migration:memory-config-v1").status, "completed");
    for (const agentId of ["agt_owner", "agt_second"]) {
      const result = service.getConfig(agentId);
      assert.deepEqual(result.config.digest, {
        executorAgentId: null, modelMode: "inherit", model: null,
        trigger: { mode: "realtime", thresholdChars: 2222 },
      });
      assert.deepEqual(result.config.dream, {
        executorAgentId: null, modelMode: "inherit", model: null, schedule: { mode: "manual" },
      });
    }
    const persisted = JSON.parse(await readFile(join(dataPath, "settings.json"), "utf8"));
    assert.equal(Object.keys(persisted).some((key) => key.startsWith("memory.digest")), false);
    assert.equal(persisted["presentation.bubbleMaxLength"], 900);
    await assert.rejects(() => settingsStore.setAll({ "memory.digestTrigger": "manual" }),
      (error) => error.code === "invalid_request");

    store.insert("agents", { id: "agt_new", name: "New" });
    assert.deepEqual(service.ensureAgentConfig("agt_new").config.digest.trigger, { mode: "manual" });
  }, {
    "memory.digestTrigger": "realtime",
    "memory.digestSchedule": "5 4 * * *",
    "memory.digestRealtimeThresholdChars": 2222,
    "presentation.bubbleMaxLength": 900,
  });
});

test("scheduled legacy migration adds the configured IANA timezone", async () => {
  await fixture(async ({ service }) => {
    await service.initializeExistingAgents();
    assert.deepEqual(service.getConfig("agt_owner").config.digest.trigger,
      { mode: "scheduled", cron: "15 3 * * *", timezone: "Asia/Tokyo" });
  }, { "memory.digestTrigger": "scheduled", "memory.digestSchedule": "15 3 * * *" });
});

test("existing Agents without legacy overrides inherit the old config defaults once", async () => {
  await fixture(async ({ service }) => {
    await service.initializeExistingAgents();
    assert.deepEqual(service.getConfig("agt_owner").config.digest.trigger,
      { mode: "scheduled", cron: "0 3 * * *", timezone: "Asia/Tokyo" });
  });
});

test("config PATCH replaces complete nested sections with opaque optimistic versioning", async () => {
  await fixture(async ({ store, service }) => {
    await service.initializeExistingAgents();
    store.insert("agents", { id: "agt_executor", name: "Executor" });
    const before = service.getConfig("agt_owner");
    assert.match(before.version, /^sha256:[a-f0-9]{64}$/);
    const digest = {
      executorAgentId: "agt_executor", modelMode: "fixed", model: "task-model",
      trigger: { mode: "scheduled", cron: "0 2 * * 1", timezone: "UTC" },
    };
    const after = await service.patchConfig("agt_owner", { digest, ifMatch: before.version });
    assert.deepEqual(after.config.digest, digest);
    assert.notEqual(after.version, before.version);
    await assert.rejects(() => service.patchConfig("agt_owner", {
      digest: { trigger: { mode: "manual" } }, ifMatch: after.version,
    }), (error) => error.code === "invalid_request");
    await assert.rejects(() => service.patchConfig("agt_owner", { dream: after.config.dream, ifMatch: before.version }),
      (error) => error.code === "conflict");
    await assert.rejects(() => service.patchConfig("agt_owner", {
      provider: { providerId: "third.party", placement: { runtime: "gateway" }, config: {} }, ifMatch: after.version,
    }), (error) => error.code === "memory_provider_unsupported");
  });
});

test("provider bindings use strict placement and gateway is the create default", async () => {
  await fixture(async ({ service }) => {
    const created = service.getConfig("agt_owner");
    assert.deepEqual(created.config.provider, {
      providerId: "vera.markdown", placement: { runtime: "gateway" }, config: {},
    });
    for (const placement of [
      { runtime: "gateway", hostId: "unexpected" },
      { runtime: "remote", hostId: "unexpected" },
      { runtime: "daemon" },
      { runtime: "daemon", hostId: "   " },
      { runtime: "unknown" },
    ]) {
      await assert.rejects(() => service.patchConfig("agt_owner", {
        provider: { providerId: "vera.markdown", placement, config: {} }, ifMatch: created.version,
      }), (error) => error.code === "invalid_request");
    }
  });
});

test("legacy provider placement migration is independent, idempotent, and body-preserving", async () => {
  await fixture(async ({ store, service }) => {
    const legacy = {
      id: "agt_owner", agentId: "agt_owner",
      provider: { providerId: "vera.markdown", config: {} },
      digest: { executorAgentId: null, modelMode: "inherit", model: null, trigger: { mode: "manual" } },
      dream: { executorAgentId: null, modelMode: "inherit", model: null, schedule: { mode: "manual" } },
      version: "legacy-version",
      memoryBodySentinel: "must-not-be-touched",
    };
    store.insert("memoryConfigs", legacy);
    await service.initializeExistingAgents();
    const migrated = store.find("memoryConfigs", "agt_owner");
    assert.deepEqual(migrated.provider, {
      providerId: "vera.markdown", placement: { runtime: "gateway" }, config: {},
    });
    assert.equal(migrated.memoryBodySentinel, "must-not-be-touched");
    const firstVersion = migrated.version;
    await service.initializeExistingAgents();
    assert.equal(store.find("memoryConfigs", "agt_owner").version, firstVersion);
    assert.equal(store.find("memoryConfigs", "_migration:memory-config-v2").status, "completed");
    assert.equal(service.listAll().some((item) => item.config?.migration === "memory-config-v2"), false);
    assert.notEqual(firstVersion, "legacy-version");
  });
});

test("provider binding version includes safe placement and placement cannot be changed by PATCH", async () => {
  await fixture(async ({ service }) => {
    const before = service.getConfig("agt_owner");
    const snapshot = service.getProviderSnapshot("agt_owner");
    assert.deepEqual(snapshot.placement, { runtime: "gateway" });
    assert.match(snapshot.bindingVersion, /^sha256:[a-f0-9]{64}$/);
    await assert.rejects(() => service.patchConfig("agt_owner", {
      provider: { providerId: "vera.markdown", placement: { runtime: "daemon", hostId: "host_a" }, config: {} },
      ifMatch: before.version,
    }), (error) => error.code === "invalid_request");
    assert.deepEqual(service.getConfig("agt_owner").config.provider.placement, { runtime: "gateway" });
  });
});
