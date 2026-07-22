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

function requested(input, overrides = {}) {
  return {
    type: "run.requested",
    data: {
      run: {
        id: "run_a", agentId: "agt_a", accountId: "acc_a", accountSessionId: "acs_a",
        runtimeRevision: "rev_a", executionLeaseId: "lease_a", workspaceHostId: "host_a", delegated: false,
        effectiveModel: "model_a", modelVersion: 1,
        spaceSessionId: "sps_a", agentSessionId: input.sessionMode === "main" ? "ags_a" : null,
        contextGeneration: input.sessionMode === "main" ? 2 : null,
        ...overrides,
      },
      triggerMessage: { id: "msg_trigger" },
      agent: { id: "agt_a", name: "Agent A" },
      account: { id: "acc_a", ownerAgentId: "agt_a", activeAgentId: "agt_a" },
      workspace: { hostId: "host_a", status: "ready" },
      input,
    },
  };
}

function fixture({ envelopes = [], executor, eventResponses, maxConnectionFailures = 3 } = {}) {
  const calls = [];
  let loginCount = 0;
  let eventsCount = 0;
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, headers: init.headers, body, redirect: init.redirect });
    if (url.endsWith("/api/agent/login")) {
      loginCount += 1;
      return new Response(JSON.stringify({
        accountSession: { id: "acs_a", ...(loginCount === 1 ? { token: "session-secret" } : {}), gatewayBootId: "gw_a" },
        heartbeatIntervalMs: 10000,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/agent/events")) {
      const response = eventResponses
        ? eventResponses[eventsCount] ?? new Response(stream([]), { status: 200 })
        : eventsCount === 0 ? new Response(stream(envelopes), { status: 200 }) : null;
      eventsCount += 1;
      if (!response) throw new Error("connection failed");
      return response;
    }
    if (url.endsWith("/api/agent/memory-tasks/events")) return new Response(stream([]), { status: 200 });
    if (url.includes("/messages")) {
      return new Response(JSON.stringify({ id: `msg_${calls.length}`, content: body.content }), { status: 201 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = createDaemonClient({
    gatewayUrl: "https://gateway.test", agentId: "agt_a", accountId: "acc_a",
    runtime: { hostId: "host_a", kind: "api", provider: "ollama", model: "model_a", revision: "rev_a" },
    workspace: { hostId: "host_a", path: "/workspace", status: "ready", policy: {} },
    credentialStore: { load: async () => ({ agentToken: TOKEN, accountKey: KEY }) },
    executor: executor ?? (async () => ({ content: "reply" })), fetchImpl, daemonBootId: "boot_a",
    maxConnectionFailures, reconnectBaseMs: 0,
    sleep: async () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  return { client, calls };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("initial login uses persistent credentials once and SSE/reports use only process session", async () => {
  const envelopes = [
    { type: "agent.heartbeat", data: { ts: "now" } },
    requested({ kind: "api", sessionMode: "main", messages: [{ role: "user", content: "hi" }], historyVersion: 0 }),
  ];
  const { client, calls } = fixture({
    envelopes,
    executor: async ({ onDelta }) => {
      await onDelta("reply");
      return { content: "reply", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  });
  await client.start();
  await client.wait();
  await settle();

  const login = calls.find((call) => call.url.endsWith("/login"));
  assert.equal(login.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(login.headers["X-Vera-Account-Key"], KEY);
  assert.equal(login.body.daemonBootId, "boot_a");
  assert.equal("connection" in login.body.runtime, false);
  assert.deepEqual(login.body.runtime.runtimeCapabilities.models, ["model_a"]);
  const sessionCalls = calls.filter((call) =>
    !call.url.endsWith("/login") && !call.url.includes("/memory-tasks/"));
  assert.ok(sessionCalls.every((call) => call.headers["X-Vera-Account-Session"] === "session-secret"));
  assert.ok(sessionCalls.every((call) => !("X-Vera-Account-Key" in call.headers)));
  const memoryCalls = calls.filter((call) => call.url.includes("/memory-tasks/"));
  assert.ok(memoryCalls.every((call) => call.headers.Authorization === `Bearer ${TOKEN}`));
  assert.ok(memoryCalls.every((call) => !("X-Vera-Account-Session" in call.headers) && !("X-Vera-Account-Key" in call.headers)));
  assert.ok(calls.every((call) => call.redirect === "error"));
  const apiResult = calls.find((call) => call.url.endsWith("/api-result"));
  assert.equal(apiResult.body.agentSessionId, "ags_a");
  assert.equal(apiResult.body.generation, 2);
  assert.equal(apiResult.body.baseHistoryVersion, 0);
  assert.equal(apiResult.body.assistantMessageIds.length, 1);
  assert.match(apiResult.body.assistantMessageIds[0], /^msg_/u);
  assert.deepEqual(apiResult.body.usage, { inputTokens: 1, outputTokens: 1 });
  assert.equal(calls.find((call) => call.method === "PATCH" && call.body?.status === "completed")?.body.status, "completed");
  assert.equal(JSON.stringify(calls).includes("session-secret"), true);
});

test("session reconnect never falls back to Account Key when reauthentication is required", async () => {
  let events = 0;
  let logins = 0;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (url.endsWith("/login")) {
      logins += 1;
      if (logins > 1) return new Response(JSON.stringify({ error: { code: "account_reauthentication_required" } }), { status: 401 });
      return new Response(JSON.stringify({ accountSession: { id: "acs_a", token: "session-secret", gatewayBootId: "gw" }, heartbeatIntervalMs: 10000 }), { status: 200 });
    }
    if (url.endsWith("/api/agent/memory-tasks/events")) return new Response(stream([]), { status: 200 });
    events += 1;
    throw new Error("connection failed");
  };
  const client = createDaemonClient({
    gatewayUrl: "https://gateway.test", agentId: "agt_a", accountId: "acc_a",
    runtime: { hostId: "host_a", kind: "cli", provider: "codex", model: "m", revision: "rev_a" },
    workspace: { hostId: "host_a" }, credentialStore: { load: async () => ({ agentToken: TOKEN, accountKey: KEY }) },
    executor: async () => ({}), fetchImpl, daemonBootId: "boot_a", reconnectBaseMs: 0, sleep: async () => {},
  });
  await client.start();
  const result = await client.wait();

  assert.equal(result.reason, "account_reauthentication_required");
  assert.equal(events, 1);
  assert.equal(logins, 2);
  assert.equal(calls[0].headers["X-Vera-Account-Key"], KEY);
  assert.equal(calls[1].headers["X-Vera-Account-Session"], "session-secret");
  assert.equal(calls.slice(1).some((call) => call.headers["X-Vera-Account-Key"]), false);
});

test("SSE reconnect resumes from the last event sequence", async () => {
  const first = new Response(stream([{ seq: 41, type: "agent.heartbeat", data: { ts: "now" } }]), { status: 200 });
  const { client, calls } = fixture({ eventResponses: [first], maxConnectionFailures: 2 });
  await client.start();
  await client.wait();

  const eventCalls = calls.filter((call) => call.url.endsWith("/api/agent/events"));
  assert.equal(eventCalls[0].headers["Last-Event-ID"], undefined);
  assert.equal(eventCalls[1].headers["Last-Event-ID"], "41");
});

test("three failed connection cycles stop daemon and abort active executors without leaking errors", async () => {
  const eventResponses = [
    new Response(stream([requested({ kind: "cli", sessionMode: "main", promptText: "work" })]), { status: 200 }),
  ];
  let aborted = false;
  const { client, calls } = fixture({
    eventResponses,
    maxConnectionFailures: 3,
    executor: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve({}); }, { once: true });
    }),
  });
  await client.start();
  const result = await client.wait();
  await settle();

  assert.equal(result.reason, "gateway_unreachable");
  assert.equal(aborted, true);
  const finalPatch = calls.filter((call) => call.method === "PATCH").at(-1);
  assert.equal(finalPatch.body.error.code, "gateway_unreachable");
  assert.equal(JSON.stringify(finalPatch.body).includes(TOKEN), false);
  assert.equal(JSON.stringify(finalPatch.body).includes(KEY), false);
});
