import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../src/store/store.js";
import {
  ensureActiveSpaceSession,
  ensureAgentSession,
  startNewSpaceSession,
} from "../../src/spaces/context-sessions.js";
import {
  assessContextPressure,
  compareAndSetApiHistory,
  compareAndSetProviderBinding,
  getApiHistory,
  getProviderBinding,
  providerFingerprintForAccount,
  rotateContextGeneration,
  updateContextPressure,
} from "../../src/spaces/context-state.js";
import {
  createContextCompactionJob,
  getContextCompactionJob,
  getContextCompactionTarget,
  markContextCompactionTargetRunning,
  recoverInterruptedContextCompactions,
  updateContextCompactionTarget,
} from "../../src/spaces/context-compaction-store.js";
import { checkpointForAgent } from "../../src/spaces/run-context.js";

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "vera-context-test-"));
  const store = await createStore({ dataPath: join(root, "data"), debounceMs: 5 });
  store.insert("agents", { id: "agt_a", name: "A" });
  store.insert("accounts", {
    id: "acc_a", owningAgentId: "agt_a", kind: "cli", provider: "codex",
    connection: {}, model: "gpt-test",
  });
  store.insert("spaces", {
    id: "spc_a", name: "A", seats: [{ agentId: "agt_a", responseMode: "default" }], createdAt: "2026-01-01T00:00:00.000Z",
  });
  try { await fn(store); }
  finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}

const turn = {
  runId: "run_a",
  input: {
    sourceMessageId: "msg_input", author: { type: "user" }, target: { type: "broadcast" },
    content: "hello", createdAt: "2026-01-01T00:00:01.000Z",
  },
  assistant: [{ messageId: "msg_reply", content: "hi", createdAt: "2026-01-01T00:00:02.000Z" }],
};

test("active SpaceSession and per-agent AgentSession are unique and pressure is generation-CASed", async () => {
  await fixture(async (store) => {
    const first = ensureActiveSpaceSession(store, "spc_a", { now: "2026-01-01T00:00:00.000Z" });
    const second = ensureActiveSpaceSession(store, "spc_a");
    assert.equal(second.id, first.id);
    const agentSession = ensureAgentSession(store, {
      spaceSessionId: first.id, agentId: "agt_a", context: { effectiveLimitTokens: 100 },
    });
    assert.equal(ensureAgentSession(store, { spaceSessionId: first.id, agentId: "agt_a" }).id, agentSession.id);
    const measured = updateContextPressure(store, {
      agentSessionId: agentSession.id, generation: 1,
      estimatedInputTokens: 96, effectiveLimitTokens: 100, measurement: "provider_reported",
    });
    assert.equal(measured.context.pressureRatio, 0.96);
    assert.deepEqual(
      assessContextPressure(measured, { warningRatio: 0.7, autoRatio: 0.8, hardRatio: 0.95 }),
      { ratio: 0.96, level: "hard", shouldCompact: true, mustCompact: true },
    );
    assert.throws(() => updateContextPressure(store, {
      agentSessionId: agentSession.id, generation: 2,
      estimatedInputTokens: 1, effectiveLimitTokens: 100, measurement: "estimate",
    }), (error) => error.code === "conflict");
    assert.throws(() => rotateContextGeneration(store, {
      agentSessionId: agentSession.id,
      fromGeneration: 1,
      providerBinding: { accountId: "acc_a", providerFingerprint: "sha256:test", providerState: null },
    }), (error) => error.code === "invalid_request");
    assert.equal(store.find("agentSessions", agentSession.id).generation, 1,
      "invalid next-generation binding must not advance the generation");
  });
});

test("provider binding and API history use positive integer CAS versions", async () => {
  await fixture(async (store) => {
    const spaceSession = ensureActiveSpaceSession(store, "spc_a");
    const agentSession = ensureAgentSession(store, { spaceSessionId: spaceSession.id, agentId: "agt_a" });
    const account = store.find("accounts", "acc_a");
    const fingerprint = providerFingerprintForAccount(account);
    const binding = compareAndSetProviderBinding(store, {
      agentSessionId: agentSession.id, generation: 1, accountId: account.id,
      providerFingerprint: fingerprint, providerState: { threadId: "thr_a" }, ifVersion: 0,
    });
    assert.equal(binding.version, 1);
    const retried = compareAndSetProviderBinding(store, {
      agentSessionId: agentSession.id, generation: 1, accountId: account.id,
      providerFingerprint: fingerprint, providerState: { threadId: "thr_a" }, ifVersion: 0,
    });
    assert.equal(retried.id, binding.id);
    assert.throws(() => compareAndSetProviderBinding(store, {
      agentSessionId: agentSession.id, generation: 1, accountId: account.id,
      providerFingerprint: fingerprint, providerState: { threadId: "other" }, ifVersion: 0,
    }), (error) => error.code === "conflict");
    assert.deepEqual(getProviderBinding(store, {
      agentSessionId: agentSession.id, generation: 1, accountId: account.id,
    }).providerState, { threadId: "thr_a" });

    const history = compareAndSetApiHistory(store, {
      agentSessionId: agentSession.id, generation: 1, baseHistoryVersion: 0, turn,
    });
    assert.equal(history.version, 1);
    assert.deepEqual(history.turns, [turn]);
    assert.throws(() => compareAndSetApiHistory(store, {
      agentSessionId: agentSession.id, generation: 1, baseHistoryVersion: 0,
      turn: { ...turn, runId: "run_b" },
    }), (error) => error.code === "history_conflict");
  });
});

