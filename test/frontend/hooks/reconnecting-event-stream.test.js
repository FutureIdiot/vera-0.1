import test from "node:test";
import assert from "node:assert/strict";

import { createReconnectingEventStream } from "../../../frontend/src/hooks/reconnecting-event-stream.js";

function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  const delays = [];
  return {
    delays,
    pending,
    setTimer(callback, delay) {
      const id = nextId;
      nextId += 1;
      delays.push(delay);
      pending.set(id, callback);
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    runNext() {
      const entry = pending.entries().next().value;
      assert.ok(entry, "expected a pending timer");
      const [id, callback] = entry;
      pending.delete(id);
      callback();
    },
  };
}

function createFakeConnector() {
  const connections = [];
  async function connect(callbacks) {
    const source = {
      closeCount: 0,
      close() {
        this.closeCount += 1;
      },
    };
    connections.push({ callbacks, source });
    return source;
  }
  return { connect, connections };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("events advance the since watermark used by the next connection", async () => {
  const connector = createFakeConnector();
  const timers = createFakeTimers();
  const received = [];
  const stream = createReconnectingEventStream({
    connect: connector.connect,
    initialSince: 7,
    onEvent: (event) => received.push(event),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await flushAsyncWork();

  assert.equal(connector.connections[0].callbacks.since, 7);
  connector.connections[0].callbacks.onEvent({ seq: 8, type: "message.created", data: {} });
  connector.connections[0].callbacks.onError();
  timers.runNext();
  await flushAsyncWork();

  assert.deepEqual(received.map((event) => event.seq), [8]);
  assert.equal(connector.connections[1].callbacks.since, 8);
  stream.close();
});

test("reconnect uses exponential backoff, caps it, and never stacks timers", async () => {
  const connector = createFakeConnector();
  const timers = createFakeTimers();
  const stream = createReconnectingEventStream({
    connect: connector.connect,
    minDelayMs: 10,
    maxDelayMs: 25,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await flushAsyncWork();

  connector.connections[0].callbacks.onError();
  connector.connections[0].callbacks.onError();
  assert.equal(timers.pending.size, 1);
  assert.deepEqual(timers.delays, [10]);

  timers.runNext();
  await flushAsyncWork();
  connector.connections[1].callbacks.onError();
  assert.deepEqual(timers.delays, [10, 20]);

  timers.runNext();
  await flushAsyncWork();
  connector.connections[2].callbacks.onError();
  assert.deepEqual(timers.delays, [10, 20, 25]);

  stream.close();
});

test("a successful open resets the backoff attempt", async () => {
  const connector = createFakeConnector();
  const timers = createFakeTimers();
  const stream = createReconnectingEventStream({
    connect: connector.connect,
    minDelayMs: 10,
    maxDelayMs: 100,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await flushAsyncWork();

  connector.connections[0].callbacks.onError();
  timers.runNext();
  await flushAsyncWork();
  connector.connections[1].callbacks.onOpen();
  connector.connections[1].callbacks.onError();

  assert.deepEqual(timers.delays, [10, 10]);
  stream.close();
});

test("stream.reset calls onReset without advancing since or reconnecting", async () => {
  const connector = createFakeConnector();
  const timers = createFakeTimers();
  let resetCount = 0;
  const received = [];
  const stream = createReconnectingEventStream({
    connect: connector.connect,
    initialSince: 12,
    onReset: () => {
      resetCount += 1;
    },
    onEvent: (event) => received.push(event),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await flushAsyncWork();

  connector.connections[0].callbacks.onEvent({ seq: 20, type: "stream.reset", data: {} });

  assert.equal(resetCount, 1);
  assert.deepEqual(received, []);
  assert.equal(connector.connections.length, 1);
  assert.equal(timers.pending.size, 0);

  connector.connections[0].callbacks.onError();
  timers.runNext();
  await flushAsyncWork();
  assert.equal(connector.connections[1].callbacks.since, 12);
  stream.close();
});

test("resetSince replaces the reconnect watermark", async () => {
  const connector = createFakeConnector();
  const timers = createFakeTimers();
  const stream = createReconnectingEventStream({
    connect: connector.connect,
    initialSince: 3,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await flushAsyncWork();

  stream.resetSince(99);
  connector.connections[0].callbacks.onError();
  timers.runNext();
  await flushAsyncWork();

  assert.equal(connector.connections[1].callbacks.since, 99);
  stream.close();
});

test("close cancels reconnect work and makes callbacks from old sources inert", async () => {
  const connector = createFakeConnector();
  const timers = createFakeTimers();
  let eventCount = 0;
  let resetCount = 0;
  const stream = createReconnectingEventStream({
    connect: connector.connect,
    onEvent: () => {
      eventCount += 1;
    },
    onReset: () => {
      resetCount += 1;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await flushAsyncWork();
  const first = connector.connections[0];

  first.callbacks.onError();
  assert.equal(timers.pending.size, 1);
  stream.close();

  assert.equal(timers.pending.size, 0);
  assert.ok(first.source.closeCount >= 1);
  first.callbacks.onEvent({ seq: 1, type: "message.created", data: {} });
  first.callbacks.onEvent({ seq: 2, type: "stream.reset", data: {} });
  first.callbacks.onError();

  assert.equal(eventCount, 0);
  assert.equal(resetCount, 0);
  assert.equal(timers.pending.size, 0);
  assert.equal(connector.connections.length, 1);
});

test("a rejected connection enters backoff instead of becoming an unhandled rejection", async () => {
  const timers = createFakeTimers();
  let attempts = 0;
  const stream = createReconnectingEventStream({
    async connect() {
      attempts += 1;
      if (attempts === 1) throw new Error("gateway unavailable");
      return { close() {} };
    },
    minDelayMs: 10,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await flushAsyncWork();

  assert.equal(timers.pending.size, 1);
  timers.runNext();
  await flushAsyncWork();
  assert.equal(attempts, 2);
  stream.close();
});
