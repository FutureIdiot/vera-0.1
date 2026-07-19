import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventHub } from "../../src/api/sse.js";
import { createStore } from "../../src/store/store.js";
import { getActiveContext } from "../../src/spaces/context-sessions.js";
import { createContextCompactionService } from "../../src/spaces/context-compactions.js";

test("daemon compaction dispatches a frozen target and advances generation only after result", async () => {
  const root = await mkdtemp(join(tmpdir(), "vera-daemon-compact-"));
  const store = await createStore({ dataPath: root, debounceMs: 1 });
  const hub = createEventHub({ bufferSize: 100 });
  try {
    const agent = store.insert("agents", {
      id: "agt_compact",
      name: "Compact",
      runtimeProfile: { schemaVersion: 1, kind: "cli", provider: "codex", model: "gpt-test" },
      runtimeBinding: { connection: {} },
      runtimeRevision: "sha256:compact",
      createdAt: "2026-07-19T00:00:00.000Z",
    });
    const account = store.insert("accounts", {
      id: "acc_compact",
      name: "Compact",
      ownerAgentId: agent.id,
      activeAgentId: agent.id,
      presence: "online",
      createdAt: "2026-07-19T00:00:00.000Z",
    });
    const space = store.insert("spaces", {
      id: "spc_compact",
      name: "Compact",
      seats: [{ accountId: account.id, responseMode: "default" }],
      createdAt: "2026-07-19T00:00:00.000Z",
    });
    const { spaceSession, agentSession } = getActiveContext(store, {
      spaceId: space.id,
      accountId: account.id,
      agentId: agent.id,
    });
    store.insert("messages", {
      id: "msg_compact",
      spaceId: space.id,
      spaceSessionId: spaceSession.id,
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "checkpoint source",
      fileIds: [],
      runId: null,
      status: "completed",
      createdAt: "2026-07-19T00:00:01.000Z",
    });
    let dispatched;
    let service;
    service = createContextCompactionService({
      store,
      hub,
      config: {
        viewCompiler: { groupDeltaMaxChars: 4000 },
        context: { checkpointRecentTurns: 4 },
        agentDaemon: { sessionTimeoutMs: 1000 },
      },
      dispatchDaemonCompaction(request) {
        dispatched = request;
        setImmediate(() => {
          const data = request.event.data;
          const job = store.find("contextCompactionJobs", data.jobId);
          const target = job.targets.find((item) => item.agentId === data.target.agentId);
          service.submitDaemonResult({
            job,
            target,
            input: {
              agentSessionId: target.agentSessionId,
              fromGeneration: target.fromGeneration,
              status: "succeeded",
              checkpoint: data.input.checkpoint,
            },
          });
        });
      },
    });
    const job = service.enqueue({ spaceId: space.id, requestId: "manual-daemon" });
    let completed;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      completed = service.getJob(job.id);
      if (completed.status === "succeeded") break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(dispatched.event.type, "agent-session.compact.requested");
    assert.deepEqual(dispatched.event.data.target, {
      agentId: agent.id,
      agentSessionId: agentSession.id,
      fromGeneration: 1,
      mode: "checkpoint_new_binding",
    });
    assert.equal("providerBinding" in dispatched.event.data.input, false);
    assert.equal(completed.status, "succeeded");
    assert.equal(store.find("agentSessions", agentSession.id).generation, 2);
    assert.equal(store.list("messages").length, 1, "compaction must not create chat output");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
