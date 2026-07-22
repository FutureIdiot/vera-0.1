import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "../../src/store/store.js";
import { createRouter } from "../../src/api/router.js";
import { registerAgentRoutes } from "../../src/agents/routes.js";
import { createAgent, listAgents } from "../../src/agents/agents.js";
import {
  createAccount,
  createUnownedAccount,
  listAccounts,
  revokeAccountAccessKey,
  rotateAccountAccessKey,
  updateAccount,
} from "../../src/agents/accounts.js";

const ISO = "2026-07-17T00:00:00.000Z";

async function writeFixture(dataPath, files) {
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(dataPath, name), JSON.stringify(value, null, 2), "utf8");
  }
}

function legacyFiles() {
  return {
    "agents.json": [
      { id: "agt_a", name: "A", createdAt: ISO, updatedAt: ISO },
      { id: "agt_b", name: "B", createdAt: ISO, updatedAt: ISO },
    ],
    "accounts.json": [
      {
        id: "acc_a", owningAgentId: "agt_a", name: "Account A", kind: "cli", provider: "codex",
        connection: { command: "codex" }, model: "gpt-a", authorizedAgentIds: ["agt_a"],
        createdAt: ISO, updatedAt: ISO,
      },
      {
        id: "acc_b", owningAgentId: "agt_b", name: "Account B", kind: "api", provider: "ollama",
        connection: { baseUrl: "http://127.0.0.1:11434" }, model: "model-b", authorizedAgentIds: ["agt_b"],
        createdAt: ISO, updatedAt: ISO,
      },
    ],
    "spaces.json": [{
      id: "spc_one",
      name: "One",
      seats: [
        { agentId: "agt_a", responseMode: "silent", respondTo: ["user", "agt_b"], blockAgentIds: ["agt_b"] },
        { agentId: "agt_b", responseMode: "default" },
      ],
      notifications: { mode: "agentMessages", includeActivityErrors: true },
      createdAt: ISO,
    }],
    "agentSessions.json": [{
      id: "ags_a", spaceSessionId: "sps_one", agentId: "agt_a", status: "active", generation: 1,
      context: {}, checkpoints: [], createdAt: ISO, updatedAt: ISO,
    }],
    "runs.json": [{
      id: "run_a", agentId: "agt_a", accountId: "acc_a", spaceId: "spc_one", spaceSessionId: "sps_one",
      agentSessionId: "ags_a", role: "main", status: "completed", createdAt: ISO,
    }],
    "messages.json": [
      {
        id: "msg_a", spaceId: "spc_one", spaceSessionId: "sps_one",
        author: { type: "agent", agentId: "agt_a" }, target: { type: "direct", agentIds: ["agt_b"] },
        content: "hello", runId: "run_a", status: "completed", createdAt: ISO,
      },
    ],
    "providerBindings.json": [{
      id: "pbd_a", agentSessionId: "ags_a", generation: 1, accountId: "acc_a",
      providerFingerprint: "sha256:old", providerState: { threadId: "thread-a" }, version: 1,
      createdAt: ISO, updatedAt: ISO,
    }],
    "meta.json": {
      _seq: 20,
      eventSeqWatermark: 0,
      contextSessionsMigrationVersion: 1,
      federationAccountMigrationVersion: 0,
    },
  };
}

