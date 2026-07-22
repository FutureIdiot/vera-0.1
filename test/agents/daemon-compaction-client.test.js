import test from "node:test";
import assert from "node:assert/strict";

import { createDaemonClient } from "../../src/agents/daemon-client.js";

const TOKEN = `vat_${"a".repeat(43)}`;
const KEY = `vak_${"b".repeat(43)}`;

function stream(frames) {
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.close();
    },
  });
}

function fixture({ envelopes, runtime, executor }) {
  const calls = [];
  let eventsCount = 0;
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, headers: init.headers, body });
    if (url.endsWith("/api/agent/login")) {
      return new Response(JSON.stringify({
        accountSession: { id: "acs_a", token: "session-secret", gatewayBootId: "gw_a" },
        heartbeatIntervalMs: 10000,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/agent/events")) {
      if (eventsCount++ === 0) return new Response(stream(envelopes), { status: 200 });
      throw new Error("connection failed");
    }
    if (url.endsWith("/api/agent/memory-tasks/events")) return new Response(stream([]), { status: 200 });
    if (url.includes("/messages")) return new Response(JSON.stringify({ id: "msg_reply" }), { status: 201 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = createDaemonClient({
    gatewayUrl: "https://gateway.test", agentId: "agt_a", accountId: "acc_a", runtime,
    workspace: { hostId: "host_a", path: "/workspace", status: "ready", policy: {} },
    credentialStore: { load: async () => ({ agentToken: TOKEN, accountKey: KEY }) },
    executor, fetchImpl, daemonBootId: "boot_a", maxConnectionFailures: 2,
    reconnectBaseMs: 0, sleep: async () => {},
  });
  return { client, calls };
}

function compactRequested({ jobId, mode, fromGeneration = 2, input, account = {} }) {
  return {
    type: "agent-session.compact.requested",
    data: {
      jobId,
      target: { agentId: "agt_a", agentSessionId: "ags_a", fromGeneration, mode },
      account: { id: "acc_a", name: "Account A", ownerAgentId: "agt_a", ...account },
      input,
    },
  };
}

function requestedApiRun() {
  return {
    type: "run.requested",
    data: {
      run: {
        id: "run_a", agentId: "agt_a", accountId: "acc_a", accountSessionId: "acs_a",
        runtimeRevision: "rev_a", executionLeaseId: "lease_a", workspaceHostId: "host_a", delegated: false,
        effectiveModel: "m", modelVersion: 1,
        spaceSessionId: "sps_a", agentSessionId: "ags_a", contextGeneration: 2,
      },
      triggerMessage: { id: "msg_trigger" },
      agent: { id: "agt_a", name: "Agent A" },
      account: { id: "acc_a", ownerAgentId: "agt_a", activeAgentId: "agt_a" },
      workspace: { hostId: "host_a", status: "ready" },
      input: { kind: "api", sessionMode: "main", messages: [], historyVersion: 0 },
    },
  };
}

test("gateway checkpoint compactions are confirmed unchanged once without chat execution", async () => {
  for (const [mode, kind] of [["gateway_history", "api"], ["checkpoint_new_binding", "cli"]]) {
    const checkpoint = { schemaVersion: 1, summary: `${mode} stable`, sourceMessageIds: ["msg_a"] };
    const event = compactRequested({ jobId: `ccj_${mode}`, mode, input: { checkpoint } });
    let executions = 0;
    const { client, calls } = fixture({
      envelopes: [event, event],
      runtime: { hostId: "host_a", kind, provider: kind === "api" ? "ollama" : "codex", model: "m", revision: "rev_a" },
      executor: { execute: async () => { executions += 1; return { content: "must not run" }; } },
    });
    await client.start();
    await client.wait();
    const results = calls.filter((call) => call.url.includes(`/compactions/ccj_${mode}/`));
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].body, {
      agentSessionId: "ags_a", fromGeneration: 2, status: "succeeded", checkpoint,
    });
    assert.equal(executions, 0);
    assert.equal(calls.some((call) => call.url.includes("/runs/")), false);
  }
});

test("native compaction fails closed without compactSession and accepts only a safe binding", async () => {
  const runtime = { hostId: "host_a", kind: "cli", provider: "codex", model: "m", revision: "rev_a" };
  const input = { providerBinding: {
    agentSessionId: "ags_a", generation: 2, accountId: "acc_a",
    providerFingerprint: "sha256:current", providerState: { threadId: "thread-a" }, version: 1,
  } };
  const unavailable = fixture({
    envelopes: [compactRequested({ jobId: "ccj_unavailable", mode: "native", input })],
    runtime, executor: { execute: async () => ({}) },
  });
  await unavailable.client.start();
  await unavailable.client.wait();
  assert.deepEqual(unavailable.calls.find((call) => call.url.includes("ccj_unavailable"))?.body, {
    agentSessionId: "ags_a", fromGeneration: 2, status: "failed",
    error: { code: "context_capacity", message: "Context compaction failed" },
  });

  const safe = { accountId: "acc_a", providerFingerprint: "sha256:next", providerState: { threadId: "thread-b" } };
  const supported = fixture({
    envelopes: [compactRequested({ jobId: "ccj_supported", mode: "native", input })], runtime,
    executor: { execute: async () => ({}), compactSession: async () => ({ providerBinding: safe }) },
  });
  await supported.client.start();
  await supported.client.wait();
  assert.deepEqual(supported.calls.find((call) => call.url.includes("ccj_supported"))?.body, {
    agentSessionId: "ags_a", fromGeneration: 2, status: "succeeded", providerBinding: safe,
  });

  const unsafe = fixture({
    envelopes: [compactRequested({ jobId: "ccj_unsafe", mode: "native", input })], runtime,
    executor: { execute: async () => ({}), compactSession: async () => ({ providerBinding: {
      accountId: "acc_a", providerFingerprint: "sha256:unsafe", providerState: { apiToken: "must-not-leak" },
    } }) },
  });
  await unsafe.client.start();
  await unsafe.client.wait();
  assert.equal(unsafe.calls.find((call) => call.url.includes("ccj_unsafe"))?.body.status, "failed");
});

test("native compaction aborts on Account stream disconnect and reports cancelled", async () => {
  let aborted = false;
  const input = { providerBinding: {
    agentSessionId: "ags_a", generation: 2, accountId: "acc_a",
    providerFingerprint: "sha256:current", providerState: { threadId: "thread-a" },
  } };
  const { client, calls } = fixture({
    envelopes: [compactRequested({ jobId: "ccj_cancel", mode: "native", input })],
    runtime: { hostId: "host_a", kind: "cli", provider: "codex", model: "m", revision: "rev_a" },
    executor: { execute: async () => ({}), compactSession: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        resolve({ providerBinding: input.providerBinding });
      }, { once: true });
    }) },
  });
  await client.start();
  await client.wait();
  assert.equal(aborted, true);
  assert.deepEqual(calls.find((call) => call.url.includes("ccj_cancel"))?.body, {
    agentSessionId: "ags_a", fromGeneration: 2, status: "cancelled",
  });
});

test("compaction rejects mismatched account, generation, mode and non-checkpoint input", async () => {
  const checkpoint = { checkpoint: { schemaVersion: 1, summary: "stable" } };
  const { client, calls } = fixture({
    envelopes: [
      requestedApiRun(),
      compactRequested({ jobId: "ccj_generation", mode: "gateway_history", fromGeneration: 3, input: checkpoint }),
      compactRequested({ jobId: "ccj_fields", mode: "gateway_history", input: { ...checkpoint, providerBinding: null } }),
      compactRequested({ jobId: "ccj_account", mode: "gateway_history", input: checkpoint, account: { id: "acc_other" } }),
      compactRequested({ jobId: "ccj_mode", mode: "checkpoint_new_binding", input: checkpoint }),
    ],
    runtime: { hostId: "host_a", kind: "api", provider: "ollama", model: "m", revision: "rev_a" },
    executor: async () => ({ content: "run establishes generation" }),
  });
  await client.start();
  await client.wait();
  assert.equal(calls.some((call) => call.url.includes("/compactions/")), false);
});
