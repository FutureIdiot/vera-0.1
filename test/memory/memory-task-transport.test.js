import test from "node:test";
import assert from "node:assert/strict";

import {
  createMemoryTaskTransport,
  projectMemoryTaskSnapshot,
} from "../../src/memory/memory-task-transport.js";

const EXECUTOR_AGENT_ID = "agt_executor";

function taskSnapshot(overrides = {}) {
  return {
    ownerAgentId: "agt_owner",
    executorAgentId: EXECUTOR_AGENT_ID,
    runtimeRevision: "runtime-revision-7",
    kind: "codex",
    provider: "codex",
    modelMode: "custom",
    taskModel: "gpt-memory-1",
    verificationId: "verification-7",
    connectionFingerprint: "sha256:gateway-private-fingerprint",
    ...overrides,
  };
}

function digestPayload() {
  return {
    agent: { id: "agt_owner", name: "Owner" },
    chunks: [{
      messages: [{
        messageId: "msg_1",
        author: "user",
        target: "agent",
        content: "remember this",
        createdAt: "2026-07-19T00:00:00.000Z",
      }],
    }],
    facts: [],
    proposalSchema: { version: 1 },
  };
}

function succeededResult(snapshot, { attempt = 1, proposals = [] } = {}) {
  return {
    attempt,
    status: "succeeded",
    proposals,
    execution: {
      fallbackUsed: false,
      runtimeRevision: snapshot.runtimeRevision,
      taskModel: snapshot.taskModel,
    },
  };
}

