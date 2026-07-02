import test from "node:test";
import assert from "node:assert/strict";
import { createMockAdapter } from "../../src/adapters/mock-adapter.js";

function makeCtx({ text, sessionState }) {
  const deltas = [];
  const activities = [];
  const controller = new AbortController();
  return {
    ctx: {
      agent: { id: "agt_1" },
      prompt: { text },
      sessionState,
      workspacePath: "/tmp",
      onDelta: (d) => deltas.push(d),
      onActivity: (evt) => activities.push(evt),
      requestApproval: async () => "allow",
      signal: controller.signal,
    },
    deltas,
    activities,
  };
}

test("first run has count 1 and no prior sessionState", async () => {
  const adapter = createMockAdapter({ chunkDelayMs: 0 });
  const { ctx, deltas, activities } = makeCtx({ text: "hello", sessionState: null });
  const result = await adapter.run(ctx);

  assert.deepEqual(result.sessionState, { count: 1 });
  assert.match(result.content, /回声第 1 次：hello/);
  assert.match(result.content, /会话计数器已更新为 1/);
  assert.ok(deltas.join("").length > 0, "should have streamed some deltas");

  const toolActivities = activities.filter((a) => a.phase === "tool");
  assert.equal(toolActivities.length, 2);
  assert.equal(toolActivities[0].toolStatus, "pending");
  assert.equal(toolActivities[1].toolStatus, "completed");
  assert.equal(toolActivities[0].callId, toolActivities[1].callId, "same callId for in-place update");
});

test("session continuity: sessionState count increments across successive runs", async () => {
  const adapter = createMockAdapter({ chunkDelayMs: 0 });

  const first = await adapter.run(makeCtx({ text: "msg one", sessionState: null }).ctx);
  assert.deepEqual(first.sessionState, { count: 1 });

  const second = await adapter.run(makeCtx({ text: "msg two", sessionState: first.sessionState }).ctx);
  assert.deepEqual(second.sessionState, { count: 2 });
  assert.match(second.content, /回声第 2 次：msg two/);

  const third = await adapter.run(makeCtx({ text: "msg three", sessionState: second.sessionState }).ctx);
  assert.deepEqual(third.sessionState, { count: 3 });
});

test("reply contains two paragraphs separated by a blank line (multi-bubble input)", async () => {
  const adapter = createMockAdapter({ chunkDelayMs: 0 });
  const { ctx } = makeCtx({ text: "ping", sessionState: null });
  const result = await adapter.run(ctx);
  const paragraphs = result.content.split(/\n\s*\n/);
  assert.equal(paragraphs.length, 2);
});

test("!!approve triggers requestApproval and reply carries the answer", async () => {
  const adapter = createMockAdapter({ chunkDelayMs: 0, approvalTimeoutMs: 1000 });
  const { ctx } = makeCtx({ text: "deploy it !!approve", sessionState: null });
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
  const { ctx } = makeCtx({ text: "please !!error now", sessionState: null });
  await assert.rejects(() => adapter.run(ctx), (err) => {
    assert.equal(err.name, "AdapterError");
    assert.equal(err.code, "provider_error");
    return true;
  });
});
