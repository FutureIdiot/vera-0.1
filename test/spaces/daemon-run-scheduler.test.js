import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventHub } from "../../src/api/sse.js";
import { createStore } from "../../src/store/store.js";
import { getActiveContext } from "../../src/spaces/context-sessions.js";
import { createDaemonRunScheduler } from "../../src/spaces/daemon-run-scheduler.js";

const CONFIG = {
  bubbles: { boundaryPattern: "\\n\\s*\\n", minLength: 1, maxLength: 800 },
  activity: { detailMaxLength: 2000 },
  viewCompiler: {
    groupDeltaMaxMessages: 20,
    groupDeltaMaxChars: 4000,
    groupDeltaHeader: "=== recent ===",
    groupDeltaUserLabel: "User",
    groupDeltaOmittedHint: "omitted",
  },
  context: {
    defaultLimitTokens: 16384,
    warningRatio: 0.7,
    autoRatio: 0.8,
    hardRatio: 0.95,
    checkpointRecentTurns: 4,
  },
};

async function fixture(kind, fn) {
  const root = await mkdtemp(join(tmpdir(), "vera-daemon-scheduler-"));
  const store = await createStore({ dataPath: root, debounceMs: 1 });
  const hub = createEventHub({ bufferSize: 100 });
  const agent = store.insert("agents", {
    id: `agt_${kind}`,
    name: `${kind} agent`,
    runtimeProfile: { schemaVersion: 1, kind, provider: kind === "api" ? "ollama" : "codex", model: "model-a" },
    runtimeBinding: { connection: { secretCanary: "must-not-cross-wire" } },
    runtimeRevision: "sha256:runtime-a",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  });
  const account = store.insert("accounts", {
    id: `acc_${kind}`,
    ownerAgentId: agent.id,
    activeAgentId: agent.id,
    name: `${kind} account`,
    presence: "online",
    runtimeCapabilities: { tools: [] },
    workspace: { hostId: "host-a", path: "/srv/project", status: "ready", policy: { allow: ["read"] } },
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  });
  const space = store.insert("spaces", {
    id: `spc_${kind}`,
    name: "runtime",
    topic: "daemon",
    seats: [{ accountId: account.id, responseMode: "default" }],
    createdAt: "2026-07-19T00:00:00.000Z",
  });
  const { spaceSession, agentSession } = getActiveContext(store, {
    spaceId: space.id,
    accountId: account.id,
    agentId: agent.id,
  });
  const triggerMessage = store.insert("messages", {
    id: `msg_${kind}`,
    spaceId: space.id,
    spaceSessionId: spaceSession.id,
    author: { type: "user" },
    target: { type: "broadcast" },
    content: "hello daemon",
    fileIds: [],
    runId: null,
    status: "completed",
    createdAt: "2026-07-19T00:00:01.000Z",
  });
  try {
    await fn({ store, hub, agent, account, space, spaceSession, agentSession, triggerMessage });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function waitDispatch() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, daemonRuntime: { dispatchRun(value) { resolve(value); } } };
}

for (const kind of ["cli", "api"]) {
  test(`daemon scheduler freezes and dispatches typed ${kind} main Run after lease`, async () => {
    await fixture(kind, async ({ store, hub, agent, account, space, spaceSession, agentSession, triggerMessage }) => {
      const dispatched = waitDispatch();
      const scheduler = createDaemonRunScheduler({
        store,
        hub,
        config: CONFIG,
        controlService: {
          getSession() {
            return {
              id: "acs_runtime",
              agentId: agent.id,
              accountId: account.id,
              runtimeRevision: agent.runtimeRevision,
              runtimeHostId: "host-a",
            };
          },
        },
        daemonRuntime: dispatched.daemonRuntime,
        memoryRetrieval: {
          async ensureSession() {},
          async residentIndex() { return null; },
          async searchForInjection() { return { block: null, response: { items: [], cursor: null } }; },
        },
      });
      const run = scheduler.scheduleMainRun({ agent, account, space, spaceSession, agentSession, triggerMessage });
      assert.equal(run.status, "pending");
      assert.equal(run.executionTransport, "daemon");
      assert.equal(run.accountSessionId, "acs_runtime");

      const dispatch = await dispatched.promise;
      const running = store.find("runs", run.id);
      assert.equal(running.status, "running");
      assert.match(running.executionLeaseId, /^exl_/u);
      assert.equal(dispatch.accountId, account.id);
      assert.equal(dispatch.event.type, "run.requested");
      assert.equal(dispatch.event.data.input.kind, kind);
      assert.equal(dispatch.event.data.input.sessionMode, "main");
      assert.equal(dispatch.event.data.run.delegated, false);
      assert.equal("delegationContext" in dispatch.event.data, false);
      assert.equal(JSON.stringify(dispatch).includes("must-not-cross-wire"), false);
      if (kind === "cli") {
        assert.equal(typeof dispatch.event.data.input.promptText, "string");
        assert.equal("messages" in dispatch.event.data.input, false);
      } else {
        assert.ok(Array.isArray(dispatch.event.data.input.messages));
        assert.equal(dispatch.event.data.input.historyVersion, 0);
        assert.equal("promptText" in dispatch.event.data.input, false);
      }
    });
  });
}

test("daemon scheduler terminalizes a pending Run when no active Account Session remains", async () => {
  await fixture("cli", async ({ store, hub, agent, account, space, spaceSession, agentSession, triggerMessage }) => {
    const scheduler = createDaemonRunScheduler({
      store,
      hub,
      config: CONFIG,
      controlService: { getSession() { return null; } },
      daemonRuntime: { dispatchRun() { throw new Error("must not dispatch"); } },
    });
    assert.throws(
      () => scheduler.scheduleMainRun({ agent, account, space, spaceSession, agentSession, triggerMessage }),
      (error) => error.code === "account_reauthentication_required",
    );
    assert.equal(store.list("runs").length, 0);
  });
});
