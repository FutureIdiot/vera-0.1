import test from "node:test";
import assert from "node:assert/strict";

import { createDisabledMemoryTaskTransport } from "../../src/extensions/disabled-memory.js";

function parseFrame(frame) {
  const data = frame.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data.slice("data: ".length));
}

test("disabled Memory task transport keeps the daemon transport contract", async () => {
  const transport = createDisabledMemoryTaskTransport();
  for (const method of ["subscribe", "heartbeat", "submitResult", "dispatch", "close"]) {
    assert.equal(typeof transport[method], "function", `${method} must be implemented`);
  }

  const frames = [];
  const unsubscribe = transport.subscribe("agt_disabled", {
    write(frame) { frames.push(frame); },
  });

  assert.equal(transport.heartbeat("agt_disabled"), true);
  assert.equal(frames.length, 1);
  assert.match(frames[0], /^id: 1\ndata: /);
  const heartbeat = parseFrame(frames[0]);
  assert.equal(heartbeat.seq, 1);
  assert.equal(heartbeat.type, "agent.heartbeat");
  assert.equal(heartbeat.ts, heartbeat.data.ts);
  assert.equal(Number.isNaN(Date.parse(heartbeat.ts)), false);

  await assert.rejects(
    transport.dispatch("agt_disabled", { task: "digest" }),
    { code: "memory_task_unavailable" },
  );
  assert.throws(
    () => transport.submitResult("agt_disabled", "dispatch_missing", {}),
    { code: "memory_task_unavailable" },
  );

  unsubscribe();
  unsubscribe();
  assert.equal(transport.heartbeat("agt_disabled"), false);

  assert.doesNotThrow(() => transport.close());
  assert.doesNotThrow(() => transport.close());
});

test("disabled Memory task transport close safely detaches active subscribers", () => {
  const transport = createDisabledMemoryTaskTransport();
  const unsubscribe = transport.subscribe("agt_disabled", { write() {} });

  transport.close();

  assert.equal(transport.heartbeat("agt_disabled"), false);
  assert.doesNotThrow(unsubscribe);
});
