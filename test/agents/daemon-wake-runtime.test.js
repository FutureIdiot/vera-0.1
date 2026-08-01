import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRouter } from "../../src/api/router.js";
import { createUnownedAccount } from "../../src/agents/accounts.js";
import { createDaemonWakeRuntime } from "../../src/agents/daemon-wake-runtime.js";
import { registerAgentRoutes } from "../../src/agents/routes.js";
import { createStore } from "../../src/store/store.js";

function request(router, method, url, body) {
  let status;
  let payload = "";
  const req = {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
  const res = {
    writeHead(nextStatus) { status = nextStatus; },
    end(chunk = "") { payload += chunk; },
  };
  return router.handle(req, res).then(() => ({ status, json: payload ? JSON.parse(payload) : null }));
}

async function fixture() {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-daemon-wake-"));
  const store = await createStore({ dataPath, debounceMs: 1 });
  const created = createUnownedAccount(store, { name: "Wake Account" });
  store.update("accounts", created.account.id, {
    ownerAgentId: "agt_wake",
    presence: "offline",
    activeAgentId: null,
    runtimeCapabilities: null,
  });
  const controlService = {
    async authenticateAgent() { return { agent: { id: "agt_wake" } }; },
  };
  const wakeRuntime = createDaemonWakeRuntime({ store, controlService, keepaliveMs: 60000 });
  return { dataPath, store, accountId: created.account.id, wakeRuntime };
}

test("Account wake requires the owner supervisor and delivers one wake event", async () => {
  const fixtureState = await fixture();
  const { dataPath, store, accountId, wakeRuntime } = fixtureState;
  try {
    const frames = [];
    const closeListeners = [];
    const req = {
      url: `/api/agent/wake-events?accountId=${accountId}`,
      headers: { authorization: "Bearer vat_wake" },
      on(type, listener) { if (type === "close") closeListeners.push(listener); },
    };
    const res = {
      writeHead(status) { assert.equal(status, 200); },
      write(frame) { frames.push(frame); },
      flushHeaders() {},
      end() {},
    };
    await wakeRuntime.openEvents(req, res);
    const router = createRouter();
    registerAgentRoutes(router, {
      store,
      controlService: { authenticateAgent: async () => ({ agent: { id: "agt_wake" } }) },
      daemonWakeRuntime: wakeRuntime,
      agentStates: { list() { return []; } },
    });

    const queued = await request(router, "POST", `/api/accounts/${accountId}/wake`, {});
    assert.equal(queued.status, 202);
    assert.equal(queued.json.wake.state, "queued");
    assert.match(frames.join(""), /account\.wake\.requested/u);
    assert.match(frames.join(""), new RegExp(queued.json.wake.requestId, "u"));

    store.update("accounts", accountId, { presence: "online", activeAgentId: "agt_wake" });
    const online = await request(router, "POST", `/api/accounts/${accountId}/wake`, {});
    assert.deepEqual(online, { status: 200, json: { wake: { requestId: null, state: "online" } } });
    closeListeners.forEach((listener) => listener());
  } finally {
    await store.close();
    await rm(dataPath, { recursive: true, force: true });
  }
});

test("Account wake fails with wake_unavailable when the host supervisor is absent", async () => {
  const fixtureState = await fixture();
  const { dataPath, store, accountId } = fixtureState;
  try {
    const wakeRuntime = createDaemonWakeRuntime({
      store,
      controlService: { authenticateAgent: async () => ({ agent: { id: "agt_wake" } }) },
    });
    const router = createRouter();
    registerAgentRoutes(router, {
      store,
      controlService: { authenticateAgent: async () => ({ agent: { id: "agt_wake" } }) },
      daemonWakeRuntime: wakeRuntime,
      agentStates: { list() { return []; } },
    });
    const response = await request(router, "POST", `/api/accounts/${accountId}/wake`, {});
    assert.equal(response.status, 503);
    assert.deepEqual(response.json.error.code, "wake_unavailable");
  } finally {
    await store.close();
    await rm(dataPath, { recursive: true, force: true });
  }
});
