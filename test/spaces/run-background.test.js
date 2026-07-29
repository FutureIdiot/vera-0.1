import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventHub } from "../../src/api/sse.js";
import { createStore } from "../../src/store/store.js";
import { createRunBackgroundService } from "../../src/spaces/run-background.js";
import { postMessage } from "../../src/spaces/messages.js";

const CONFIG = {
  runBackground: {
    eligibilityMs: 10000,
    catchupMaxMessages: 20,
    catchupMaxChars: 4000,
    summaryMaxChars: 1000,
    catchupTimeoutMs: 300000,
    summaryHeader: "=== catch-up ===",
    gapMarker: "=== catch-up ===\nunavailable",
  },
};

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "vera-run-background-"));
  const store = await createStore({ dataPath: root, debounceMs: 1 });
  const hub = createEventHub({ bufferSize: 50 });
  const agent = store.insert("agents", {
    id: "agt_alpha",
    runtimeRevision: "rev_alpha",
    runtimeProfile: { kind: "cli", provider: "codex" },
  });
  const account = store.insert("accounts", {
    id: "acc_alpha",
    name: "Alpha",
    ownerAgentId: agent.id,
    activeAgentId: agent.id,
  });
  store.insert("accounts", {
    id: "acc_beta",
    name: "Beta",
    ownerAgentId: "agt_beta",
    activeAgentId: "agt_beta",
  });
  const space = store.insert("spaces", {
    id: "spc_group",
    name: "Group",
    activeSpaceSessionId: "sps_group",
    archivedAt: null,
    seats: [
      { accountId: account.id, responseMode: "default" },
      { accountId: "acc_beta", responseMode: "default" },
    ],
  });
  store.insert("spaceSessions", {
    id: "sps_group",
    spaceId: space.id,
    status: "active",
    createdAt: "2026-07-29T00:00:00.000Z",
    archivedAt: null,
    archiveReason: null,
  });
  store.insert("messages", {
    id: "msg_trigger",
    spaceId: space.id,
    spaceSessionId: "sps_group",
    author: { type: "user" },
    target: { type: "broadcast" },
    content: "start",
    runId: null,
    status: "completed",
    createdAt: "2026-07-29T00:00:00.000Z",
  });
  const run = store.insert("runs", {
    id: "run_alpha",
    role: "main",
    parentRunId: null,
    agentId: agent.id,
    accountId: account.id,
    spaceId: space.id,
    spaceSessionId: "sps_group",
    runtimeRevision: agent.runtimeRevision,
    status: "running",
    backgroundEligibleAt: "2026-07-29T00:00:10.000Z",
    backgroundedAt: null,
    createdAt: "2026-07-29T00:00:00.000Z",
    endedAt: null,
  });
  try {
    await fn({ store, hub, agent, account, space, run });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("background overlay waits ten seconds, suppresses raw replay, and injects one summary", async () => {
  await fixture(async ({ store, hub, agent, account, space, run }) => {
    let clock = new Date("2026-07-29T00:00:09.999Z");
    const service = createRunBackgroundService({ store, hub, config: CONFIG, now: () => clock });
    assert.throws(() => service.backgroundRun(run.id), (error) => error.code === "conflict");

    clock = new Date("2026-07-29T00:00:10.000Z");
    const backgrounded = service.backgroundRun(run.id);
    assert.equal(backgrounded.backgroundedAt, clock.toISOString());
    assert.equal(service.isActive(space.id, account.id), true);

    const scheduled = [];
    const missed = postMessage({
      store,
      hub,
      daemonScheduler: { scheduleMainRun(input) { scheduled.push(input); } },
      files: {
        assertMessageFileIds() { return []; },
        projectMessage(message) { return message; },
      },
      runBackground: service,
      spaceId: space.id,
      body: {
        author: { type: "user" },
        target: { type: "direct", accountIds: [account.id] },
        content: "The deployment moved to Friday",
      },
    });
    assert.equal(missed.runs.length, 0);
    assert.equal(scheduled.length, 0, "even a direct mention is suppressed by the background overlay");
    store.insert("messages", {
      id: "msg_own",
      spaceId: space.id,
      spaceSessionId: "sps_group",
      author: { type: "account", accountId: account.id },
      target: { type: "broadcast" },
      content: "Still working",
      runId: run.id,
      status: "completed",
      createdAt: "2026-07-29T00:00:12.000Z",
    });
    const completed = store.update("runs", run.id, {
      status: "completed",
      endedAt: "2026-07-29T00:00:13.000Z",
    });
    const task = service.finishRun(completed, { runtimeKind: "cli" });
    assert.deepEqual(task.sourceMessageIds, [missed.message.id]);
    assert.match(task.input.promptText, /deployment moved to Friday/u);
    assert.doesNotMatch(task.input.promptText, /Still working/u);
    assert.equal(service.shouldHold(space.id, account.id), true);

    store.insert("messages", {
      id: "msg_deferred",
      spaceId: space.id,
      spaceSessionId: "sps_group",
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "what changed?",
      runId: null,
      status: "completed",
      createdAt: "2026-07-29T00:00:14.000Z",
    });
    service.holdTrigger(space.id, account.id, "msg_deferred");
    const resumed = [];
    service.setResumeDeferred((record) => resumed.push(record.deferredTriggerMessageId));
    service.submitResult(task.id, { agent, account }, {
      status: "succeeded",
      summary: "Beta moved the deployment to Friday.",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(resumed, ["msg_deferred"]);

    const context = service.contextForRun({
      spaceId: space.id,
      spaceSessionId: "sps_group",
      accountId: account.id,
      runId: "run_next",
    });
    assert.match(context.block, /Beta moved the deployment to Friday/u);
    service.markDispatched(context.id, "run_next");
    const watermark = service.contextForRun({
      spaceId: space.id,
      spaceSessionId: "sps_group",
      accountId: account.id,
      runId: "run_after",
    });
    assert.equal(watermark.block, null);
    assert.equal(watermark.afterSeq, context.afterSeq);
  });
});
