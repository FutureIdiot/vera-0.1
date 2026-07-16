import test from "node:test";
import assert from "node:assert/strict";
import { hasQueuedAccountExecution, withAccountExecutionLock } from "../../src/spaces/execution-lock.js";

test("Account execution lock serializes work and releases after completion", async () => {
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = withAccountExecutionLock("acc_1", async () => {
    order.push("first:start");
    await firstGate;
    order.push("first:end");
  });
  const second = withAccountExecutionLock("acc_1", async () => {
    order.push("second:start");
    order.push("second:end");
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  assert.equal(hasQueuedAccountExecution("acc_1"), true);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
  assert.equal(hasQueuedAccountExecution("acc_1"), false);
});