test("Phase 5.5 migration atomically moves runtime identity to Agent and Account identity to seats/sessions", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-federation-account-"));
  await writeFixture(dataPath, legacyFiles());
  try {
    const store = await createStore({ dataPath, debounceMs: 5 });
    const rawAgent = store.find("agents", "agt_a");
    assert.deepEqual(rawAgent.runtimeProfile, {
      schemaVersion: 1, kind: "cli", provider: "codex", model: "gpt-a",
    });
    assert.deepEqual(rawAgent.runtimeBinding, { connection: { command: "codex" } });
    assert.match(rawAgent.runtimeRevision, /^sha256:[0-9a-f]{64}$/u);
    assert.equal("runtimeBinding" in listAgents(store)[0], false, "public Agent projection hides local binding");

    const account = store.find("accounts", "acc_a");
    assert.equal(account.ownerAgentId, "agt_a");
    for (const legacy of ["owningAgentId", "kind", "provider", "connection", "authorizedAgentIds"]) {
      assert.equal(legacy in account, false, `${legacy} is removed from Account`);
    }
    assert.equal(account.model, "gpt-a");
    assert.equal(account.modelVersion, 1);
    assert.equal(account.activeAgentId, null);
    assert.equal(account.runtimeCapabilities, null);
    assert.equal(account.accessKeyState, "revoked");
    assert.equal(account.accessKeyVersion, 0);
    assert.equal("accessKeyHash" in listAccounts(store)[0], false);

    const space = store.find("spaces", "spc_one");
    assert.deepEqual(space.seats, [
      {
        accountId: "acc_a", responseMode: "silent", respondTo: ["user", "acc_b"], blockAccountIds: ["acc_b"],
      },
      { accountId: "acc_b", responseMode: "default" },
    ]);
    assert.equal(space.notifications.mode, "accountMessages");
    assert.equal(store.find("agentSessions", "ags_a").accountId, "acc_a");

    const run = store.find("runs", "run_a");
    assert.equal(run.runtimeRevision, rawAgent.runtimeRevision);
    assert.equal(run.effectiveModel, "gpt-a");
    assert.equal(run.delegated, false);
    const message = store.find("messages", "msg_a");
    assert.deepEqual(message.author, { type: "account", accountId: "acc_a" });
    assert.equal(message.accountNameSnapshot, "Account A");
    assert.equal(message.executingAgentId, "agt_a");
    assert.equal(message.effectiveModel, "gpt-a");
    assert.equal(message.delegated, false);
    assert.deepEqual(message.target, { type: "direct", accountIds: ["acc_b"] });
    await store.close();

    const meta = JSON.parse(await readFile(join(dataPath, "meta.json"), "utf8"));
    assert.equal(meta.federationAccountMigrationVersion, 1);
    assert.equal(meta.accountModelSelectionMigrationVersion, 1);

    const reopened = await createStore({ dataPath, debounceMs: 5 });
    assert.equal(reopened.list("agents").length, 2);
    assert.equal(reopened.list("accounts").length, 2);
    assert.equal(reopened.find("accounts", "acc_a").ownerAgentId, "agt_a");
    await reopened.close();
  } finally {
    await rm(dataPath, { recursive: true, force: true });
  }
});

test("ambiguous Agent 1:N Account data blocks before any file or backup is written", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-federation-ambiguous-"));
  const files = legacyFiles();
  files["agents.json"] = [files["agents.json"][0]];
  files["accounts.json"] = [
    files["accounts.json"][0],
    { ...files["accounts.json"][0], id: "acc_a_second", name: "Second" },
  ];
  files["spaces.json"] = [];
  files["agentSessions.json"] = [];
  files["runs.json"] = [];
  files["messages.json"] = [];
  files["providerBindings.json"] = [];
  await writeFixture(dataPath, files);
  const beforeNames = (await readdir(dataPath)).sort();
  const before = new Map(await Promise.all(beforeNames.map(async (name) => [name, await readFile(join(dataPath, name), "utf8")])));
  try {
    await assert.rejects(
      createStore({ dataPath, debounceMs: 5 }),
      /Agent agt_a owns multiple Accounts/u,
    );
    const afterNames = (await readdir(dataPath)).sort();
    assert.deepEqual(afterNames, beforeNames, "preflight failure creates no .legacy files");
    for (const name of afterNames) {
      assert.equal(await readFile(join(dataPath, name), "utf8"), before.get(name), `${name} is unchanged`);
    }
  } finally {
    await rm(dataPath, { recursive: true, force: true });
  }
});

test("transitional Agent create bridge persists one portable runtime and rejects a second Account", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-federation-create-"));
  try {
    const store = await createStore({ dataPath, debounceMs: 5 });
    const created = createAgent(store, {
      name: "Portable",
      kind: "cli",
      provider: "codex",
      model: "gpt-test",
      connection: { command: "codex", secretRef: "local-only" },
    });
    assert.deepEqual(created.agent.runtimeProfile, {
      schemaVersion: 1, kind: "cli", provider: "codex", model: "gpt-test",
    });
    assert.equal("runtimeBinding" in created.agent, false);
    assert.equal(JSON.stringify(created.agent).includes("local-only"), false);
    assert.equal(created.account.ownerAgentId, created.agent.id);
    assert.equal(created.account.model, "gpt-test");
    assert.equal(created.account.modelVersion, 1);
    assert.throws(
      () => createAccount(store, created.agent.id, { name: "Second" }),
      (error) => error.code === "conflict",
    );
    assert.throws(
      () => updateAccount(store, created.account.id, { provider: "ollama" }),
      (error) => error.code === "invalid_request",
    );
    assert.equal(updateAccount(store, created.account.id, { name: "Renamed" }).name, "Renamed");
    await store.close();
  } finally {
    await rm(dataPath, { recursive: true, force: true });
  }
});

