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
    runtimeProfile: { kind: "cli", provider: "codex", model: "model-a" },
    runtimeBinding: { runtimeSnapshot: { runtimeCapabilities: { models: ["model-a"] } } },
  });
  const account = store.insert("accounts", {
    id: "acc_alpha",
    name: "Alpha",
    ownerAgentId: agent.id,
    activeAgentId: agent.id,
    presence: "online",
    model: "model-a",
    modelVersion: 1,
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
    role: "root",
    rootRunId: "run_alpha",
    parentRunId: null,
    depth: 0,
    outputPolicy: "space",
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
    assert.equal(backgrounded.outputPolicy, "source");
    assert.equal(service.isActive(space.id, account.id), true);

    const scheduled = [];
    let queuedIndex = 0;
    const missed = postMessage({
      store,
      hub,
      daemonScheduler: {
        scheduleRootRun(input) {
          scheduled.push(input);
          queuedIndex += 1;
          return store.insert("runs", {
            id: `run_queued_${queuedIndex}`,
            rootRunId: `run_queued_${queuedIndex}`,
            parentRunId: null,
            role: "root",
            depth: 0,
            outputPolicy: "space",
            agentId: input.agent.id,
            accountId: input.account.id,
            spaceId: input.space.id,
            spaceSessionId: input.spaceSession.id,
            triggerMessageId: input.triggerMessage.id,
            status: "pending",
            deferredByRunId: input.deferredByRunId,
            createdAt: clock.toISOString(),
          });
        },
      },
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
    assert.equal(missed.runs.length, 1);
    assert.equal(scheduled.length, 1, "a direct mention is retained as a deferred Root");
    const ambient = postMessage({
      store,
      hub,
      daemonScheduler: { scheduleRootRun() { throw new Error("broadcast must not trigger"); } },
      files: {
        assertMessageFileIds() { return []; },
        projectMessage(message) { return message; },
      },
      runBackground: service,
      spaceId: space.id,
      body: {
        author: { type: "user" },
        target: { type: "broadcast" },
        content: "The ambient deployment moved to Friday",
      },
    });
    assert.equal(ambient.runs.length, 0);
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
    assert.deepEqual(task.sourceMessageIds, [ambient.message.id]);
    assert.match(task.input.promptText, /ambient deployment moved to Friday/u);
    assert.doesNotMatch(task.input.promptText, /The deployment moved to Friday/u);
    assert.doesNotMatch(task.input.promptText, /Still working/u);
    assert.equal(service.shouldHold(space.id, account.id), true);

    const resumed = [];
    service.setResumePending((record) => resumed.push(...record.pendingRootRunIds));
    service.submitResult(task.id, { agent, account }, {
      status: "succeeded",
      summary: "Beta moved the deployment to Friday.",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(resumed, [missed.runs[0].id]);

    const context = service.contextForRun({
      spaceId: space.id,
      spaceSessionId: "sps_group",
      accountId: account.id,
      runId: missed.runs[0].id,
    });
    assert.match(context.block, /Beta moved the deployment to Friday/u);
    service.markDispatched(context.id, missed.runs[0].id);
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
