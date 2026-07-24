import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recoverAccountPresence } from "../../src/agents/account-presence.js";
import { createUnownedAccount } from "../../src/agents/accounts.js";
import { createStore } from "../../src/store/store.js";

test("Gateway boot recovers persisted online Accounts before serving requests", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-account-presence-"));
  let store = await createStore({ dataPath, debounceMs: 1 });
  try {
    const offline = createUnownedAccount(store, { name: "Already offline" }).account;
    const online = createUnownedAccount(store, { name: "Persisted online" }).account;
    store.update("accounts", online.id, {
      ownerAgentId: "agt_owner",
      presence: "online",
      lastSeenAt: "2026-07-22T15:29:08.068Z",
      activeAgentId: "agt_owner",
      model: "gpt-5.4-mini",
      modelVersion: 3,
      runtimeCapabilities: { models: ["gpt-5.4-mini"], tools: [] },
      workspace: {
        accountId: online.id,
        hostId: "host_mac",
        path: "/srv/vera/project",
        status: "ready",
        policy: {},
      },
      loginAudits: [{ id: "ala_login", event: "login" }],
      updatedAt: "2026-07-22T15:29:08.068Z",
    });
    await store.close();

    store = await createStore({ dataPath, debounceMs: 1 });
    const offlineBefore = structuredClone(store.find("accounts", offline.id));
    const recovered = recoverAccountPresence(store, { now: "2026-07-24T05:00:00.000Z" });

    assert.equal(recovered, 1);
    assert.deepEqual(store.find("accounts", offline.id), offlineBefore);
    assert.deepEqual(store.find("accounts", online.id), {
      ...store.find("accounts", online.id),
      presence: "offline",
      activeAgentId: null,
      runtimeCapabilities: null,
      lastSeenAt: "2026-07-24T05:00:00.000Z",
      updatedAt: "2026-07-24T05:00:00.000Z",
    });
    const restored = store.find("accounts", online.id);
    assert.equal(restored.ownerAgentId, "agt_owner");
    assert.equal(restored.workspace.path, "/srv/vera/project");
    assert.equal(restored.model, "gpt-5.4-mini");
    assert.equal(restored.modelVersion, 3);
    assert.deepEqual(restored.loginAudits, [{ id: "ala_login", event: "login" }]);
  } finally {
    await store.close();
    await rm(dataPath, { recursive: true, force: true });
  }
});