test("Account access keys are one-time values backed only by salted scrypt material", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-account-key-"));
  try {
    const store = await createStore({ dataPath, debounceMs: 5 });
    assert.throws(
      () => createUnownedAccount(store, { name: "Bad", provider: "forbidden" }),
      (error) => error.code === "invalid_request",
    );
    const first = createUnownedAccount(store, { name: "Ready to enroll" });
    assert.match(first.accessKey, /^vak_[A-Za-z0-9_-]{43}$/u);
    assert.equal(first.account.ownerAgentId, null);
    assert.equal(first.account.model, null);
    assert.equal(first.account.modelVersion, 0);
    assert.equal(first.account.accessKeyState, "active");
    assert.equal(first.account.accessKeyVersion, 1);
    assert.equal("accessKeyHash" in first.account, false);
    const storedFirst = store.find("accounts", first.account.id);
    assert.equal(storedFirst.accessKeyHash.algorithm, "scrypt");
    assert.notEqual(storedFirst.accessKeyHash.digest, first.accessKey);
    assert.notEqual(storedFirst.accessKeyHash.salt, first.accessKey);
    const firstDigest = storedFirst.accessKeyHash.digest;

    const rotated = rotateAccountAccessKey(store, first.account.id);
    assert.notEqual(rotated.accessKey, first.accessKey);
    assert.equal(rotated.account.accessKeyVersion, 2);
    assert.equal(rotated.account.accessKeyState, "active");
    assert.notEqual(store.find("accounts", first.account.id).accessKeyHash.digest, firstDigest);
    assert.equal("accessKeyHash" in rotated.account, false);

    const revoked = revokeAccountAccessKey(store, first.account.id);
    assert.equal(revoked.accessKeyState, "revoked");
    assert.equal(revoked.accessKeyVersion, 3);
    assert.equal(store.find("accounts", first.account.id).accessKeyHash, null);
    assert.equal("accessKeyHash" in revoked, false);
    await store.close();

    const persisted = await readFile(join(dataPath, "accounts.json"), "utf8");
    assert.equal(persisted.includes(first.accessKey), false);
    assert.equal(persisted.includes(rotated.accessKey), false);
  } finally {
    await rm(dataPath, { recursive: true, force: true });
  }
});

test("one-time Account key HTTP responses are marked no-store", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-account-key-http-"));
  try {
    const store = await createStore({ dataPath, debounceMs: 5 });
    const router = createRouter();
    registerAgentRoutes(router, {
      store,
      agentStates: { ensure() {}, list() { return []; } },
    });
    async function request(method, url, body) {
      const headers = {};
      let status = null;
      let payload = "";
      const req = {
        method,
        url,
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield Buffer.from(JSON.stringify(body));
        },
      };
      const res = {
        setHeader(name, value) { headers[name.toLowerCase()] = value; },
        writeHead(nextStatus, nextHeaders = {}) {
          status = nextStatus;
          for (const [name, value] of Object.entries(nextHeaders)) headers[name.toLowerCase()] = value;
        },
        end(chunk = "") { payload += chunk; },
      };
      assert.equal(await router.handle(req, res), true);
      return { status, headers, json: payload ? JSON.parse(payload) : null };
    }
    const created = await request("POST", "/api/accounts", { name: "HTTP" });
    assert.equal(created.status, 201);
    assert.equal(created.headers["cache-control"], "no-store");
    assert.ok(created.json.accessKey);
    const rotated = await request("POST", `/api/accounts/${created.json.account.id}/access-key/rotate`);
    assert.equal(rotated.status, 200);
    assert.equal(rotated.headers["cache-control"], "no-store");
    assert.ok(rotated.json.accessKey);
    await store.close();
  } finally {
    await rm(dataPath, { recursive: true, force: true });
  }
});