function fakeClock() {
  let nextId = 0;
  const timers = new Map();
  return {
    setTimer(callback) {
      const id = ++nextId;
      timers.set(id, callback);
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    fireNext() {
      const entry = timers.entries().next().value;
      assert.ok(entry, "expected a pending timer");
      const [id, callback] = entry;
      timers.delete(id);
      callback();
    },
    size() {
      return timers.size;
    },
  };
}

function harness({ validateSnapshot } = {}) {
  const clock = fakeClock();
  const validationCalls = [];
  const taskRuntime = {
    validateSnapshot(snapshot) {
      validationCalls.push(structuredClone(snapshot));
      return validateSnapshot?.(snapshot, validationCalls.length) ?? {
        runtime: { agentId: snapshot.executorAgentId },
        taskModel: snapshot.taskModel,
      };
    },
  };
  const transport = createMemoryTaskTransport({
    taskRuntime,
    timeoutMs: 5_000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, transport, validationCalls };
}

function subscribe(transport, agentId = EXECUTOR_AGENT_ID) {
  const frames = [];
  const unsubscribe = transport.subscribe(agentId, {
    write(frame) {
      frames.push(frame);
    },
  });
  return { frames, unsubscribe };
}

function eventFromFrame(frame) {
  const data = frame.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data, "expected an SSE data line");
  return JSON.parse(data.slice("data: ".length));
}

function assertCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

test("projects the exact safe snapshot and keeps private runtime secret canaries off wire", async () => {
  const secret = "secret-canary-must-not-cross-memory-task-wire";
  const snapshot = taskSnapshot({
    connectionFingerprint: secret,
    connection: { apiKey: secret },
    runtimeBinding: { connection: { token: secret } },
    accountId: `acc_${secret}`,
    workspace: { path: `/srv/${secret}` },
    executorMemory: [{ content: secret }],
    systemPrompt: secret,
  });
  const expectedSnapshot = {
    ownerAgentId: "agt_owner",
    executorAgentId: EXECUTOR_AGENT_ID,
    runtimeRevision: "runtime-revision-7",
    kind: "codex",
    provider: "codex",
    modelMode: "custom",
    taskModel: "gpt-memory-1",
    verificationId: "verification-7",
  };
  assert.deepEqual(projectMemoryTaskSnapshot(snapshot), expectedSnapshot);

  const { transport } = harness();
  const { frames } = subscribe(transport);
  const pending = transport.dispatch({
    jobId: "mdj_1",
    kind: "digest",
    memoryTaskSnapshot: snapshot,
    payload: digestPayload(),
  });
  const requested = eventFromFrame(frames[0]);
  assert.equal(requested.type, "memory-task.requested");
  assert.deepEqual(requested.data.memoryTaskSnapshot, expectedSnapshot);
  assert.deepEqual(requested.data.payload, digestPayload());
  assert.equal(JSON.stringify(requested).includes(secret), false);

  transport.submitResult(EXECUTOR_AGENT_ID, requested.data.dispatchId, succeededResult(snapshot));
  await pending;
});

test("rejects a result from the wrong executor without consuming the pending dispatch", async () => {
  const snapshot = taskSnapshot();
  const { transport } = harness();
  const { frames } = subscribe(transport);
  const pending = transport.dispatch({
    jobId: "mdj_wrong_agent",
    kind: "digest",
    memoryTaskSnapshot: snapshot,
    payload: digestPayload(),
  });
  const dispatchId = eventFromFrame(frames[0]).data.dispatchId;
  const body = succeededResult(snapshot);

  assert.throws(
    () => transport.submitResult("agt_intruder", dispatchId, body),
    assertCode("forbidden"),
  );
  assert.equal(transport.pendingCount(), 1);

  transport.submitResult(EXECUTOR_AGENT_ID, dispatchId, body);
  await pending;
  assert.equal(transport.pendingCount(), 0);
});

test("accepts only the frozen runtime metadata and returns the frozen successful result", async () => {
  const snapshot = taskSnapshot();
  const { transport, validationCalls } = harness();
  const { frames } = subscribe(transport);
  const pending = transport.dispatch({
    jobId: "mdj_frozen",
    kind: "digest",
    attempt: 3,
    memoryTaskSnapshot: snapshot,
    payload: digestPayload(),
  });
  const dispatchId = eventFromFrame(frames[0]).data.dispatchId;
  snapshot.runtimeRevision = "runtime-revision-mutated-after-dispatch";
  snapshot.taskModel = "mutated-model";
  const frozen = taskSnapshot();
  const body = succeededResult(frozen, {
    attempt: 3,
    proposals: [{ operation: "upsert", memoryId: "mem_1" }],
  });

  assert.deepEqual(transport.submitResult(EXECUTOR_AGENT_ID, dispatchId, body), { accepted: true });
  assert.deepEqual(await pending, {
    proposals: body.proposals,
    execution: body.execution,
  });
  assert.equal(validationCalls.length, 2);
  assert.equal(validationCalls[1].runtimeRevision, frozen.runtimeRevision);
  assert.equal(validationCalls[1].taskModel, frozen.taskModel);
});

test("treats an identical duplicate terminal result as idempotent", async () => {
  const snapshot = taskSnapshot();
  const { transport } = harness();
  const { frames } = subscribe(transport);
  const pending = transport.dispatch({
    jobId: "mdj_duplicate",
    kind: "digest",
    memoryTaskSnapshot: snapshot,
    payload: digestPayload(),
  });
  const dispatchId = eventFromFrame(frames[0]).data.dispatchId;
  const body = succeededResult(snapshot, { proposals: [{ operation: "noop" }] });

  assert.deepEqual(transport.submitResult(EXECUTOR_AGENT_ID, dispatchId, body), { accepted: true });
  await pending;
  assert.deepEqual(transport.submitResult(EXECUTOR_AGENT_ID, dispatchId, structuredClone(body)), {
    accepted: true,
  });
});

test("rejects a stale attempt and a different late terminal result", async () => {
  const snapshot = taskSnapshot();
  const { transport } = harness();
  const { frames } = subscribe(transport);
  const pending = transport.dispatch({
    jobId: "mdj_attempt_2",
    kind: "digest",
    attempt: 2,
    memoryTaskSnapshot: snapshot,
    payload: digestPayload(),
  });
  const dispatchId = eventFromFrame(frames[0]).data.dispatchId;

  assert.throws(
    () => transport.submitResult(EXECUTOR_AGENT_ID, dispatchId, succeededResult(snapshot)),
    assertCode("conflict"),
  );
  const accepted = succeededResult(snapshot, { attempt: 2 });
  transport.submitResult(EXECUTOR_AGENT_ID, dispatchId, accepted);
  await pending;
  assert.throws(
    () => transport.submitResult(EXECUTOR_AGENT_ID, dispatchId, {
      attempt: 2,
      status: "failed",
      error: { code: "executor_failed" },
    }),
    assertCode("conflict"),
  );
});

test("fails safely when the frozen executor has no subscriber", async () => {
  const { clock, transport } = harness();
  await assert.rejects(
    transport.dispatch({
      jobId: "mdj_no_subscriber",
      kind: "digest",
      memoryTaskSnapshot: taskSnapshot(),
      payload: digestPayload(),
    }),
    assertCode("memory_task_unavailable"),
  );
  assert.equal(transport.pendingCount(), 0);
  assert.equal(clock.size(), 0);
});

test("publishes cancellation and rejects an active dispatch", async () => {
  const { clock, transport } = harness();
  const { frames } = subscribe(transport);
  const controller = new AbortController();
  const pending = transport.dispatch({
    jobId: "mdj_cancel",
    kind: "digest",
    memoryTaskSnapshot: taskSnapshot(),
    payload: digestPayload(),
    signal: controller.signal,
  });
  const requested = eventFromFrame(frames[0]);
  controller.abort();

  await assert.rejects(pending, assertCode("memory_task_unavailable"));
  const cancelled = eventFromFrame(frames[1]);
  assert.equal(cancelled.type, "memory-task.cancelled");
  assert.deepEqual(cancelled.data, {
    dispatchId: requested.data.dispatchId,
    attempt: 1,
  });
  assert.equal(transport.pendingCount(), 0);
  assert.equal(clock.size(), 0);
});

test("rejects a pre-aborted dispatch without leaving pending state", async () => {
  const { clock, transport } = harness();
  const { frames } = subscribe(transport);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(transport.dispatch({
    jobId: "mdj_pre_aborted",
    kind: "digest",
    memoryTaskSnapshot: taskSnapshot(),
    payload: digestPayload(),
    signal: controller.signal,
  }), assertCode("memory_task_unavailable"));
  assert.equal(transport.pendingCount(), 0);
  assert.equal(clock.size(), 0);
  assert.equal(eventFromFrame(frames[0]).type, "memory-task.cancelled");
});

test("times out safely and rejects a late result", async () => {
  const snapshot = taskSnapshot();
  const { clock, transport } = harness();
  const { frames } = subscribe(transport);
  const pending = transport.dispatch({
    jobId: "mdj_timeout",
    kind: "digest",
    memoryTaskSnapshot: snapshot,
    payload: digestPayload(),
  });
  const dispatchId = eventFromFrame(frames[0]).data.dispatchId;
  clock.fireNext();

  await assert.rejects(pending, assertCode("memory_task_unavailable"));
  assert.equal(transport.pendingCount(), 0);
  assert.throws(
    () => transport.submitResult(EXECUTOR_AGENT_ID, dispatchId, succeededResult(snapshot)),
    assertCode("not_found"),
  );
});

test("revalidates the frozen runtime immediately before accepting a result", async () => {
  let rejectSecondValidation = true;
  const { transport, validationCalls } = harness({
    validateSnapshot(_snapshot, callCount) {
      if (callCount === 2 && rejectSecondValidation) {
        throw Object.assign(new Error("runtime revision is no longer qualified"), {
          code: "executor_unavailable",
        });
      }
      return { runtime: {}, taskModel: "gpt-memory-1" };
    },
  });
  const { frames } = subscribe(transport);
  const snapshot = taskSnapshot();
  const pending = transport.dispatch({
    jobId: "mdj_revalidate",
    kind: "digest",
    memoryTaskSnapshot: snapshot,
    payload: digestPayload(),
  });
  const dispatchId = eventFromFrame(frames[0]).data.dispatchId;
  const body = succeededResult(snapshot);

  assert.throws(
    () => transport.submitResult(EXECUTOR_AGENT_ID, dispatchId, body),
    assertCode("executor_unavailable"),
  );
  assert.equal(transport.pendingCount(), 1);
  assert.equal(validationCalls.length, 2);

  rejectSecondValidation = false;
  transport.submitResult(EXECUTOR_AGENT_ID, dispatchId, body);
  await pending;
  assert.equal(validationCalls.length, 3);
});
