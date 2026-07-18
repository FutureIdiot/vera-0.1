import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../src/store/store.js";
import { createEventHub } from "../../src/api/sse.js";
import { AdapterError } from "../../src/core/errors.js";
import { executeRun, recoverInterruptedRuns } from "../../src/spaces/run-controller.js";
import { getActiveContext } from "../../src/spaces/context-sessions.js";
import { getTimeline } from "../../src/spaces/timeline.js";
import {
  compareAndSetApiHistory,
  getApiHistory,
  getProviderBinding,
  providerFingerprintForRuntime,
  rotateContextGeneration,
} from "../../src/spaces/context-state.js";
import { withAccountExecutionLock } from "../../src/spaces/execution-lock.js";

const CONFIG = {
  bubbles: { boundaryPattern: "\\n\\s*\\n", minLength: 1, maxLength: 800 },
  activity: { detailMaxLength: 2000 },
  viewCompiler: {
    groupDeltaMaxMessages: 20,
    groupDeltaMaxChars: 4000,
    groupDeltaHeader: "=== 群内最近发言 ===",
    groupDeltaUserLabel: "用户",
    groupDeltaOmittedHint: "（更早的发言数量已达上限）",
  },
  context: {
    defaultLimitTokens: 100_000,
    warningRatio: 0.70,
    autoRatio: 0.80,
    hardRatio: 0.95,
    checkpointRecentTurns: 4,
  },
};

