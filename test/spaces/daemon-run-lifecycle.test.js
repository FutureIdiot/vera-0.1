import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventHub } from "../../src/api/sse.js";
import { createAgentStateTracker } from "../../src/agents/agent-state.js";
import { createStore } from "../../src/store/store.js";
import { getActiveContext } from "../../src/spaces/context-sessions.js";
import { createDaemonRunLifecycle } from "../../src/spaces/daemon-run-lifecycle.js";

const CONFIG = {
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
    role: "root",
    rootRunId: "run_antigravity",
    parentRunId: null,
    depth: 0,
    outputPolicy: "space",
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

test("Space approve policy returns allow without creating an Approval", async () => {
  await fixture(async ({ store, hub, agent, account, space, run }) => {
    store.update("spaces", space.id, {
      seats: [{
        accountId: account.id,
        responseMode: "default",
        approvalPolicy: "approve",
      }],
    });
    const lifecycle = createDaemonRunLifecycle({ store, hub, config: CONFIG });
    const since = hub.currentSeq();
    const result = lifecycle.createApproval({
      account,
      agent,
      run: { ...run, outputPolicy: "source" },
      input: { prompt: "Allow?", options: ["allow", "deny"] },
    });

    assert.deepEqual(result, { approval: null, answer: "allow" });
    assert.equal(store.list("approvals").length, 0);
    assert.deepEqual(hub.replaySince(since), []);
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
        usage: {
          inputTokens: 28000,
          outputTokens: 10,
          totalTokens: 28010,
          contextWindowTokens: 50000,
        },
      },
    });
    assert.equal(result.run.status, "completed");
    const session = store.find("agentSessions", agentSession.id);
    assert.equal(session.context.estimatedInputTokens, 28000);
    assert.equal(session.context.effectiveLimitTokens, 32768);
    assert.equal(session.context.contextWindowTokens, 50000);
    assert.equal(session.context.windowMeasurement, "provider_reported");
    assert.equal(session.context.measurement, "provider_reported");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(compacted.length, 1);
    assert.equal(compacted[0].agentId, agent.id);
  });
});

test("failed public Root persists the concrete provider error and marks partial output failed", async () => {
  await fixture(async ({ store, hub, agent, account, run }) => {
    const lifecycle = createDaemonRunLifecycle({ store, hub, config: CONFIG });
    lifecycle.appendDelta({
      account,
      agent,
      run,
      input: { delta: "已经生成的部分回答" },
    });
    const since = hub.currentSeq();
    const result = lifecycle.updateRun({
      account,
      agent,
      run,
      input: {
        status: "failed",
        error: {
          code: "quota_exhausted",
          message: "Antigravity: credits exhausted; resets in 2h",
        },
      },
    });

    assert.equal(result.run.status, "failed");
    assert.deepEqual(result.run.error, {
      code: "quota_exhausted",
      message: "Antigravity: credits exhausted; resets in 2h",
    });
    const reply = store.list("messages").find((message) => message.runId === run.id);
    assert.equal(reply.content, "已经生成的部分回答");
    assert.equal(reply.status, "failed");
    const activity = store.list("activities").find((item) =>
      item.runId === run.id && item.kind === "error");
    assert.equal(activity.summary, "Antigravity: credits exhausted; resets in 2h");
    assert.equal(activity.detail, "错误代码：quota_exhausted");
    assert.equal(activity.toolStatus, "failed");
    assert.deepEqual(
      hub.replaySince(since).map((event) => event.type),
      ["message.completed", "activity.created", "run.ended"],
    );
  });
});

test("API Root exposes a commit checkpoint before terminal history completion", async () => {
  await fixture(async ({ store, hub, agent, account, run }) => {
    store.update("agents", agent.id, {
      runtimeProfile: { ...agent.runtimeProfile, kind: "api" },
    });
    const lifecycle = createDaemonRunLifecycle({ store, hub, config: CONFIG });
    const waiting = lifecycle.updateRun({
      account,
      agent: store.find("agents", agent.id),
      run,
      input: { status: "completed" },
    });
    assert.equal(waiting.awaitingCommit, true);
    assert.equal(store.find("runs", run.id).status, "running");
    store.update("runs", run.id, { apiResultVersion: 1 });
    const completed = lifecycle.updateRun({
      account,
      agent: store.find("agents", agent.id),
      run: store.find("runs", run.id),
      input: { status: "completed" },
    });
    assert.equal(completed.run.status, "completed");
  });
});

test("Root completion waits for active descendants before becoming terminal", async () => {
  await fixture(async ({ store, hub, agent, account, run }) => {
    store.insert("runs", {
      ...structuredClone(run),
      id: "run_child",
      rootRunId: run.id,
      parentRunId: run.id,
      role: "child",
      depth: 1,
      outputPolicy: "source",
      agentSessionId: null,
      contextGeneration: null,
      status: "running",
    });
    const lifecycle = createDaemonRunLifecycle({ store, hub, config: CONFIG });
    const waiting = lifecycle.updateRun({
      account,
      agent,
      run,
      input: { status: "completed", usage: { inputTokens: 10 } },
    });
    assert.equal(waiting.awaitingChildren, true);
    assert.equal(store.find("runs", run.id).status, "running");

    store.update("runs", "run_child", {
      status: "completed",
      endedAt: "2026-07-29T00:00:01.000Z",
    });
    const completed = lifecycle.updateRun({
      account,
      agent,
      run,
      input: { status: "completed", usage: { inputTokens: 10 } },
    });
    assert.equal(completed.run.status, "completed");
  });
});

test("Root failure cancels its active descendant subtree", async () => {
  await fixture(async ({ store, hub, agent, account, run }) => {
    store.insert("runs", {
      ...structuredClone(run),
      id: "run_child",
      rootRunId: run.id,
      parentRunId: run.id,
      role: "child",
      depth: 1,
      outputPolicy: "source",
      agentSessionId: null,
      contextGeneration: null,
      status: "running",
    });
    const dispatched = [];
    const lifecycle = createDaemonRunLifecycle({
      store,
      hub,
      config: CONFIG,
      dispatchRunCancel: (child) => dispatched.push(child.id),
    });
    lifecycle.updateRun({
      account,
      agent,
      run,
      input: { status: "failed", error: { code: "provider_error", message: "failed" } },
    });
    assert.equal(store.find("runs", "run_child").status, "cancelled");
    assert.deepEqual(dispatched, ["run_child"]);
  });
});

test("owner cancellation clears the exact Run AgentState before daemon cleanup retries", async () => {
  await fixture(async ({ store, hub, agent, account, space, run }) => {
    const agentStates = createAgentStateTracker({ hub });
    const authority = {
      agentId: agent.id,
      ownerAgentId: account.ownerAgentId,
      accountId: account.id,
      spaceId: space.id,
    };
    agentStates.declare(authority, {
      agentId: agent.id,
      accountId: account.id,
      spaceId: space.id,
      status: "on_task",
      detail: "",
    });
    const lifecycle = createDaemonRunLifecycle({
      store,
      hub,
      config: CONFIG,
      agentStates,
    });

    const cancelled = lifecycle.cancelRun(run.id);

    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(
      agentStates.list({ agentId: agent.id, accountId: account.id, spaceId: space.id })
        .map(({ lastActiveAt, ...state }) => state),
      [{
        agentId: agent.id,
        accountId: account.id,
        spaceId: space.id,
        status: "idle",
        detail: "",
      }],
    );
  });
});
