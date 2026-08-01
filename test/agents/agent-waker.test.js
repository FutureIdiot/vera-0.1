import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { createAgentWaker } from "../../scripts/agent-waker.js";

function settle() { return new Promise((resolve) => setTimeout(resolve, 10)); }

test("host waker starts the daemon once and only starts it again after an explicit wake event", async () => {
  const children = [];
  let streamController;
  const fetchImpl = async (_url, init) => {
    const body = new ReadableStream({
      start(controller) {
        streamController = controller;
        init.signal.addEventListener("abort", () => controller.close(), { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const spawnImpl = (_command, _args, options) => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.exitCode = 0;
      child.emit("exit", 0);
    };
    children.push({ child, options });
    return child;
  };
  const waker = createAgentWaker({
    gatewayUrl: "https://gateway.test",
    agentId: "agt_wake",
    accountId: "acc_wake",
    credentialStore: { load: async () => ({ agentToken: "vat_wake" }) },
    fetchImpl,
    spawnImpl,
    env: { VERA_ACCOUNT_ID: "acc_wake" },
  });
  void waker.start();
  try {
    await settle();
    assert.equal(children.length, 1);
    children[0].child.exitCode = 0;
    children[0].child.emit("exit", 0);
    await settle();
    assert.equal(children.length, 1);

    streamController.enqueue(new TextEncoder().encode(
      'data: {"type":"account.wake.requested","data":{"accountId":"acc_wake","requestId":"wkr_a","requestedAt":"now"}}\n\n',
    ));
    await settle();
    assert.equal(children.length, 2);
    assert.equal(children[1].options.env.VERA_ACCOUNT_ID, "acc_wake");
  } finally {
    await waker.stop();
  }
});
