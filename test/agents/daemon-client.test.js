import test from "node:test";
import assert from "node:assert/strict";

import { createDaemonClient } from "../../src/agents/daemon-client.js";
import { activityAgentStatus } from "../../src/agents/daemon-run-handler.js";

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

function fixture({ envelopes = [], memoryEnvelopes = [], executor, memoryExecutor, eventResponses, loginStatus = 200, maxConnectionFailures = 3 } = {}) {
  const calls = [];
  let loginCount = 0;
  let eventsCount = 0;
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, headers: init.headers, body, redirect: init.redirect });
    if (url.endsWith("/api/agent/login")) {
      loginCount += 1;
      if (loginStatus !== 200) return new Response(JSON.stringify({ error: { code: "account_reauthentication_required" } }), { status: loginStatus });
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
    if (url.endsWith("/api/agent/memory-tasks/events")) {
      return new Response(stream(memoryEnvelopes), { status: 200 });
    }
    if (url.includes("/messages")) {
      return new Response(JSON.stringify({ id: `msg_${calls.length}`, content: body.content }), { status: 201 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = createDaemonClient({
    gatewayUrl: "https://gateway.test",
    agentId: "agt_a",
    accountId: "acc_a",
    runtime: {
      hostId: "host_a", kind: "api", provider: "ollama", model: "model_a", revision: "rev_a",
      runtimeCapabilities: { models: ["model_a", "model_b"] },
    },
    workspace: { hostId: "host_a", path: "/workspace", status: "ready", policy: {} },
    credentialStore: { load: async () => ({ agentToken: TOKEN, accountKey: KEY }) },
    executor: executor ?? (async () => ({ content: "reply" })),
    memoryExecutor,
    fetchImpl,
    daemonBootId: "boot_a",
    maxConnectionFailures,
    reconnectBaseMs: 0,
    sleep: async () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  return { client, calls };
}

function requested(input, overrides = {}) {
  return {
    type: "run.requested",
    data: {
      run: {
        id: "run_a", agentId: "agt_a", accountId: "acc_a", accountSessionId: "acs_a",
        spaceId: "spc_a",
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
      activityVisibility: "status-only",
    },
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("public execution activities map to stable AgentState phases", () => {
  assert.equal(activityAgentStatus({ kind: "reasoning" }), "thinking");
  assert.equal(activityAgentStatus({ kind: "plan" }), "planning");
  assert.equal(activityAgentStatus({ kind: "search" }), "searching");
  assert.equal(activityAgentStatus({ kind: "read" }), "reading");
  assert.equal(activityAgentStatus({ kind: "edit" }), "coding");
  assert.equal(activityAgentStatus({ kind: "command", label: "npm test" }), "testing");
  assert.equal(activityAgentStatus({ kind: "command", summary: "review PR 42" }), "reviewing");
  assert.equal(activityAgentStatus({ kind: "tool", label: "create subagent" }), "delegating");
  assert.equal(activityAgentStatus({ kind: "compact" }), "compacting");
  assert.equal(activityAgentStatus({ kind: "tool" }), "on_task");
});

test("CLI isolated input stays isolated and does not submit API history", async () => {
  const input = { kind: "cli", sessionMode: "isolated", promptText: "bounded prompt" };
  let received;
  const { client, calls } = fixture({ envelopes: [requested(input, { effectiveModel: "model_b" })], executor: async (context) => {
    received = { input: context.input, effectiveModel: context.run.effectiveModel };
    await context.onDelta("done", { paragraphEnd: true });
    return { content: "done" };
  } });
  await client.start();
  await client.wait();
  await settle();

  assert.deepEqual(received, { input, effectiveModel: "model_b" });
  assert.equal(calls.some((call) => call.url.endsWith("/api-result")), false);
  assert.equal(calls.find((call) => call.url.endsWith("/delta")).body.paragraphEnd, true);
  const statePatches = calls
    .filter((call) => call.method === "PATCH" && call.body?.agentState)
    .map((call) => call.body.agentState.status);
  assert.deepEqual(statePatches, ["on_task", "typing", "idle"]);
  assert.equal(calls.find((call) => call.method === "PATCH" && call.body?.status === "completed")?.body.status, "completed");
});

test("requestApproval posts once and resolves only its approval.answered event", async () => {
  const calls = [];
  let accountController;
  let loginCount = 0;
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, headers: init.headers, body });
    if (url.endsWith("/login")) {
      loginCount += 1;
      return new Response(JSON.stringify({
        accountSession: { id: "acs_a", ...(loginCount === 1 ? { token: "session-secret" } : {}), gatewayBootId: "gw" },
        heartbeatIntervalMs: 10000,
      }), { status: 200 });
    }
    if (url.endsWith("/api/agent/memory-tasks/events")) return new Response(stream([]), { status: 200 });
    if (url.endsWith("/api/agent/events")) {
      return new Response(new ReadableStream({
        start(controller) {
          accountController = controller;
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(requested(
            { kind: "cli", sessionMode: "isolated", promptText: "approve" },
            { effectiveModel: "m" },
          ))}\n\n`));
        },
      }), { status: 200 });
    }
    if (url.endsWith("/approvals")) {
      setTimeout(() => {
        accountController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
          type: "approval.answered", data: { approvalId: "apr_a", answer: "allow" },
        })}\n\n`));
        setTimeout(() => accountController.close(), 5);
      }, 0);
      return new Response(JSON.stringify({ approval: { id: "apr_a" } }), { status: 201 });
    }
    if (url.endsWith("/messages")) return new Response(JSON.stringify({ message: { id: "msg_reply" } }), { status: 201 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = createDaemonClient({
    gatewayUrl: "https://gateway.test", agentId: "agt_a", accountId: "acc_a",
    runtime: { hostId: "host_a", kind: "cli", provider: "codex", model: "m", revision: "rev_a" },
    workspace: { hostId: "host_a" }, credentialStore: { load: async () => ({ agentToken: TOKEN, accountKey: KEY }) },
    executor: async ({ requestApproval }) => ({
      content: `answer:${await requestApproval({ prompt: "Allow?", options: ["allow", "deny"] })}`,
    }),
    fetchImpl, daemonBootId: "boot_a", maxConnectionFailures: 1,
  });
  await client.start();
  await client.wait();
  await settle();

  const approval = calls.find((call) => call.url.endsWith("/approvals"));
  assert.deepEqual(approval.body, { prompt: "Allow?", options: ["allow", "deny"] });
  assert.equal(calls.find((call) => call.url.endsWith("/messages")).body.content, "answer:allow");
  assert.deepEqual(calls
    .filter((call) => call.method === "PATCH" && call.body?.agentState)
    .map((call) => call.body.agentState.status), [
    "on_task",
    "needs_you",
    "on_task",
    "typing",
    "idle",
  ]);
  assert.equal(calls.some((call) => call.method === "PATCH" && call.body?.status === "completed"), true);
});

test("invalid mixed wire input never reaches executor and fails the Run", async () => {
  let executed = false;
  const event = requested({
    kind: "cli", sessionMode: "main", promptText: "bad", messages: [{ role: "user", content: "leak" }],
  });
  const { client, calls } = fixture({ envelopes: [event], executor: async () => { executed = true; } });
  await client.start();
  await client.wait();
  await settle();

  assert.equal(executed, false);
  const patch = calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch.body, { status: "failed", error: { code: "internal", message: "daemon execution failed" } });
});

test("a Run model outside the daemon inventory never reaches the executor", async () => {
  let executed = false;
  const event = requested(
    { kind: "api", sessionMode: "main", messages: [], historyVersion: 0 },
    { effectiveModel: "retired-model" },
  );
  const { client, calls } = fixture({ envelopes: [event], executor: async () => { executed = true; } });
  await client.start();
  await client.wait();
  await settle();

  assert.equal(executed, false);
  assert.equal(calls.some((call) => call.method === "PATCH" && call.body?.status === "failed"), true);
  assert.equal(calls.some((call) => call.url.endsWith("/messages")), false);
});

test("a rejected output report prevents a completed terminal", async () => {
  const event = requested(
    { kind: "cli", sessionMode: "isolated", promptText: "work" },
    { effectiveModel: "m" },
  );
  const calls = [];
  let loginCount = 0;
  let eventCount = 0;
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body });
    if (url.endsWith("/login")) {
      loginCount += 1;
      return new Response(JSON.stringify({
        accountSession: { id: "acs_a", ...(loginCount === 1 ? { token: "session-secret" } : {}), gatewayBootId: "gw" },
        heartbeatIntervalMs: 10000,
      }), { status: 200 });
    }
    if (url.endsWith("/api/agent/memory-tasks/events")) return new Response(stream([]), { status: 200 });
    if (url.endsWith("/api/agent/events")) {
      eventCount += 1;
      if (eventCount === 1) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
            setTimeout(() => controller.close(), 50);
          },
        }), { status: 200 });
      }
      throw new Error("offline");
    }
    if (url.endsWith("/delta")) {
      return new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = createDaemonClient({
    gatewayUrl: "https://gateway.test", agentId: "agt_a", accountId: "acc_a",
    runtime: { hostId: "host_a", kind: "cli", provider: "codex", model: "m", revision: "rev_a" },
    workspace: { hostId: "host_a" }, credentialStore: { load: async () => ({ agentToken: TOKEN, accountKey: KEY }) },
    executor: async ({ onDelta }) => { await onDelta("rejected"); return { content: "must not complete" }; },
    fetchImpl, daemonBootId: "boot_a", reconnectBaseMs: 0, sleep: async () => {}, maxConnectionFailures: 2,
  });
  await client.start();
  await client.wait();
  await settle();

  assert.equal(calls.some((call) => call.method === "PATCH" && call.body?.status === "completed"), false);
  const failed = calls.find((call) => call.method === "PATCH" && call.body?.status === "failed");
  assert.deepEqual(failed.body.error, { code: "internal", message: "daemon execution failed" });
});

test("Activity detail is filtered in the daemon and a live visibility update only affects later events", async () => {
  const event = requested(
    { kind: "cli", sessionMode: "isolated", promptText: "work" },
    { effectiveModel: "model_b" },
  );
  event.data.activityVisibility = "observed";
  const visibilityUpdate = {
    type: "run.activity-visibility.updated",
    data: { runId: "run_a", activityVisibility: "status-only" },
  };
  const { client, calls } = fixture({
    envelopes: [event, visibilityUpdate],
    executor: async ({ onActivity }) => {
      await onActivity({
        phase: "thinking",
        summary: "正在思考",
        detail: "first public detail",
        callId: "thinking-1",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await onActivity({
        phase: "thinking",
        summary: "继续思考",
        detail: "must be discarded locally",
        callId: "thinking-1",
      });
      return { content: "done" };
    },
  });
  await client.start();
  await client.wait();
  await settle();

  const activities = calls.filter((call) => call.url.endsWith("/activities"));
  assert.equal(activities.length, 2);
  assert.equal(activities[0].body.detail, "first public detail");
  assert.equal(Object.hasOwn(activities[1].body, "detail"), false);
  assert.equal(activities[1].body.summary, "继续思考");
});
