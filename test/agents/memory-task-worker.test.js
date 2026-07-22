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

function memoryRequested(dispatchId, attempt, payload = {}) {
  return {
    type: "memory-task.requested",
    data: {
      dispatchId,
      jobId: `job_${dispatchId}`,
      attempt,
      kind: "digest",
      memoryTaskSnapshot: {
        ownerAgentId: "agt_owner",
        executorAgentId: "agt_a",
        runtimeRevision: "rev_a",
        kind: "api",
        provider: "ollama",
        modelMode: "fixed",
        taskModel: "task-model",
        verificationId: "mtv_a",
      },
      payload,
    },
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("Memory worker uses Agent Token only, freezes execution metadata, and aborts cancelled work", async () => {
  const calls = [];
  const resultBodies = [];
  let accountController;
  let memoryController;
  let loginCount = 0;
  const success = memoryRequested("mtd_success", 1, { mode: "success" });
  const cancelled = memoryRequested("mtd_cancel", 2, { mode: "wait" });
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
    if (url.endsWith("/api/agent/events")) {
      return new Response(new ReadableStream({ start(controller) { accountController = controller; } }), { status: 200 });
    }
    if (url.endsWith("/api/agent/memory-tasks/events")) {
      return new Response(new ReadableStream({
        start(controller) {
          memoryController = controller;
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(success)}\n\n`));
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(cancelled)}\n\n`));
          setTimeout(() => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
            type: "memory-task.cancelled", data: { dispatchId: "mtd_cancel", attempt: 2 },
          })}\n\n`)), 1);
        },
      }), { status: 200 });
    }
    if (url.includes("/memory-tasks/") && url.endsWith("/result")) {
      resultBodies.push(body);
      if (resultBodies.length === 2) setTimeout(() => {
        memoryController.close();
        accountController.close();
      }, 1);
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const memoryExecutor = {
    digestMemory({ taskModel, payload, signal }) {
      assert.equal(taskModel, "task-model");
      if (payload.mode === "success") return Promise.resolve({ proposals: [{ action: "skip" }] });
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "cancelled" })), { once: true }));
    },
  };
  const client = createDaemonClient({
    gatewayUrl: "https://gateway.test", agentId: "agt_a", accountId: "acc_a",
    runtime: {
      hostId: "host_a", kind: "api", provider: "ollama", model: "chat-model", revision: "rev_a",
      runtimeCapabilities: { models: ["chat-model", "task-model"] },
    },
    workspace: { hostId: "host_a" }, credentialStore: { load: async () => ({ agentToken: TOKEN, accountKey: KEY }) },
    executor: async () => ({ content: "unused" }), memoryExecutor,
    fetchImpl, daemonBootId: "boot_a", maxConnectionFailures: 1,
  });
  await client.start();
  await client.wait();
  await settle();

  const workerCalls = calls.filter((call) => call.url.includes("/memory-tasks/"));
  assert.ok(workerCalls.every((call) => call.headers.Authorization === `Bearer ${TOKEN}`));
  assert.ok(workerCalls.every((call) => !("X-Vera-Account-Key" in call.headers) && !("X-Vera-Account-Session" in call.headers)));
  const succeeded = resultBodies.find((body) => body.status === "succeeded");
  assert.deepEqual(succeeded, {
    attempt: 1,
    status: "succeeded",
    proposals: [{ action: "skip" }],
    execution: { runtimeRevision: "rev_a", taskModel: "task-model", fallbackUsed: false },
  });
  assert.equal(resultBodies.find((body) => body.attempt === 2).status, "cancelled");
});
