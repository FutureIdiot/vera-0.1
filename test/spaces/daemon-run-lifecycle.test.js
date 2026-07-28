import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventHub } from "../../src/api/sse.js";
import { createStore } from "../../src/store/store.js";
import { getActiveContext } from "../../src/spaces/context-sessions.js";
import { createDaemonRunLifecycle } from "../../src/spaces/daemon-run-lifecycle.js";

const CONFIG = {
  bubbles: { boundaryPattern: "\\n\\s*\\n", minLength: 1, maxLength: 800 },
  activity: { summaryMaxLength: 160, detailMaxLength: 2000 },
  antigravity: { contextWindowTokens: 32768, maxInputBytes: 131072 },
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

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "vera-daemon-lifecycle-"));
  const store = await createStore({ dataPath: root, debounceMs: 1 });
  const hub = createEventHub({ bufferSize: 100 });
  const agent = store.insert("agents", {
    id: "agt_antigravity",
    name: "Antigravity",
    runtimeProfile: {
      schemaVersion: 1,
      kind: "cli",
      provider: "antigravity",
      model: "gemini-3.6-flash-low",
    },
    runtimeBinding: {
      connection: {},
      runtimeSnapshot: { runtimeCapabilities: { models: ["gemini-3.6-flash-low"] } },
    },
    runtimeRevision: "sha256:antigravity",
  });
  const account = store.insert("accounts", {
    id: "acc_antigravity",
    ownerAgentId: agent.id,
    activeAgentId: agent.id,
    name: "Antigravity Account",
    presence: "online",
    model: "gemini-3.6-flash-low",
    modelVersion: 1,
    workspace: { hostId: "host-agy", path: "/srv/agy", status: "ready", policy: {} },
  });
  const space = store.insert("spaces", {
    id: "spc_antigravity",
    name: "Antigravity Space",
    seats: [{ accountId: account.id, responseMode: "default" }],
  });
  const { spaceSession, agentSession } = getActiveContext(store, {
    spaceId: space.id,
    accountId: account.id,
    agentId: agent.id,
  });
  const triggerMessage = store.insert("messages", {
    id: "msg_antigravity",
    spaceId: space.id,
    spaceSessionId: spaceSession.id,
    author: { type: "user" },
    target: { type: "broadcast" },
    content: "continue safely",
    fileIds: [],
    runId: null,
    status: "completed",
    createdAt: "2026-07-29T00:00:00.000Z",
  });
  const run = store.insert("runs", {
    id: "run_antigravity",
    role: "main",
    parentRunId: null,
    spaceId: space.id,
    spaceSessionId: spaceSession.id,
    agentSessionId: agentSession.id,
    contextGeneration: agentSession.generation,
    accountId: account.id,
    agentId: agent.id,
    runtimeRevision: agent.runtimeRevision,
    effectiveModel: account.model,
    modelVersion: account.modelVersion,
    delegated: false,
    triggerMessageId: triggerMessage.id,
    replyMessageIds: [],
    status: "running",
    executionTransport: "daemon",
    accountSessionId: "acs_antigravity",
    executionLeaseId: "exl_antigravity",
    workspaceHostId: "host-agy",
    leaseAcquiredAt: "2026-07-29T00:00:00.000Z",
    apiResultVersion: null,
    createdAt: "2026-07-29T00:00:00.000Z",
    endedAt: null,
  });
  try {
    await fn({ store, hub, agent, account, space, spaceSession, agentSession, triggerMessage, run });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("daemon binding rotation advances generation once, recompiles, and retries idempotently", async () => {
  await fixture(async ({ store, hub, agent, account, agentSession, run }) => {
    const lifecycle = createDaemonRunLifecycle({
      store,
      hub,
      config: CONFIG,
      memoryRetrieval: {
        async ensureSession() {},
        async residentIndex() { return null; },
        async searchForInjection() { return { block: null, response: { items: [], cursor: null } }; },
      },
    });
    const input = { generation: agentSession.generation, reason: "missing" };
    const first = await lifecycle.rotateProviderBinding({ account, agent, run, input });
    assert.equal(first.generation, 2);
    assert.equal(first.providerBinding, null);
    assert.match(first.promptText, /continue safely/u);
    assert.equal(store.find("agentSessions", agentSession.id).generation, 2);
    assert.equal(store.find("runs", run.id).contextGeneration, 2);
    assert.equal(store.find("agentSessions", agentSession.id).checkpoints.length, 1);
    assert.deepEqual(
      await lifecycle.rotateProviderBinding({ account, agent, run, input }),
      first,
    );
    await assert.rejects(
      lifecycle.rotateProviderBinding({
        account,
        agent,
        run: store.find("runs", run.id),
        input: { generation: 2, reason: "missing" },
      }),
      (error) => error.code === "conflict",
    );
  });
});

test("completed main CLI usage updates context pressure and schedules compaction", async () => {
  await fixture(async ({ store, hub, agent, account, agentSession, run }) => {
    const compacted = [];
    const lifecycle = createDaemonRunLifecycle({
      store,
      hub,
      config: CONFIG,
      contextCompaction: {
        async compactAgent(input) { compacted.push(input); },
      },
    });
    const result = lifecycle.updateRun({
      account,
      agent,
      run,
      input: {
        status: "completed",
        usage: { inputTokens: 28000, outputTokens: 10, totalTokens: 28010 },
      },
    });
    assert.equal(result.run.status, "completed");
    const session = store.find("agentSessions", agentSession.id);
    assert.equal(session.context.estimatedInputTokens, 28000);
    assert.equal(session.context.effectiveLimitTokens, 32768);
    assert.equal(session.context.measurement, "provider_reported");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(compacted.length, 1);
    assert.equal(compacted[0].agentId, agent.id);
  });
});
