import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRouter } from "../../src/api/router.js";
import { createUnownedAccount } from "../../src/agents/accounts.js";
import { recordAccountLoginAudit } from "../../src/agents/login-audit.js";
import { registerAgentRoutes } from "../../src/agents/routes.js";
import { createStore } from "../../src/store/store.js";

function request(router, method, url) {
  let status;
  let payload = "";
  const headers = {};
  const req = {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {},
  };
  const res = {
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus;
      for (const [name, value] of Object.entries(nextHeaders)) headers[name.toLowerCase()] = value;
    },
    end(chunk = "") { payload += chunk; },
  };
  return router.handle(req, res).then((handled) => ({
    handled,
    status,
    headers,
    json: payload ? JSON.parse(payload) : null,
  }));
}

async function fixture(fn) {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-account-detail-"));
  const store = await createStore({ dataPath, debounceMs: 1 });
  const router = createRouter();
  registerAgentRoutes(router, {
    store,
    agentStates: { ensure() {}, list() { return []; } },
  });
  try {
    await fn({ store, router });
  } finally {
    await store.close();
    await rm(dataPath, { recursive: true, force: true });
  }
}

function insertOwner(store) {
  return store.insert("agents", {
    id: "agt_account_detail",
    name: "Detail Agent",
    runtimeProfile: { schemaVersion: 1, kind: "cli", provider: "mock", model: "mock-v1" },
    runtimeBinding: {
      connection: { secretRef: "must-not-project" },
      runtimeSnapshot: {
        hostId: "host-detail",
        runtimeCapabilities: { models: ["mock-v1", "mock-v2"] },
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
    },
    runtimeRevision: "sha256:detail",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  });
}

test("Account detail is a strict safe projection with the latest 20 login audits", async () => {
  await fixture(async ({ store, router }) => {
    const owner = insertOwner(store);
    const created = createUnownedAccount(store, { name: "Detail" });
    store.update("accounts", created.account.id, {
      ownerAgentId: owner.id,
      activeAgentId: owner.id,
      presence: "online",
      workspace: {
        accountId: created.account.id,
        hostId: "host-detail",
        path: "/srv/private/project",
        status: "ready",
        policy: { allow: ["read"] },
        lastValidatedAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
    });
    for (let index = 0; index < 25; index += 1) {
      recordAccountLoginAudit(store, {
        accountId: created.account.id,
        agentId: owner.id,
        event: "login",
        result: "succeeded",
        reasonCode: null,
        createdAt: `2026-07-18T00:00:${String(index).padStart(2, "0")}.000Z`,
      });
    }

    const response = await request(router, "GET", `/api/accounts/${created.account.id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.json).sort(), [
      "account", "activeAgent", "modelOptions", "ownerAgent", "recentLogins",
    ]);
    assert.deepEqual(response.json.modelOptions, ["mock-v1", "mock-v2"]);
    assert.deepEqual(response.json.account.workspace, {
      accountId: created.account.id,
      hostId: "host-detail",
      status: "ready",
      lastValidatedAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    });
    assert.equal("path" in response.json.account.workspace, false);
    assert.equal("policy" in response.json.account.workspace, false);
    assert.equal("accessKeyHash" in response.json.account, false);
    assert.equal("loginAudits" in response.json.account, false);
    assert.equal("runtimeBinding" in response.json.ownerAgent, false);
    assert.deepEqual(response.json.ownerAgent, response.json.activeAgent);
    assert.equal(response.json.recentLogins.length, 20);
    assert.equal(response.json.recentLogins[0].createdAt, "2026-07-18T00:00:24.000Z");
    assert.equal(response.json.recentLogins[19].createdAt, "2026-07-18T00:00:05.000Z");
    for (const audit of response.json.recentLogins) {
      assert.deepEqual(Object.keys(audit).sort(), [
        "accountId", "agentId", "createdAt", "event", "id", "reasonCode", "result",
      ]);
    }
  });
});

test("rotating and revoking an Account key append safe session-revoked audits", async () => {
  await fixture(async ({ store, router }) => {
    const owner = insertOwner(store);
    const created = createUnownedAccount(store, { name: "Revoke" });
    store.update("accounts", created.account.id, {
      ownerAgentId: owner.id,
      activeAgentId: owner.id,
      presence: "online",
    });

    const rotated = await request(router, "POST", `/api/accounts/${created.account.id}/access-key/rotate`);
    assert.equal(rotated.status, 200);
    assert.ok(rotated.json.accessKey);
    store.update("accounts", created.account.id, { activeAgentId: owner.id, presence: "online" });
    const revoked = await request(router, "DELETE", `/api/accounts/${created.account.id}/access-key`);
    assert.equal(revoked.status, 200);

    const detail = await request(router, "GET", `/api/accounts/${created.account.id}`);
    const revocations = detail.json.recentLogins.map(({ agentId, event, result, reasonCode }) => ({
      agentId, event, result, reasonCode,
    })).sort((left, right) => left.reasonCode.localeCompare(right.reasonCode));
    assert.deepEqual(revocations, [
      {
        agentId: owner.id,
        event: "session_revoked",
        result: "succeeded",
        reasonCode: "access_key_revoked",
      },
      {
        agentId: owner.id,
        event: "session_revoked",
        result: "succeeded",
        reasonCode: "access_key_rotated",
      },
    ]);
    assert.equal(JSON.stringify(detail.json).includes(created.accessKey), false);
    assert.equal(JSON.stringify(detail.json).includes(rotated.json.accessKey), false);
  });
});
