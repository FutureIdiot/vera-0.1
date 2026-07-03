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

test("restart semantics: initialSeq jump makes any previous-life since trigger stream.reset", () => {
  // 上一世：seq 走到 1042，水位持久化
  let watermark = 0;
  const hub1 = createEventHub({ bufferSize: 5, onSeqAdvance: (s) => (watermark = s) });
  for (let i = 0; i < 7; i++) hub1.publish("x", {});
  assert.equal(watermark, 7);

  // 本世：从水位 + 缓冲长度跳跃续增（server.js 接线逻辑）
  const hub2 = createEventHub({ bufferSize: 5, initialSeq: watermark + 5 });
  hub2.publish("y", {}); // seq 13

  // 上一世的任何 since（包括恰好等于水位、以及水位防抖丢失后略超前的值）都必须 reset
  for (const staleSince of [1, 7, 9]) {
    const sub = fakeSubscriber();
    hub2.subscribe(sub, { sinceSeq: staleSince });
    const envs = sub.envelopes();
    assert.equal(envs[0].type, "stream.reset", `since=${staleSince} 应触发 reset`);
  }

  // 本世正常客户端不受影响
  const live = fakeSubscriber();
  hub2.subscribe(live, { sinceSeq: 12 }); // 12 = initialSeq，等价"从头听本世"
  assert.deepEqual(live.envelopes().map((e) => e.seq), [13]);
});

test("since ahead of current seq (future client) is treated as a gap", () => {
  const hub = createEventHub({ bufferSize: 5 });
  hub.publish("a", {});
  assert.equal(hub.hasGap(999), true);
  assert.equal(hub.hasGap(1), false);
});
