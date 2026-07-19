import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRouter } from "../../src/api/router.js";
import { createEventHub } from "../../src/api/sse.js";
import { createUnownedAccount } from "../../src/agents/accounts.js";
import { createControlService } from "../../src/agents/control-service.js";
import { createDaemonRuntime } from "../../src/agents/daemon-runtime.js";
import { registerAgentRoutes } from "../../src/agents/routes.js";
import { createStore } from "../../src/store/store.js";

function request(router, method, url, body, headers = {}) {
  let status;
  let payload = "";
  const req = {
    method, url, headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
  const res = {
    setHeader() {},
    writeHead(nextStatus) { status = nextStatus; },
    end(chunk = "") { payload += chunk; },
  };
  return router.handle(req, res).then(() => ({ status, json: payload ? JSON.parse(payload) : null }));
}

async function fixture(run) {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-daemon-runtime-"));
  const store = await createStore({ dataPath, debounceMs: 1 });
  const hub = createEventHub({ bufferSize: 100 });
  const config = { agentDaemon: { tokensPath: join(dataPath, "tokens.json"), heartbeatIntervalMs: 15000 } };
  const controlService = createControlService({ store, hub, config });
  const setupRouter = createRouter();
  registerAgentRoutes(setupRouter, { store, controlService, agentStates: { list() { return []; } } });
  try {
    const created = createUnownedAccount(store, { name: "Runtime Account" });
    const enrolled = await request(setupRouter, "POST", "/api/agent/enroll", {
      accountId: created.account.id,
      agent: { name: "Runtime Agent" },
      runtimeProfile: { schemaVersion: 1, kind: "cli", provider: "mock", model: "mock-v1" },
    }, { authorization: `Bearer ${created.accessKey}` });
    const login = await request(setupRouter, "POST", "/api/agent/login", {
      accountId: created.account.id,
      daemonBootId: "daemon-runtime",
      runtime: {
        hostId: "host-runtime", kind: "cli", provider: "mock", model: "mock-v1",
        revision: "sha256:runtime", runtimeCapabilities: { tools: [] },
      },
      workspace: {
        hostId: "host-runtime", path: "/srv/runtime", status: "ready", policy: { allow: ["read"] },
      },
    }, {
      authorization: `Bearer ${enrolled.json.agentToken}`,
      "x-vera-account-key": created.accessKey,
    });
    const accountId = created.account.id;
    const agentId = enrolled.json.agent.id;
    const session = login.json.accountSession;
    const headers = {
      authorization: `Bearer ${enrolled.json.agentToken}`,
      "x-vera-account-session": session.token,
    };
    store.insert("agentSessions", {
      id: "ags_runtime", spaceId: "spc_runtime", spaceSessionId: "sps_runtime",
      accountId, agentId, generation: 1, status: "active", context: {}, checkpoints: [],
    });
    store.insert("messages", {
      id: "msg_trigger", spaceId: "spc_runtime", spaceSessionId: "sps_runtime",
      author: { type: "user" }, target: { type: "broadcast" }, content: "do work",
      fileIds: [], runId: null, status: "completed", createdAt: "2026-07-19T00:00:00.000Z",
    });
    store.insert("runs", {
      id: "run_runtime", role: "main", parentRunId: null, spaceId: "spc_runtime",
      spaceSessionId: "sps_runtime", agentSessionId: "ags_runtime", contextGeneration: 1,
      accountId, agentId, runtimeRevision: "sha256:runtime", effectiveModel: "mock-v1",
      delegated: false, triggerMessageId: "msg_trigger", replyMessageIds: [], status: "running",
      executionTransport: "daemon", accountSessionId: session.id, executionLeaseId: "exl_runtime",
      workspaceHostId: "host-runtime", leaseAcquiredAt: "2026-07-19T00:00:00.000Z",
      createdAt: "2026-07-19T00:00:00.000Z", endedAt: null,
    });
    await run({ store, hub, config, controlService, accountId, agentId, session, headers });
  } finally {
    await store.close();
    await rm(dataPath, { recursive: true, force: true });
  }
}

test("daemon Run endpoints authenticate the current Session lease and delegate strict inputs", async () => {
  await fixture(async ({ store, hub, config, controlService, accountId, agentId, headers }) => {
    const calls = [];
    const lifecycle = Object.fromEntries([
      "createSubagent", "updateRun", "createMessage", "appendDelta",
      "upsertActivity", "createApproval", "submitCompactionResult",
    ].map((name) => [name, async (input) => { calls.push({ name, input }); return { ok: name }; }]));
    const daemonRuntime = createDaemonRuntime({ store, hub, config, controlService, runLifecycle: lifecycle });
    const router = createRouter();
    registerAgentRoutes(router, { store, controlService, daemonRuntime, agentStates: { list() { return []; } } });
    store.insert("contextCompactionJobs", {
      id: "ccj_runtime", spaceId: "spc_runtime", spaceSessionId: "sps_runtime", status: "running",
      targets: [{
        agentId, accountId, agentSessionId: "ags_runtime", fromGeneration: 1,
        mode: "checkpoint_new_binding", status: "running",
      }],
    });

    const requests = [
      ["POST", "/api/agent/runs/run_runtime/subagents", { task: "inspect" }, 201],
      ["POST", "/api/agent/runs/run_runtime/messages", { content: "hello" }, 201],
      ["POST", "/api/agent/runs/run_runtime/delta", { delta: "hel" }, 200],
      ["POST", "/api/agent/runs/run_runtime/activities", { phase: "coding", callId: "call-1" }, 200],
      ["POST", "/api/agent/runs/run_runtime/approvals", { prompt: "allow?", options: ["allow", "deny"] }, 201],
      ["PATCH", "/api/agent/runs/run_runtime", { status: "completed" }, 200],
      ["PUT", `/api/agent/compactions/ccj_runtime/targets/${agentId}`, {
        agentSessionId: "ags_runtime", fromGeneration: 1, status: "failed",
        error: { code: "context_capacity", message: "failed safely" },
      }, 200],
    ];
    for (const [method, path, body, expected] of requests) {
      const response = await request(router, method, path, body, headers);
      assert.equal(response.status, expected, `${method} ${path}`);
    }
    assert.deepEqual(calls.map((call) => call.name), [
      "createSubagent", "createMessage", "appendDelta", "upsertActivity", "createApproval", "updateRun",
      "submitCompactionResult",
    ]);
    assert.ok(calls.slice(0, 6).every((call) => call.input.run.id === "run_runtime"));
    assert.equal(calls.at(-1).input.target.accountId, accountId);

    const invalidSession = await request(router, "POST", "/api/agent/runs/run_runtime/delta", { delta: "x" }, {
      ...headers, "x-vera-account-session": "vas_invalid",
    });
    assert.equal(invalidSession.status, 401);
    const keyOnRuntime = await request(router, "POST", "/api/agent/runs/run_runtime/delta", { delta: "x" }, {
      ...headers, "x-vera-account-key": "must-not-be-used",
    });
    assert.equal(keyOnRuntime.status, 400);
    const unknownField = await request(router, "POST", "/api/agent/runs/run_runtime/delta", {
      delta: "x", accountId: "acc_forged",
    }, headers);
    assert.equal(unknownField.status, 400);
  });
});

test("daemon SSE is independently authenticated and dispatchRun is Account-directed", async () => {
  await fixture(async ({ store, hub, config, controlService, accountId, headers }) => {
    const timers = [];
    const daemonRuntime = createDaemonRuntime({
      store, hub, config, controlService,
      setTimer(callback) { timers.push(callback); return callback; },
      clearTimer() {},
    });
    const closeListeners = [];
    const frames = [];
    const req = {
      url: "/api/agent/events", headers,
      on(type, listener) { if (type === "close") closeListeners.push(listener); },
    };
    const res = {
      writeHead(status, responseHeaders) {
        assert.equal(status, 200);
        assert.equal(responseHeaders["Content-Type"], "text/event-stream");
      },
      write(frame) { frames.push(frame); },
      flushHeaders() {},
    };
    await daemonRuntime.openEvents(req, res);
    daemonRuntime.dispatchRun({
      accountId,
      event: { type: "run.requested", data: { run: { id: "run_runtime", accountId } } },
    });
    daemonRuntime.dispatchRun({
      accountId,
      event: { type: "approval.answered", data: { approvalId: "apr_runtime", answer: "allow" } },
    });
    timers[0]();
    assert.match(frames.join(""), /"type":"run\.requested"/u);
    assert.match(frames.join(""), /"type":"approval\.answered"/u);
    assert.match(frames.join(""), /"type":"agent\.heartbeat"/u);
    assert.throws(
      () => daemonRuntime.dispatchRun({
        accountId: "acc_forged",
        event: { type: "run.requested", data: { run: { accountId } } },
      }),
      (error) => error.code === "invalid_request",
    );
    closeListeners[0]();
  });
});

test("provider binding CAS is limited to the active CLI Execution and rejects unsafe state", async () => {
  await fixture(async ({ store, hub, config, controlService, accountId, agentId, headers }) => {
    const daemonRuntime = createDaemonRuntime({ store, hub, config, controlService });
    const saved = await daemonRuntime.saveProviderBinding("ags_runtime", {
      generation: 1,
      accountId,
      agentId,
      runtimeRevision: "sha256:runtime",
      providerState: { threadId: "thread-1" },
      ifVersion: null,
    }, headers);
    assert.equal(saved.version, 1);
    await assert.rejects(
      daemonRuntime.saveProviderBinding("ags_runtime", {
        generation: 1,
        accountId,
        agentId,
        runtimeRevision: "sha256:runtime",
        providerState: { secretToken: "leak" },
        ifVersion: 1,
      }, headers),
      (error) => error.code === "invalid_request",
    );
  });
});

test("API main completion remains blocked until api-result history CAS succeeds", async () => {
  await fixture(async ({ store, hub, config, controlService, headers }) => {
    const agent = store.find("agents", store.find("runs", "run_runtime").agentId);
    store.update("agents", agent.id, {
      runtimeProfile: { ...agent.runtimeProfile, kind: "api" },
    });
    const lifecycle = { updateRun: async () => ({ run: { id: "run_runtime", status: "completed" } }) };
    const daemonRuntime = createDaemonRuntime({ store, hub, config, controlService, runLifecycle: lifecycle });
    await assert.rejects(
      daemonRuntime.updateRun("run_runtime", { status: "completed" }, headers),
      (error) => error.code === "history_conflict",
    );
    store.insert("messages", {
      id: "msg_reply", runId: "run_runtime", content: "done", status: "completed",
      createdAt: "2026-07-19T00:00:01.000Z",
    });
    const result = await daemonRuntime.saveApiResult("run_runtime", {
      agentSessionId: "ags_runtime", generation: 1, baseHistoryVersion: 0,
      assistantMessageIds: ["msg_reply"], usage: { inputTokens: 1, outputTokens: 1 },
    }, headers);
    assert.equal(result.historyVersion, 1);
    const completed = await daemonRuntime.updateRun("run_runtime", { status: "completed" }, headers);
    assert.equal(completed.run.status, "completed");
  });
});
