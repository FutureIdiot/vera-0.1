import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventHub } from "../../src/api/sse.js";
import { postMessage } from "../../src/spaces/messages.js";
import { createStore } from "../../src/store/store.js";

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

async function waitForTerminalRun(store, runId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = store.find("runs", runId);
    if (run && !["pending", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`run ${runId} did not finish`);
}

test("direct @ skips an offline Account, writes one error Activity, and is never replayed", async () => {
  const root = await mkdtemp(join(tmpdir(), "vera-offline-account-test-"));
  const store = await createStore({ dataPath: join(root, "data"), debounceMs: 5 });
  const hub = createEventHub({ bufferSize: 100 });
  const captured = captureEvents(hub);
  try {
    const agent = store.insert("agents", {
      id: "agt_offline",
      name: "Offline Agent",
      runtimeProfile: { schemaVersion: 1, kind: "cli", provider: "codex", model: "test-model" },
      runtimeBinding: { connection: {} },
      runtimeRevision: "sha256:test-runtime",
      createdAt: "2026-07-19T00:00:00.000Z",
    });
    const account = store.insert("accounts", {
      id: "acc_offline",
      name: "Offline",
      ownerAgentId: agent.id,
      presence: "offline",
      lastSeenAt: "2026-07-19T00:00:00.000Z",
      activeAgentId: null,
      createdAt: "2026-07-19T00:00:00.000Z",
    });
    const space = store.insert("spaces", {
      id: "spc_offline",
      name: "Offline test",
      seats: [{ accountId: account.id, responseMode: "default" }],
      createdAt: "2026-07-19T00:00:00.000Z",
    });
    const files = {
      assertMessageFileIds() { return []; },
      projectMessage(message) { return message; },
    };
    let adapterCalls = 0;
    const dependencies = {
      store,
      hub,
      config: CONFIG,
      resolveAdapter() {
        return {
          async run() {
            adapterCalls += 1;
            return { content: "online reply" };
          },
        };
      },
      files,
      spaceId: space.id,
    };

    const skipped = postMessage({
      ...dependencies,
      body: {
        author: { type: "user" },
        target: { type: "direct", accountIds: [account.id] },
        content: "are you there?",
      },
    });

    assert.equal(skipped.runs.length, 0);
    assert.equal(store.list("runs").length, 0);
    assert.equal(adapterCalls, 0);
    assert.equal(store.list("activities").length, 1);
    assert.deepEqual(
      (({ _seq, updatedAt, ...activity }) => activity)(store.list("activities")[0]),
      {
        id: store.list("activities")[0].id,
        spaceId: space.id,
        spaceSessionId: skipped.message.spaceSessionId,
        runId: null,
        accountId: account.id,
        agentId: null,
        phase: "error",
        label: "agent-offline",
        detail: "Offline Account当前离线，已跳过此条",
        toolStatus: null,
        createdAt: store.list("activities")[0].createdAt,
      },
    );
    assert.equal(captured.events.filter((event) => event.type === "activity.created").length, 1);

    store.update("accounts", account.id, {
      presence: "online",
      activeAgentId: agent.id,
      lastSeenAt: "2026-07-19T00:01:00.000Z",
    });
    assert.equal(store.list("runs").length, 0, "coming online must not replay the missed @");

    const delivered = postMessage({
      ...dependencies,
      body: {
        author: { type: "user" },
        target: { type: "direct", accountIds: [account.id] },
        content: "now?",
      },
    });
    assert.equal(delivered.runs.length, 1);
    const terminal = await waitForTerminalRun(store, delivered.runs[0].id);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.triggerMessageId, delivered.message.id);
    assert.equal(adapterCalls, 1);
    assert.equal(store.list("activities").length, 1);
  } finally {
    captured.unsubscribe();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