function waitFor(hub, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timeout waiting for event; saw types: ${seen.join(",")}`));
    }, timeoutMs);
    const unsubscribe = hub.subscribe({
      write(frame) {
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) return;
        const envelope = JSON.parse(dataLine.slice("data: ".length));
        seen.push(envelope.type);
        if (predicate(envelope)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(envelope);
        }
      },
    });
  });
}

function captureEvents(hub) {
  const events = [];
  const unsubscribe = hub.subscribe({
    write(frame) {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) events.push(JSON.parse(dataLine.slice("data: ".length)));
    },
  });
  return { events, unsubscribe };
}

function memoryRetrievalStub({ resident = null, retrieval = null } = {}) {
  return {
    async ensureSession() { return { id: "mrs_test" }; },
    async residentIndex() { return resident; },
    async searchForInjection() {
      return { block: retrieval, response: { items: [], cursor: null } };
    },
  };
}

async function fixture(fn, { kind = "cli", suffix = "a" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vera-run-controller-test-"));
  const store = await createStore({ dataPath: join(root, "data"), debounceMs: 5 });
  const hub = createEventHub({ bufferSize: 100 });
  const agent = store.insert("agents", {
    id: `agt_${suffix}`,
    name: `Agent ${suffix}`,
    runtimeProfile: { schemaVersion: 1, kind, provider: kind === "api" ? "ollama" : "codex", model: "test-model" },
    runtimeBinding: { connection: {} },
    runtimeRevision: "sha256:test-runtime",
    createdAt: "2026-07-15T00:00:00.000Z",
  });
  const account = store.insert("accounts", {
    id: `acc_${suffix}`,
    ownerAgentId: agent.id,
    name: `Account ${suffix}`,
    createdAt: "2026-07-15T00:00:00.000Z",
  });
  const space = store.insert("spaces", {
    id: `spc_${suffix}`,
    name: `Space ${suffix}`,
    topic: "context test",
    seats: [{ accountId: account.id, responseMode: "default" }],
    createdAt: "2026-07-15T00:00:00.000Z",
  });
  const { spaceSession, agentSession } = getActiveContext(store, {
    spaceId: space.id,
    accountId: account.id,
    agentId: agent.id,
  });

  function insertMessage({
    id = `msg_${suffix}_${store.list("messages").length + 1}`,
    content = "hello",
    author = { type: "user" },
    target = { type: "broadcast" },
    createdAt = new Date(Date.parse("2026-07-15T00:00:01.000Z") + store.list("messages").length * 1000).toISOString(),
  } = {}) {
    return store.insert("messages", {
      id,
      spaceId: space.id,
      spaceSessionId: spaceSession.id,
      author,
      target,
      content,
      runId: null,
      status: "completed",
      createdAt,
    });
  }

  try {
    await fn({ store, hub, agent, account, space, spaceSession, agentSession, insertMessage });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("Run pending -> running freezes space, session, agent, and account identifiers", async () => {
  await fixture(async ({ store, hub, agent, account, space, spaceSession, agentSession, insertMessage }) => {
    const triggerMessage = insertMessage();
    let release;
    let capturedContext;
    const gate = new Promise((resolve) => { release = resolve; });
    const adapter = {
      async run(ctx) {
        capturedContext = ctx;
        await gate;
        return { content: "reply" };
      },
    };
    const startedPromise = waitFor(hub, (event) => event.type === "run.started");
    const run = executeRun({
      store, hub, config: CONFIG, agent, account, space, spaceSession, agentSession,
      triggerMessage, adapter,
    });

    assert.equal(run.status, "pending");
    assert.deepEqual(
      [run.executionTransport, run.accountSessionId, run.executionLeaseId, run.workspaceHostId, run.leaseAcquiredAt],
      ["gateway-local", null, null, null, null],
    );
    assert.deepEqual(
      [run.spaceSessionId, run.agentSessionId, run.contextGeneration, run.agentId, run.accountId],
      [spaceSession.id, agentSession.id, 1, agent.id, account.id],
    );
    const started = await startedPromise;
    assert.deepEqual(
      [
        started.data.run.spaceSessionId,
        started.data.run.agentSessionId,
        started.data.run.contextGeneration,
        started.data.run.agentId,
        started.data.run.accountId,
      ],
      [spaceSession.id, agentSession.id, 1, agent.id, account.id],
    );
    assert.deepEqual(
      [
        capturedContext.spaceSessionId,
        capturedContext.agentSessionId,
        capturedContext.contextGeneration,
        capturedContext.agent.id,
        capturedContext.account.id,
      ],
      [spaceSession.id, agentSession.id, 1, agent.id, account.id],
    );
    release();
    const ended = await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === run.id);
    assert.equal(ended.data.run.status, "completed");
    assert.equal(ended.data.run.spaceSessionId, spaceSession.id);
    assert.equal(ended.data.run.agentSessionId, agentSession.id);
  });
});

test("startup recovery terminalizes orphaned Runs and their in-flight records", async () => {
  await fixture(async ({ store, agent, account, space, spaceSession, agentSession }) => {
    store.insert("runs", {
      id: "run_interrupted", agentId: agent.id, accountId: account.id, role: "main", parentRunId: null,
      spaceId: space.id, spaceSessionId: spaceSession.id, agentSessionId: agentSession.id,
      contextGeneration: 1, triggerMessageId: "msg_trigger", replyMessageIds: [], status: "running",
      createdAt: "2026-07-15T00:00:00.000Z", endedAt: null,
    });
    store.insert("messages", {
      id: "msg_streaming", spaceId: space.id, spaceSessionId: spaceSession.id,
      author: { type: "agent", agentId: agent.id }, target: { type: "broadcast" },
      content: "partial", runId: "run_interrupted", status: "streaming", createdAt: "2026-07-15T00:00:01.000Z",
    });
    store.insert("activities", {
      id: "act_pending", spaceId: space.id, spaceSessionId: spaceSession.id, runId: "run_interrupted",
      agentId: agent.id, phase: "tool", label: "work", toolStatus: "running", createdAt: "2026-07-15T00:00:01.000Z",
    });
    store.insert("approvals", {
      id: "apr_pending", spaceId: space.id, spaceSessionId: spaceSession.id, runId: "run_interrupted",
      agentId: agent.id, prompt: "approve", options: ["allow", "deny"], status: "pending", answer: null,
      createdAt: "2026-07-15T00:00:01.000Z",
    });
    recoverInterruptedRuns(store, { now: "2026-07-16T00:00:00.000Z" });
    assert.equal(store.find("runs", "run_interrupted").status, "failed");
    assert.deepEqual(store.find("runs", "run_interrupted").replyMessageIds, ["msg_streaming"]);
    assert.equal(store.find("messages", "msg_streaming").status, "failed");
    assert.equal(store.find("activities", "act_pending").toolStatus, "failed");
    assert.deepEqual(
      [store.find("approvals", "apr_pending").status, store.find("approvals", "apr_pending").answer],
      ["expired", "deny"],
    );
  }, { suffix: "startup_recovery" });
});

test("a Run queued behind Account work refreshes the AgentSession generation before start", async () => {
  await fixture(async ({ store, hub, agent, account, space, spaceSession, agentSession, insertMessage }) => {
    let releaseLock;
    let lockEntered;
    const entered = new Promise((resolve) => { lockEntered = resolve; });
    const gate = new Promise((resolve) => { releaseLock = resolve; });
    const priorWork = withAccountExecutionLock(account.id, async () => {
      lockEntered();
      await gate;
      rotateContextGeneration(store, {
        agentSessionId: agentSession.id,
        fromGeneration: 1,
        checkpoint: { schemaVersion: 1, summary: "prior", sourceMessageIds: [], recentTurns: [] },
      });
    });
    await entered;
    let observedGeneration = null;
    const run = executeRun({
      store, hub, config: CONFIG, agent, account, space, spaceSession, agentSession,
      triggerMessage: insertMessage(),
      adapter: { async run(ctx) { observedGeneration = ctx.contextGeneration; return { content: "reply" }; } },
    });
    releaseLock();
    await priorWork;
    const ended = await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === run.id);
    assert.equal(ended.data.run.status, "completed");
    assert.equal(ended.data.run.contextGeneration, 2);
    assert.equal(observedGeneration, 2);
  }, { suffix: "queued_generation" });
});

test("CLI provider binding is generation-scoped, continuous, and CAS protected", async () => {
  await fixture(async ({ store, hub, agent, account, space, spaceSession, agentSession, insertMessage }) => {
    const seenBindings = [];
    const persistedVersions = [];
    const adapter = {
      async run(ctx) {
        seenBindings.push(ctx.providerBinding);
        const currentVersion = ctx.providerBinding?.version ?? 0;
        const saved = ctx.persistProviderBinding({ threadId: "thr_stable" }, currentVersion);
        persistedVersions.push(saved.version);
        return { content: `reply ${seenBindings.length}` };
      },
    };

    for (const content of ["first", "second"]) {
      const triggerMessage = insertMessage({ content });
      const run = executeRun({
        store, hub, config: CONFIG, agent, account, space, spaceSession, agentSession,
        triggerMessage, adapter,
      });
      const ended = await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === run.id);
      assert.equal(ended.data.run.status, "completed");
    }

    assert.equal(seenBindings[0], null);
    assert.deepEqual(seenBindings[1].providerState, { threadId: "thr_stable" });
    assert.deepEqual(persistedVersions, [1, 2], "the resumed thread advances its binding CAS version");
    assert.equal(getProviderBinding(store, {
      agentSessionId: agentSession.id,
      generation: 1,
      accountId: account.id,
    }).version, 2);

    let staleError;
    const staleAdapter = {
      async run(ctx) {
        try {
          ctx.persistProviderBinding({ threadId: "thr_conflict" }, 0);
        } catch (error) {
          staleError = error;
        }
        return { content: "binding unchanged" };
      },
    };
    const staleRun = executeRun({
      store, hub, config: CONFIG, agent, account, space, spaceSession, agentSession,
      triggerMessage: insertMessage({ content: "stale CAS" }), adapter: staleAdapter,
    });
    await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === staleRun.id);
    assert.equal(staleError?.code, "conflict");
    assert.deepEqual(getProviderBinding(store, {
      agentSessionId: agentSession.id, generation: 1, accountId: account.id,
    }).providerState, { threadId: "thr_stable" });
  });
});

test("CLI missing binding rotates generation and starts a fresh CAS/binding context", async () => {
  await fixture(async ({ store, hub, agent, account, space, spaceSession, agentSession, insertMessage }) => {
    const memoryRetrieval = memoryRetrievalStub({ resident: "RESIDENT INDEX" });
    const first = executeRun({
      store, hub, config: CONFIG, agent, account, space, spaceSession, agentSession,
      triggerMessage: insertMessage({ content: "establish thread" }),
      memoryRetrieval,
      adapter: {
        async run(ctx) {
          ctx.persistProviderBinding({ threadId: "thr_old" }, 0);
          return { content: "established" };
        },
      },
    });
    await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === first.id);

    let rotation;
    const second = executeRun({
      store, hub, config: CONFIG, agent, account, space, spaceSession,
      agentSession: store.find("agentSessions", agentSession.id),
      triggerMessage: insertMessage({ content: "resume missing" }),
      memoryRetrieval,
      adapter: {
        async run(ctx) {
          assert.deepEqual(ctx.providerBinding.providerState, { threadId: "thr_old" });
          rotation = await ctx.rotateProviderBinding({ reason: "missing" });
          assert.equal(rotation.generation, 2);
          assert.match(rotation.prompt.text, /^RESIDENT INDEX/u);
          await assert.rejects(
            ctx.rotateProviderBinding({ reason: "missing" }),
            (error) => error.code === "conflict",
          );
          const saved = ctx.persistProviderBinding({ threadId: "thr_new" }, 0);
          assert.equal(saved.version, 1);
          return { content: "recovered" };
        },
      },
    });
    const ended = await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === second.id);
    assert.equal(ended.data.run.status, "completed");
    assert.equal(store.find("agentSessions", agentSession.id).generation, 2);
    assert.deepEqual(getProviderBinding(store, {
      agentSessionId: agentSession.id, generation: 1, accountId: account.id,
    }).providerState, { threadId: "thr_old" }, "old generation remains frozen");
    assert.deepEqual(getProviderBinding(store, {
      agentSessionId: agentSession.id, generation: 2, accountId: account.id,
    }).providerState, { threadId: "thr_new" });
  });
});

test("ordinary CLI provider failures never rotate context generation", async () => {
  await fixture(async ({ store, hub, agent, account, space, spaceSession, agentSession, insertMessage }) => {
    const fingerprint = providerFingerprintForRuntime({ ...agent.runtimeProfile, connection: agent.runtimeBinding.connection });
    const establishingRun = executeRun({
      store, hub, config: CONFIG, agent, account, space, spaceSession, agentSession,
      triggerMessage: insertMessage({ content: "establish" }),
      adapter: {
        async run(ctx) {
          ctx.persistProviderBinding({ threadId: "thr_kept" }, 0);
          return { content: "ok" };
        },
      },
    });
    await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === establishingRun.id);

    const failedRun = executeRun({
      store, hub, config: CONFIG, agent, account, space, spaceSession,
      agentSession: store.find("agentSessions", agentSession.id),
      triggerMessage: insertMessage({ content: "provider fails" }),
      adapter: {
        async run() { throw new AdapterError("provider_failed", "temporary provider failure"); },
      },
    });
    const ended = await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === failedRun.id);
    assert.equal(ended.data.run.status, "failed");
    assert.equal(ended.data.run.contextGeneration, 1);
    assert.equal(store.find("agentSessions", agentSession.id).generation, 1);
    const binding = getProviderBinding(store, {
      agentSessionId: agentSession.id, generation: 1, accountId: account.id,
    });
    assert.equal(binding.providerFingerprint, fingerprint);
    assert.deepEqual(binding.providerState, { threadId: "thr_kept" });
  });
});

test("crossing the auto watermark queues compaction at the completed Run safe point", async () => {
  await fixture(async ({ store, hub, agent, account, space, spaceSession, agentSession, insertMessage }) => {
    const compactCalls = [];
    const run = executeRun({
      store,
      hub,
      config: {
        ...CONFIG,
        context: { ...CONFIG.context, defaultLimitTokens: 1000, warningRatio: 0.1, autoRatio: 0.2 },
      },
      agent,
      account,
      space,
      spaceSession,
      agentSession,
      triggerMessage: insertMessage({ content: "small prompt" }),
      contextCompaction: {
        async compactAgent(input) {
          compactCalls.push(input);
          return store.find("agentSessions", agentSession.id);
        },
      },
      adapter: { async run() { return { content: "x".repeat(900) }; } },
    });
    await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === run.id);
    assert.equal(compactCalls.length, 1);
    assert.equal(compactCalls[0].spaceId, space.id);
    assert.equal(compactCalls[0].agentId, agent.id);
    assert.match(compactCalls[0].requestId, new RegExp(`^auto:${agentSession.id}:1:${run.id}$`, "u"));
  });
});

test("API history commits complete turns by CAS and excludes resident/group/Recall volatile text", async () => {
  await fixture(async ({ store, hub, agent, account, space, spaceSession, agentSession, insertMessage }) => {
    store.insert("agents", { id: "agt_other", name: "Other" });
    insertMessage({
      id: "msg_other",
      content: "temporary group context",
      author: { type: "agent", agentId: "agt_other" },
    });
    const triggerMessage = insertMessage({ id: "msg_api_input", content: "raw user question" });
    const captured = [];
    const run = executeRun({
      store, hub, config: CONFIG, agent, account, space, spaceSession, agentSession,
      triggerMessage,
      memoryRetrieval: memoryRetrievalStub({ resident: "RESIDENT", retrieval: "RECALL" }),
      adapter: {
        async run(ctx) {
          captured.push(ctx.prompt);
          return {
            content: "api answer",
            usage: { inputTokens: 42 },
            toolTranscript: [{ callId: "call_1", name: "safe_tool", status: "completed" }],
          };
        },
      },
    });
    const ended = await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === run.id);
    assert.equal(ended.data.run.status, "completed");
    assert.match(captured[0].turnText, /temporary group context/u);
    assert.match(captured[0].turnText, /RECALL/u);
    assert.equal(captured[0].apiMessages[0].content, "RESIDENT");

    const history = getApiHistory(store, { agentSessionId: agentSession.id, generation: 1 });
    assert.equal(history.version, 1);
    assert.equal(history.turns.length, 1);
    assert.equal(history.turns[0].input.content, "raw user question");
    assert.equal(history.turns[0].assistant[0].content, "api answer");
    const measuredSession = store.find("agentSessions", agentSession.id);
    assert.equal(measuredSession.context.estimatedInputTokens, 42);
    assert.equal(measuredSession.context.measurement, "provider_reported");
    const stableHistoryText = JSON.stringify(history);
    assert.doesNotMatch(stableHistoryText, /RESIDENT|temporary group context|RECALL/u);

    assert.throws(() => compareAndSetApiHistory(store, {
      agentSessionId: agentSession.id,
      generation: 1,
      baseHistoryVersion: 0,
      turn: { ...history.turns[0], runId: "run_stale" },
    }), (error) => error.code === "history_conflict");
    assert.deepEqual(getApiHistory(store, {
      agentSessionId: agentSession.id, generation: 1,
    }), history, "stale CAS keeps canonical history unchanged");
  }, { kind: "api", suffix: "api" });
});

test("a competing API history CAS fails the Run without appending its assistant turn", async () => {
  await fixture(async ({ store, hub, agent, account, space, spaceSession, agentSession, insertMessage }) => {
    const triggerMessage = insertMessage({ content: "race" });
    const run = executeRun({
      store, hub, config: CONFIG, agent, account, space, spaceSession, agentSession,
      triggerMessage,
      adapter: {
        async run() {
          compareAndSetApiHistory(store, {
            agentSessionId: agentSession.id,
            generation: 1,
            baseHistoryVersion: 0,
            turn: {
              runId: "run_competitor",
              input: { sourceMessageId: "msg_competitor", content: "other" },
              assistant: [{ messageId: "msg_competitor_reply", content: "other reply" }],
            },
          });
          return { content: "must not commit" };
        },
      },
    });
    const ended = await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === run.id);
    assert.equal(ended.data.run.status, "failed");
    assert.equal(ended.data.run.error.code, "history_conflict");
    const history = getApiHistory(store, { agentSessionId: agentSession.id, generation: 1 });
    assert.equal(history.version, 1);
    assert.deepEqual(history.turns.map((turn) => turn.runId), ["run_competitor"]);
  }, { kind: "api", suffix: "race" });
});

test("Message, Run, Activity and Approval write events inherit one spaceSessionId", async () => {
  await fixture(async ({ store, hub, agent, account, space, spaceSession, agentSession, insertMessage }) => {
    const { events, unsubscribe } = captureEvents(hub);
    const triggerMessage = insertMessage({ content: "emit everything" });
    const run = executeRun({
      store, hub, config: CONFIG, agent, account, space, spaceSession, agentSession,
      triggerMessage,
      adapter: {
        async run(ctx) {
          ctx.onActivity({ callId: "call_a", phase: "started", label: "work" });
          ctx.requestApproval({ callId: "call_a", type: "tool", summary: "approve" });
          ctx.onDelta("streamed reply");
          return { content: "streamed reply" };
        },
      },
    });
    await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === run.id);
    unsubscribe();

    const domainEvents = events.filter((event) =>
      ["run.started", "run.ended", "activity.created", "approval.requested", "message.created", "message.delta", "message.completed"]
        .includes(event.type));
    assert(domainEvents.length >= 6, `expected domain write events, got ${domainEvents.map((event) => event.type)}`);
    for (const event of domainEvents) {
      const record = event.data.run ?? event.data.activity ?? event.data.approval ?? event.data.message;
      const sessionId = record?.spaceSessionId ?? event.data.spaceSessionId;
      assert.equal(sessionId, spaceSession.id, `${event.type} must carry spaceSessionId`);
    }
    const timeline = getTimeline(store, space.id, { spaceSessionId: spaceSession.id, limit: 50 });
    assert.equal(timeline.runs.length, 1);
    assert.equal(timeline.runs[0].id, run.id);
    assert.equal(timeline.runs[0].status, "completed");
  });
});

test("prompt compilation failure ends the pending Run without entering Agent working state", async () => {
  await fixture(async ({ store, hub, agent, account, space, spaceSession, agentSession, insertMessage }) => {
    let adapterCalled = false;
    const states = [];
    const run = executeRun({
      store, hub, config: CONFIG, agent, account, space, spaceSession, agentSession,
      triggerMessage: insertMessage(),
      adapter: { async run() { adapterCalled = true; return { content: "unexpected" }; } },
      agentStates: { setWorking() { states.push("working"); }, setIdle() { states.push("idle"); } },
      memoryRetrieval: {
        async ensureSession() { throw new Error("sidecar setup failed at /private/secret/path"); },
        async residentIndex() { return null; },
        async searchForInjection() { return { block: null }; },
      },
    });
    const ended = await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === run.id);
    assert.equal(ended.data.run.status, "failed");
    assert.equal(ended.data.run.error.code, "internal");
    assert.doesNotMatch(JSON.stringify(ended.data.run.error), /private|secret|path/u);
    assert.equal(adapterCalled, false);
    assert.deepEqual(states, []);
  });
});

test("gateway-local Run cannot overlap an active daemon lease", async () => {
  await fixture(async ({ store, hub, agent, account, space, spaceSession, agentSession, insertMessage }) => {
    store.insert("runs", {
      id: "run_daemon_active",
      accountId: account.id,
      agentId: agent.id,
      runtimeRevision: agent.runtimeRevision,
      delegated: false,
      executionTransport: "daemon",
      accountSessionId: "acs_active",
      executionLeaseId: "exl_active",
      workspaceHostId: "host_active",
      leaseAcquiredAt: new Date().toISOString(),
      status: "running",
    });
    let adapterCalled = false;
    const run = executeRun({
      store, hub, config: CONFIG, agent, account, space, spaceSession, agentSession,
      triggerMessage: insertMessage(),
      adapter: { async run() { adapterCalled = true; return { content: "unexpected" }; } },
    });
    const ended = await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === run.id);
    assert.equal(ended.data.run.status, "failed");
    assert.equal(ended.data.run.error.code, "account_busy");
    assert.equal(adapterCalled, false);
    assert.equal(store.find("runs", "run_daemon_active").status, "running");
  });
});
