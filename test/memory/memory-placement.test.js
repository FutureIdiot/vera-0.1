import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/core/config.js";
import { createStore } from "../../src/store/store.js";
import { ensureUnitBindings } from "../../src/agents/unit-bindings.js";
import { createRouter } from "../../src/api/router.js";
import { createMemoryConfigService } from "../../src/memory/memory-config.js";
import { registerMemoryRoutes } from "../../src/memory/routes.js";

async function statusRequest(router, agentId) {
  let status;
  let payload;
  await router.handle({ method: "GET", url: `/api/agents/${agentId}/memory/_status` }, {
    writeHead(code) { status = code; },
    end(body) { payload = body ? JSON.parse(body) : null; },
  });
  return { status, payload };
}

async function listRequest(router, agentId) {
  let status;
  let payload;
  await router.handle({ method: "GET", url: `/api/agents/${agentId}/memory` }, {
    setHeader() {},
    writeHead(code) { status = code; },
    end(body) { payload = body ? JSON.parse(body) : null; },
  });
  return { status, payload };
}

test("status projects configured placement and never exposes or probes a non-gateway vault", async () => {
  const root = await mkdtemp(join(tmpdir(), "vera-memory-placement-test-"));
  const config = loadConfig({ VERA_DATA_PATH: join(root, "data"), VERA_MEMORY_VAULT_PATH: join(root, "private-vault") });
  const store = await createStore({ dataPath: config.dataPath, debounceMs: 5 });
  store.insert("agents", { id: "agt_owner", name: "Owner" });
  const configService = createMemoryConfigService({ store, config });
  await configService.initializeExistingAgents();
  ensureUnitBindings(store, "agt_owner");
  let vaultCalls = 0;
  const router = createRouter();
  registerMemoryRoutes(router, {
    store,
    configService,
    memory: { listWithDiagnostics: async () => { vaultCalls += 1; return { memories: [], errors: [], index: null }; } },
    retrieval: {},
  });

  try {
    let result = await statusRequest(router, "agt_owner");
    assert.equal(result.status, 200);
    assert.deepEqual(result.payload.provider.placement, { runtime: "gateway" });
    assert.equal(JSON.stringify(result.payload).includes(config.memory.vaultPath), false);
    assert.equal(vaultCalls, 1);

    const record = store.find("memoryConfigs", "agt_owner");
    store.update("memoryConfigs", "agt_owner", {
      provider: { providerId: "vera.markdown", placement: { runtime: "daemon", hostId: "host_a" }, config: {} },
    });
    result = await statusRequest(router, "agt_owner");
    assert.equal(result.status, 200);
    assert.deepEqual(result.payload.provider.placement, { runtime: "daemon", hostId: "host_a" });
    assert.equal(result.payload.provider.state, "unavailable");
    assert.equal("location" in result.payload.provider, false);
    assert.equal(vaultCalls, 1);
    const blocked = await listRequest(router, "agt_owner");
    assert.equal(blocked.status, 503);
    assert.equal(blocked.payload.error.code, "memory_provider_unavailable");
    assert.equal(vaultCalls, 1);
    assert.equal(record.provider.placement.runtime, "gateway");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