test("/new archives the complete old context, is request-id idempotent, and refuses active work", async () => {
  await fixture(async (store) => {
    const oldSpaceSession = ensureActiveSpaceSession(store, "spc_a");
    const oldAgentSession = ensureAgentSession(store, { spaceSessionId: oldSpaceSession.id, agentId: "agt_a" });
    store.insert("memoryRecallSessions", {
      id: "mrs_old", agentId: "agt_a", agentSessionId: oldAgentSession.id,
      generation: 1, status: "active", deliveredSlugs: [], cursors: [],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    compareAndSetApiHistory(store, {
      agentSessionId: oldAgentSession.id, generation: 1, baseHistoryVersion: 0, turn,
    });
    store.update("spaces", "spc_a", {
      seats: [{ agentId: "agt_a", responseMode: "default" }, { agentId: "agt_missing", responseMode: "default" }],
    });
    assert.throws(() => startNewSpaceSession(store, {
      spaceId: "spc_a", requestId: "req_invalid_membership",
    }), (error) => error.code === "conflict");
    assert.equal(store.find("spaceSessions", oldSpaceSession.id).status, "active",
      "failed /new preflight must not archive the current session");
    store.update("spaces", "spc_a", { seats: [{ agentId: "agt_a", responseMode: "default" }] });
    store.insert("runs", { id: "run_busy", spaceId: "spc_a", spaceSessionId: oldSpaceSession.id, status: "pending" });
    assert.throws(() => startNewSpaceSession(store, { spaceId: "spc_a", requestId: "req_busy" }),
      (error) => error.code === "session_busy");
    store.update("runs", "run_busy", { status: "cancelled" });
    const changed = startNewSpaceSession(store, {
      spaceId: "spc_a", requestId: "req_new",
    }, { now: "2026-01-02T00:00:00.000Z" });
    const retried = startNewSpaceSession(store, { spaceId: "spc_a", requestId: "req_new" });
    assert.deepEqual(retried, changed);
    assert.equal(changed.archivedSession.status, "archived");
    assert.equal(changed.newSession.status, "active");
    assert.equal(store.find("memoryRecallSessions", "mrs_old").status, "frozen");
    const newAgentSession = store.list("agentSessions").find((item) => item.spaceSessionId === changed.newSession.id);
    assert.equal(newAgentSession.generation, 1);
    assert.equal(getApiHistory(store, { agentSessionId: newAgentSession.id, generation: 1 }), null);
    assert.equal(getProviderBinding(store, { agentSessionId: newAgentSession.id, generation: 1 }), null);
  });
});

test("compaction jobs derive status and rotate each target generation with identical-result retry", async () => {
  await fixture(async (store) => {
    const spaceSession = ensureActiveSpaceSession(store, "spc_a");
    const agentSession = ensureAgentSession(store, { spaceSessionId: spaceSession.id, agentId: "agt_a" });
    store.insert("memoryRecallSessions", {
      id: "mrs_generation_1", agentId: "agt_a", agentSessionId: agentSession.id,
      generation: 1, status: "active", deliveredSlugs: [], cursors: [],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const job = createContextCompactionJob(store, {
      spaceId: "spc_a", requestId: "req_compact",
      targets: [{ agentId: "agt_a", mode: "checkpoint_new_binding" }],
    });
    assert.equal(job.status, "queued");
    assert.equal(createContextCompactionJob(store, {
      spaceId: "spc_a", requestId: "req_compact", targets: [{ agentId: "agt_a" }],
    }).id, job.id);
    assert.equal(markContextCompactionTargetRunning(store, { jobId: job.id, agentId: "agt_a" }).status, "running");
    const result = {
      jobId: job.id, agentId: "agt_a", agentSessionId: agentSession.id,
      fromGeneration: 1, status: "succeeded", checkpoint: { summary: "stable" },
    };
    const completed = updateContextCompactionTarget(store, result);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.targets[0].toGeneration, 2);
    assert.equal(updateContextCompactionTarget(store, result).status, "succeeded");
    assert.throws(() => updateContextCompactionTarget(store, { ...result, checkpoint: { summary: "different" } }),
      (error) => error.code === "conflict");
    assert.equal(store.find("agentSessions", agentSession.id).generation, 2);
    assert.equal(store.find("memoryRecallSessions", "mrs_generation_1").status, "frozen");
    assert.equal(getApiHistory(store, { agentSessionId: agentSession.id, generation: 2 }), null,
      "CLI checkpoint compaction does not create canonical API history");
    assert.equal(store.find("agentSessions", agentSession.id).checkpoints[0].checkpoint.summary, "stable");
    assert.equal(getContextCompactionJob(store, job.id).targets[0].mode, undefined, "public job hides execution mode");

    store.update("accounts", "acc_a", { kind: "api", provider: "ollama" });
    compareAndSetApiHistory(store, {
      agentSessionId: agentSession.id,
      generation: 2,
      baseHistoryVersion: 0,
      turn,
    });
    const apiJob = createContextCompactionJob(store, {
      spaceId: "spc_a", requestId: "req_api_compact", targets: [{ agentId: "agt_a" }],
    });
    updateContextCompactionTarget(store, {
      jobId: apiJob.id, agentId: "agt_a", agentSessionId: agentSession.id,
      fromGeneration: 2, status: "succeeded", checkpoint: { summary: "api stable" },
    });
    assert.equal(getApiHistory(store, { agentSessionId: agentSession.id, generation: 3 }).checkpoint.summary,
      "api stable", "API compaction starts a new canonical history generation");
    assert.deepEqual(
      getApiHistory(store, { agentSessionId: agentSession.id, generation: 3 }).turns,
      [turn],
      "API compaction carries only gateway-owned recent complete turns",
    );
  });
});

test("restart recovery terminalizes interrupted compaction so /new is not permanently busy", async () => {
  await fixture(async (store) => {
    const spaceSession = ensureActiveSpaceSession(store, "spc_a");
    ensureAgentSession(store, { spaceSessionId: spaceSession.id, agentId: "agt_a" });
    const job = createContextCompactionJob(store, {
      spaceId: "spc_a", requestId: "req_interrupted", targets: [{ agentId: "agt_a" }],
    });
    markContextCompactionTargetRunning(store, { jobId: job.id, agentId: "agt_a" });
    recoverInterruptedContextCompactions(store, { now: "2026-01-03T00:00:00.000Z" });
    const recovered = getContextCompactionJob(store, job.id);
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.targets[0].status, "failed");
    assert.equal(startNewSpaceSession(store, { spaceId: "spc_a", requestId: "req_after_restart" }).newSession.status, "active");
  });
});

test("compaction freezes its source boundary and includes only the Run already ahead of it", async () => {
  await fixture(async (store) => {
    const spaceSession = ensureActiveSpaceSession(store, "spc_a");
    const agentSession = ensureAgentSession(store, { spaceSessionId: spaceSession.id, agentId: "agt_a" });
    store.insert("messages", {
      id: "msg_before", spaceId: "spc_a", spaceSessionId: spaceSession.id,
      author: { type: "user" }, target: { type: "broadcast" }, content: "before compact",
      runId: null, status: "completed", createdAt: "2026-01-01T00:00:01.000Z",
    });
    store.insert("runs", {
      id: "run_ahead", agentId: "agt_a", accountId: "acc_a", role: "main", parentRunId: null,
      spaceId: "spc_a", spaceSessionId: spaceSession.id, agentSessionId: agentSession.id,
      contextGeneration: 1, triggerMessageId: "msg_before", replyMessageIds: [], status: "running",
      createdAt: "2026-01-01T00:00:01.000Z", endedAt: null,
    });
    const job = createContextCompactionJob(store, {
      spaceId: "spc_a", requestId: "req_boundary", targets: [{ agentId: "agt_a" }],
    });
    const frozen = getContextCompactionTarget(store, { jobId: job.id, agentId: "agt_a" });
    assert.deepEqual(frozen.includedRunIds, ["run_ahead"]);

    store.insert("messages", {
      id: "msg_ahead_reply", spaceId: "spc_a", spaceSessionId: spaceSession.id,
      author: { type: "agent", agentId: "agt_a" }, target: { type: "broadcast" }, content: "ahead reply",
      runId: "run_ahead", status: "completed", createdAt: "2026-01-01T00:00:02.000Z",
    });
    store.update("runs", "run_ahead", { status: "completed", replyMessageIds: ["msg_ahead_reply"], endedAt: "2026-01-01T00:00:02.000Z" });
    store.insert("messages", {
      id: "msg_late", spaceId: "spc_a", spaceSessionId: spaceSession.id,
      author: { type: "user" }, target: { type: "broadcast" }, content: "late pending input",
      runId: null, status: "completed", createdAt: "2026-01-01T00:00:03.000Z",
    });
    store.insert("runs", {
      id: "run_late", agentId: "agt_a", accountId: "acc_a", role: "main", parentRunId: null,
      spaceId: "spc_a", spaceSessionId: spaceSession.id, agentSessionId: agentSession.id,
      contextGeneration: 1, triggerMessageId: "msg_late", replyMessageIds: [], status: "pending",
      createdAt: "2026-01-01T00:00:03.000Z", endedAt: null,
    });
    const checkpoint = checkpointForAgent(store, {
      spaceSessionId: spaceSession.id,
      agentId: "agt_a",
      recentTurnLimit: frozen.recentTurnLimit,
      sourceSeq: frozen.sourceSeq,
      includedRunIds: frozen.includedRunIds,
    });
    assert.deepEqual(checkpoint.recentTurns.map((item) => item.runId), ["run_ahead"]);
    assert.doesNotMatch(JSON.stringify(checkpoint), /late pending input/u);
  });
});
