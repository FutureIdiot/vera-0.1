import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventHub } from "../../src/api/sse.js";
import { updateAccountModel } from "../../src/agents/account-models.js";
import { createUnownedAccount } from "../../src/agents/accounts.js";
import { createStore } from "../../src/store/store.js";

async function fixture(kind, run) {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-account-models-"));
  const store = await createStore({ dataPath, debounceMs: 1 });
  const hub = createEventHub({ bufferSize: 20 });
  try {
    const agent = store.insert("agents", {
      id: `agt_models_${kind}`,
      name: "Models",
      runtimeProfile: { schemaVersion: 1, kind, provider: "mock", model: "model-a" },
      runtimeBinding: {
        connection: {},
        runtimeSnapshot: {
          hostId: "host-models",
          runtimeCapabilities: { models: ["model-a", "model-b"] },
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
      },
      runtimeRevision: "sha256:models",
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    });
    const created = createUnownedAccount(store, { name: "Models" });
    const account = store.update("accounts", created.account.id, {
      ownerAgentId: agent.id,
      model: "model-a",
      modelVersion: 1,
    });
    await run({ store, hub, agent, account });
  } finally {
    await store.close();
    await rm(dataPath, { recursive: true, force: true });
  }
}

function activeSession(store, { id, accountId, agentId, generation = 1 }) {
  return store.insert("agentSessions", {
    id,
    spaceSessionId: `sps_${id}`,
    accountId,
    agentId,
    status: "active",
    generation,
    context: {
      checkpointVersion: 0,
      estimatedInputTokens: 12,
      effectiveLimitTokens: 100,
      pressureRatio: 0.12,
      measurement: "estimate",
    },
    checkpoints: [],
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
  });
}

test("Account model CAS rotates every active CLI generation and is retry-idempotent", async () => {
  await fixture("cli", async ({ store, hub, agent, account }) => {
    const first = activeSession(store, { id: "ags_model_first", accountId: account.id, agentId: agent.id });
    const second = activeSession(store, { id: "ags_model_second", accountId: account.id, agentId: agent.id });
    store.insert("providerBindings", {
      id: "pbd_model_first",
      agentSessionId: first.id,
      generation: 1,
      accountId: account.id,
      providerFingerprint: "sha256:old",
      providerState: { threadId: "thread-old" },
      version: 1,
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    });
    const events = [];
    const unsubscribe = hub.subscribe({ write(frame) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (data) events.push(JSON.parse(data.slice(6)));
    } });
    try {
      const updated = updateAccountModel(store, account.id, { model: "model-b", ifVersion: 1 }, {
        hub,
        now: () => "2026-07-23T01:00:00.000Z",
      });
      assert.equal(updated.model, "model-b");
      assert.equal(updated.modelVersion, 2);
      assert.equal(store.find("agentSessions", first.id).generation, 2);
      assert.equal(store.find("agentSessions", second.id).generation, 2);
      assert.equal(store.list("providerBindings").some((binding) =>
        binding.agentSessionId === first.id && binding.generation === 2), false);
      assert.equal(events.filter((event) => event.type === "account.upserted").length, 1);

      const replay = updateAccountModel(store, account.id, { model: "model-b", ifVersion: 1 }, { hub });
      assert.equal(replay.modelVersion, 2);
      assert.equal(store.find("agentSessions", first.id).generation, 2);
      assert.equal(events.filter((event) => event.type === "account.upserted").length, 1);
      assert.throws(
        () => updateAccountModel(store, account.id, { model: "model-a", ifVersion: 1 }),
        (error) => error.code === "conflict" && error.details?.reason === "version_mismatch",
      );
    } finally {
      unsubscribe();
    }
  });
});

test("Account model rotation creates an empty API history for the new generation", async () => {
  await fixture("api", async ({ store, agent, account }) => {
    const session = activeSession(store, { id: "ags_model_api", accountId: account.id, agentId: agent.id });
    store.insert("apiHistories", {
      id: "aph_model_old",
      agentSessionId: session.id,
      generation: 1,
      version: 1,
      checkpoint: null,
      turns: [{ input: { sourceMessageId: "msg_old" }, assistant: [{ messageId: "msg_reply", content: "old" }] }],
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    });

    updateAccountModel(store, account.id, { model: "model-b", ifVersion: 1 });
    const next = store.list("apiHistories").find((history) =>
      history.agentSessionId === session.id && history.generation === 2);
    assert.equal(next.version, 0);
    assert.deepEqual(next.turns, []);
    assert.equal(next.checkpoint, null);
  });
});

test("Account model update rejects unavailable choices and active work without mutation", async () => {
  await fixture("cli", async ({ store, agent, account }) => {
    assert.throws(
      () => updateAccountModel(store, account.id, { model: "model-c", ifVersion: 1 }),
      (error) => error.code === "model_unavailable",
    );
    const run = store.insert("runs", {
      id: "run_model_busy", accountId: account.id, agentId: agent.id, status: "pending",
    });
    assert.throws(
      () => updateAccountModel(store, account.id, { model: "model-b", ifVersion: 1 }),
      (error) => error.code === "account_busy",
    );
    store.update("runs", run.id, { status: "completed" });
    store.insert("contextCompactionJobs", {
      id: "ccj_model_busy",
      status: "queued",
      targets: [{ accountId: account.id, status: "queued" }],
    });
    assert.throws(
      () => updateAccountModel(store, account.id, { model: "model-b", ifVersion: 1 }),
      (error) => error.code === "account_busy",
    );
    assert.equal(store.find("accounts", account.id).model, "model-a");
    assert.equal(store.find("accounts", account.id).modelVersion, 1);
  });
});
