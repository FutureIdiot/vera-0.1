import test from "node:test";
import assert from "node:assert/strict";

import { createDaemonClient } from "../../src/agents/daemon-client.js";
import { activityAgentStatus } from "../../src/agents/daemon-run-handler.js";
import { AdapterError } from "../../src/core/errors.js";

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

function fixture({
  envelopes = [], memoryEnvelopes = [], executor, memoryExecutor, eventResponses,
  bindingRotationResponse = null, terminalResponse = null,
  responseHandler = null,
  runtime = null, loginStatus = 200, maxConnectionFailures = 3,
} = {}) {
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
    if (url.endsWith("/provider-binding-rotation") && bindingRotationResponse) {
      return new Response(JSON.stringify(bindingRotationResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const customResponse = await responseHandler?.({ url, init, body, calls });
    if (customResponse) return customResponse;
    if (url.includes("/messages")) {
      return new Response(JSON.stringify({ id: `msg_${calls.length}`, content: body.content }), { status: 201 });
    }
    if (init.method === "PATCH" && body?.status === "completed" && terminalResponse) {
      return new Response(JSON.stringify(terminalResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = createDaemonClient({
    gatewayUrl: "https://gateway.test",
    agentId: "agt_a",
    accountId: "acc_a",
    runtime: runtime ?? {
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
  assert.deepEqual(statePatches, ["on_task", "typing"]);
  assert.equal(calls.find((call) => call.method === "PATCH" && call.body?.status === "completed")?.body.status, "completed");
});

test("source-only Child output uses one terminal RunMessage and no public output endpoint", async () => {
  const input = { kind: "cli", sessionMode: "isolated", promptText: "bounded delegated prompt" };
  let terminalAttempts = 0;
  const { client, calls } = fixture({
    envelopes: [requested(input, {
      role: "child",
      outputPolicy: "source",
      rootRunId: "run_root",
      parentRunId: "run_root",
    })],
    executor: async (context) => {
      await context.onActivity({ phase: "thinking", kind: "reasoning", summary: "private work" });
      await context.onDelta("private result");
      return { content: "authoritative private result" };
    },
    responseHandler: ({ url, init, body }) => {
      if (url.endsWith("/run-messages") && init.method === "POST") {
        return new Response(JSON.stringify({ runMessage: { id: "rmsg_terminal" } }), { status: 201 });
      }
      if (init.method === "PATCH" && body?.status === "completed") {
        terminalAttempts += 1;
        return new Response(JSON.stringify(terminalAttempts === 1
          ? { run: { id: "run_a", status: "running" }, awaitingSourceResult: true }
          : { run: { id: "run_a", status: "completed" } }), { status: 200 });
      }
      return null;
    },
  });
  await client.start();
  await client.wait();
  await settle();

  const terminalMessage = calls.find((call) =>
    call.url.endsWith("/run-messages") &&
    call.method === "POST" &&
    call.body?.kind === "result");
  assert.deepEqual(terminalMessage.body, {
    kind: "result",
    content: "authoritative private result",
    idempotencyKey: "terminal:run_a",
  });
  assert.equal(calls.some((call) =>
    call.url.endsWith("/delta") ||
    call.url.endsWith("/messages") ||
    call.url.endsWith("/activities")), false);
  assert.equal(terminalAttempts, 2);
});

test("CLI main rotation updates generation before binding CAS and submits provider usage", async () => {
  const input = {
    kind: "cli",
    sessionMode: "main",
    promptText: "old prompt",
    providerBinding: { version: 1, providerState: { conversationId: "stale" } },
  };
  let rotated;
  const { client, calls } = fixture({
    envelopes: [requested(input)],
    runtime: {
      hostId: "host_a",
      kind: "cli",
      provider: "antigravity",
      model: "model_a",
      revision: "rev_a",
      runtimeCapabilities: { models: ["model_a", "model_b"] },
    },
    bindingRotationResponse: {
      generation: 3,
      promptText: "new prompt",
      providerBinding: null,
    },
    executor: async (context) => {
      rotated = await context.rotateProviderBinding({ reason: "missing" });
      await context.persistProviderBinding({ conversationId: "fresh" }, null);
      return {
        content: "done",
        usage: { inputTokens: 10000, outputTokens: 4, totalTokens: 10004 },
      };
    },
  });
  await client.start();
  await client.wait();
  await settle();

  assert.deepEqual(rotated, {
    generation: 3,
    prompt: { text: "new prompt" },
    providerBinding: null,
  });
  const rotation = calls.find((call) => call.url.endsWith("/provider-binding-rotation"));
  assert.deepEqual(rotation.body, { generation: 2, reason: "missing" });
  const binding = calls.find((call) => call.url.includes("/provider-bindings/"));
  assert.equal(binding.body.generation, 3);
  const completed = calls.find((call) => call.method === "PATCH" && call.body?.status === "completed");
  assert.deepEqual(completed.body.usage, {
    inputTokens: 10000,
    outputTokens: 4,
    totalTokens: 10004,
  });
});

test("a background terminal catch-up uses the isolated executor and reports no Chat output", async () => {
  const input = { kind: "cli", sessionMode: "main", promptText: "main prompt" };
  let catchupContext;
  const terminalResponse = {
    run: { id: "run_a", status: "completed" },
    catchupTask: {
      id: "catchup:run_a",
      sourceMessageIds: ["msg_missed"],
      input: { kind: "cli", sessionMode: "isolated", promptText: "summarize safely" },
    },
  };
  const executor = {
    async execute() { return { content: "main reply" }; },
    async executeCatchup(context) {
      catchupContext = {
        taskKind: context.taskKind,
        input: context.input,
        workspace: context.workspace,
        role: context.run.role,
      };
      return { content: "A concise catch-up summary." };
    },
  };
  const { client, calls } = fixture({
    envelopes: [requested(input)],
    executor,
    terminalResponse,
    runtime: {
      hostId: "host_a",
      kind: "cli",
      provider: "codex",
      model: "model_a",
      revision: "rev_a",
      runtimeCapabilities: { models: ["model_a"] },
    },
  });
  await client.start();
  await client.wait();
  await settle();

  assert.deepEqual(catchupContext, {
    taskKind: "catchup",
    input: terminalResponse.catchupTask.input,
    workspace: null,
    role: "catchup",
  });
  const result = calls.find((call) => call.url.endsWith("/api/agent/run-catchups/catchup%3Arun_a/result"));
  assert.deepEqual(result.body, {
    status: "succeeded",
    summary: "A concise catch-up summary.",
  });
  assert.equal(calls.filter((call) => call.url.endsWith("/messages")).length, 1);
  assert.equal(calls.some((call) => call.url.endsWith("/activities") && call.body?.summary?.includes("catch-up")), false);
});

test("a Root synthesizes late Child results at an isolated coordination checkpoint", async () => {
  const input = { kind: "cli", sessionMode: "main", promptText: "main prompt" };
  let terminalAttempts = 0;
  let coordinationInput = null;
  const executor = {
    async execute() {
      return { content: "@Beta please inspect the boundary" };
    },
    async executeCoordination(context) {
      coordinationInput = context.input;
      await context.onDelta("Beta confirmed the boundary.");
      return { content: "Beta confirmed the boundary." };
    },
  };
  const delayedEvents = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify(requested(input))}\n\n`,
      ));
      setTimeout(() => controller.close(), 250);
    },
  }), { status: 200 });
  const { client, calls } = fixture({
    eventResponses: [delayedEvents],
    executor,
    runtime: {
      hostId: "host_a",
      kind: "cli",
      provider: "codex",
      model: "model_a",
      revision: "rev_a",
      runtimeCapabilities: { models: ["model_a"] },
    },
    responseHandler: ({ url, init, body }) => {
      if (init.method === "PATCH" && body?.status === "completed") {
        terminalAttempts += 1;
        return new Response(JSON.stringify(terminalAttempts === 1
          ? { run: { id: "run_a", status: "running" }, awaitingChildren: true }
          : { run: { id: "run_a", status: "completed" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (init.method === "GET" && url.includes("/run-messages?")) {
        return new Response(JSON.stringify({
          runMessages: [{
            id: "rmsg_result",
            sequence: 2,
            sender: { type: "run", runId: "run_child", agentId: "agt_beta" },
            recipient: { type: "run", runId: "run_a", agentId: "agt_a" },
            kind: "result",
            content: "Boundary is intact.",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return null;
    },
  });
  await client.start();
  await client.wait();
  await settle();

  assert.equal(coordinationInput.sessionMode, "isolated");
  assert.match(coordinationInput.promptText, /Boundary is intact/u);
  assert.equal(terminalAttempts, 2);
  assert.equal(calls.some((call) =>
    call.url.endsWith("/run-messages/rmsg_result/consumed") &&
    call.method === "PUT"), true);
  assert.equal(calls.some((call) =>
    call.url.endsWith("/messages") &&
    call.body?.content === "Beta confirmed the boundary."), true);
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

test("adapter public quota errors keep their stable code and redacted native message across the daemon boundary", async () => {
  const event = requested(
    { kind: "cli", sessionMode: "main", promptText: "quota", providerBinding: null },
    { effectiveModel: "m" },
  );
  const { client, calls } = fixture({
    envelopes: [event],
    runtime: {
      hostId: "host_a",
      kind: "cli",
      provider: "codex",
      model: "m",
      revision: "rev_a",
      runtimeCapabilities: { models: ["m"] },
    },
    executor: async () => {
      throw new AdapterError(
        "quota_exhausted",
        "Codex: You've hit your usage limit. Try again at 5:06 PM.",
      );
    },
  });
  await client.start();
  await client.wait();
  await settle();

  const failed = calls.find((call) => call.method === "PATCH" && call.body?.status === "failed");
  assert.deepEqual(failed.body.error, {
    code: "quota_exhausted",
    message: "Codex: You've hit your usage limit. Try again at 5:06 PM.",
  });
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
