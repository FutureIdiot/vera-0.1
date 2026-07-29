import test from "node:test";
import assert from "node:assert/strict";

import { createDaemonForgeHandler } from "../../src/agents/daemon-forge-handler.js";
import { emptyForgeCapsule } from "../../src/spaces/forge-capsule.js";

function event(overrides = {}) {
  return {
    type: "context-forge.requested",
    data: {
      draftId: "fgd_a",
      target: {
        accountId: "acc_a",
        agentId: "agt_a",
        runtimeRevision: "rev_a",
        model: "model-a",
      },
      source: {
        spaceId: "spc_a",
        spaceSessionId: "sps_a",
        sourceSeq: 10,
        messages: [{
          messageId: "msg_a",
          author: { type: "user", name: "User" },
          target: { type: "broadcast" },
          content: "keep",
          fileIds: [],
          createdAt: null,
        }],
      },
      limits: { chunkChars: 6000, capsuleChars: 6000 },
      ...overrides,
    },
  };
}

test("daemon Forge uses only executeForge and submits one final Capsule", async () => {
  const calls = [];
  let executed = 0;
  const handler = createDaemonForgeHandler({
    identity: {
      agentId: "agt_a",
      accountId: "acc_a",
      runtime: { revision: "rev_a" },
    },
    executor: {
      async executeForge(input) {
        executed += 1;
        assert.deepEqual(input.source.messages.map((message) => message.messageId), ["msg_a"]);
        return { content: emptyForgeCapsule() };
      },
    },
    async request(path, options) {
      calls.push({ path, options });
      return {};
    },
  });
  assert.equal(handler.handleEnvelope(event()), true);
  await new Promise((resolve) => setImmediate(resolve));
  await handler.terminate();
  assert.equal(executed, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, /\/api\/agent\/forges\/fgd_a\/targets\/agt_a$/u);
  assert.equal(calls[0].options.body.status, "succeeded");
  assert.equal(calls[0].options.body.execution.fallbackUsed, false);
});

test("daemon Forge ignores a request for another Account", async () => {
  let executed = false;
  const handler = createDaemonForgeHandler({
    identity: {
      agentId: "agt_a",
      accountId: "acc_a",
      runtime: { revision: "rev_a" },
    },
    executor: { executeForge: async () => { executed = true; return { content: emptyForgeCapsule() }; } },
    request: async () => ({}),
  });
  handler.handleEnvelope(event({
    target: {
      accountId: "acc_other",
      agentId: "agt_a",
      runtimeRevision: "rev_a",
      model: "model-a",
    },
  }));
  await handler.terminate();
  assert.equal(executed, false);
});
