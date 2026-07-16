import test from "node:test";
import assert from "node:assert/strict";
import { createMockAdapter } from "../../src/adapters/mock-adapter.js";

function makeCtx({ text, providerBinding = null, sessionMode = "main" }) {
  const deltas = [];
  const activities = [];
  const persisted = [];
  const rotations = [];
  const controller = new AbortController();
  return {
    ctx: {
      agent: { id: "agt_1" },
      prompt: { text },
      sessionMode,
      providerBinding,
      workspacePath: "/tmp",
      onDelta: (d) => deltas.push(d),
      onActivity: (evt) => activities.push(evt),
      requestApproval: async () => "allow",
      persistProviderBinding: async (providerState, ifVersion) => {
        persisted.push({ providerState, ifVersion });
        return { version: persisted.length, providerState };
      },
      rotateProviderBinding: async (input) => {
        rotations.push(input);
        return { prompt: { text: `ROTATED ${input.reason}` }, providerBinding: null, generation: 2 };
      },
      signal: controller.signal,
    },
    deltas,
    activities,
    persisted,
    rotations,
  };
}

test("first run has count 1 and CAS-persists a provider binding", async () => {
  const adapter = createMockAdapter({ chunkDelayMs: 0 });
  const { ctx, deltas, activities, persisted } = makeCtx({ text: "hello" });
  const result = await adapter.run(ctx);

  assert.deepEqual(result, {
    content: result.content,
    providerBinding: { version: 1, providerState: { count: 1 } },
  });
  assert.equal("sessionState" in result, false);
  assert.deepEqual(persisted, [{ providerState: { count: 1 }, ifVersion: null }]);
  assert.match(result.content, /回声第 1 次：hello/);
  assert.match(result.content, /会话计数器已更新为 1/);
  assert.ok(deltas.join("").length > 0, "should have streamed some deltas");

  const toolActivities = activities.filter((a) => a.phase === "tool");
  assert.equal(toolActivities.length, 2);
  assert.equal(toolActivities[0].toolStatus, "pending");
  assert.equal(toolActivities[1].toolStatus, "completed");
  assert.equal(toolActivities[0].callId, toolActivities[1].callId, "same callId for in-place update");
});

test("provider binding count increments across successive CAS writes", async () => {
  const adapter = createMockAdapter({ chunkDelayMs: 0 });

  const firstCtx = makeCtx({ text: "msg one" });
  const first = await adapter.run(firstCtx.ctx);
  assert.deepEqual(first.providerBinding.providerState, { count: 1 });
  assert.deepEqual(firstCtx.persisted, [{ providerState: { count: 1 }, ifVersion: null }]);

  const secondCtx = makeCtx({ text: "msg two", providerBinding: first.providerBinding });
  const second = await adapter.run(secondCtx.ctx);
  assert.deepEqual(second.providerBinding.providerState, { count: 2 });
  assert.deepEqual(secondCtx.persisted, [{ providerState: { count: 2 }, ifVersion: 1 }]);
  assert.match(second.content, /回声第 2 次：msg two/);

  const thirdCtx = makeCtx({ text: "msg three", providerBinding: second.providerBinding });
  const third = await adapter.run(thirdCtx.ctx);
  assert.deepEqual(third.providerBinding.providerState, { count: 3 });
});

test("invalid provider binding rotates before writing count 1 into the new generation", async () => {
  const adapter = createMockAdapter({ chunkDelayMs: 0 });
  const input = makeCtx({
    text: "old prompt",
    providerBinding: { version: 1, providerState: { count: "bad" } },
  });
  input.ctx.rotateProviderBinding = async (reason) => {
    input.rotations.push(reason);
    return { prompt: { text: "fresh prompt" }, providerBinding: null, generation: 2 };
  };
  const result = await adapter.run(input.ctx);
  assert.deepEqual(input.rotations, [{ reason: "invalid" }]);
  assert.deepEqual(input.persisted, [{ providerState: { count: 1 }, ifVersion: null }]);
  assert.match(result.content, /回声第 1 次：fresh prompt/);
});

test("reply contains two paragraphs separated by a blank line (multi-bubble input)", async () => {
  const adapter = createMockAdapter({ chunkDelayMs: 0 });
  const { ctx } = makeCtx({ text: "ping" });
  const result = await adapter.run(ctx);
  const paragraphs = result.content.split(/\n\s*\n/);
  assert.equal(paragraphs.length, 2);
});

test("!!approve triggers requestApproval and reply carries the answer", async () => {
  const adapter = createMockAdapter({ chunkDelayMs: 0, approvalTimeoutMs: 1000 });
  const { ctx } = makeCtx({ text: "deploy it !!approve" });
  const requests = [];
  ctx.requestApproval = async (req) => {
    requests.push(req);
    return "allow";
  };
  const result = await adapter.run(ctx);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].options, ["allow", "deny"]);
  assert.match(result.content, /审批结果：allow/);
});

test("throws AdapterError with code provider_error when prompt requests it", async () => {
  const adapter = createMockAdapter({ chunkDelayMs: 0 });
  const { ctx } = makeCtx({ text: "please !!error now" });
  await assert.rejects(() => adapter.run(ctx), (err) => {
    assert.equal(err.name, "AdapterError");
    assert.equal(err.code, "provider_error");
    return true;
  });
});

test("isolated run ignores and does not return a provider binding", async () => {
  const adapter = createMockAdapter({ chunkDelayMs: 0 });
  const { ctx } = makeCtx({
    text: "isolated",
    sessionMode: "isolated",
    providerBinding: { version: 1, providerState: { count: 9 } },
  });
  ctx.persistProviderBinding = () => { throw new Error("isolated run must not persist"); };
  const result = await adapter.run(ctx);
  assert.deepEqual(result, { content: result.content });
  assert.match(result.content, /回声第 1 次：isolated/);
});
