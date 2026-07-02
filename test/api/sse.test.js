import test from "node:test";
import assert from "node:assert/strict";
import { createEventHub } from "../../src/api/sse.js";

function fakeSubscriber() {
  const frames = [];
  return {
    write: (frame) => frames.push(frame),
    frames,
    envelopes() {
      return frames.map((f) => JSON.parse(f.split("\n").find((l) => l.startsWith("data: ")).slice("data: ".length)));
    },
  };
}

test("publish assigns monotonic seq and delivers to live subscribers", () => {
  const hub = createEventHub({ bufferSize: 10 });
  const sub = fakeSubscriber();
  hub.subscribe(sub);

  const e1 = hub.publish("run.started", { run: { id: "run_1" } });
  const e2 = hub.publish("run.ended", { run: { id: "run_1" } });

  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(sub.frames.length, 2);
  const envs = sub.envelopes();
  assert.equal(envs[0].type, "run.started");
  assert.equal(envs[1].type, "run.ended");
});

test("reconnect with since replays only missed events when still buffered", () => {
  const hub = createEventHub({ bufferSize: 10 });
  hub.publish("a", {});
  hub.publish("b", {});
  hub.publish("c", {});

  const sub = fakeSubscriber();
  hub.subscribe(sub, { sinceSeq: 1 }); // client saw seq 1, should replay 2 and 3

  const envs = sub.envelopes();
  assert.deepEqual(envs.map((e) => e.seq), [2, 3]);
  assert.deepEqual(envs.map((e) => e.type), ["b", "c"]);
});

test("reconnect after buffer rolled past since sends stream.reset instead of replay", () => {
  const hub = createEventHub({ bufferSize: 2 }); // tiny ring buffer, holds only last 2 events
  hub.publish("a", {}); // seq 1
  hub.publish("b", {}); // seq 2
  hub.publish("c", {}); // seq 3 -> evicts seq 1
  hub.publish("d", {}); // seq 4 -> evicts seq 2
  hub.publish("e", {}); // seq 5 -> evicts seq 3 (buffer now holds seq 4,5)

  assert.equal(hub.oldestBufferedSeq(), 4);

  const sub = fakeSubscriber();
  // client last saw seq 1; seq 2 and 3 (which it still needs) are gone -> real gap.
  hub.subscribe(sub, { sinceSeq: 1 });

  const envs = sub.envelopes();
  assert.equal(envs.length, 1);
  assert.equal(envs[0].type, "stream.reset");
});

test("hasGap correctly detects a caught-up client (no gap)", () => {
  const hub = createEventHub({ bufferSize: 2 });
  hub.publish("a", {});
  hub.publish("b", {});
  hub.publish("c", {});
  // oldest buffered is seq 2; since=2 means client has seen up through the oldest, no gap.
  assert.equal(hub.hasGap(2), false);
  assert.equal(hub.hasGap(3), false); // fully caught up
  assert.equal(hub.hasGap(0), true); // missed seq 1, which is gone
});
