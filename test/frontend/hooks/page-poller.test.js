import test from "node:test";
import assert from "node:assert/strict";
import { createPagePoller } from "../../../frontend/src/hooks/page-poller.js";

test("page poller starts once and clears its interval on route cleanup", async () => {
  let calls = 0;
  let scheduled = null;
  let cleared = null;
  const poller = createPagePoller({
    task: async () => { calls += 1; },
    intervalMs: 5000,
    setIntervalFn(callback, delay) { scheduled = { callback, delay }; return 42; },
    clearIntervalFn(timer) { cleared = timer; },
  });
  await poller.start();
  assert.equal(calls, 1);
  assert.equal(scheduled.delay, 5000);
  scheduled.callback();
  assert.equal(calls, 2);
  poller.stop();
  assert.equal(cleared, 42);
});

test("page poller does not schedule after cleanup during the initial request", async () => {
  let release;
  let scheduled = false;
  const poller = createPagePoller({
    task: () => new Promise((resolve) => { release = resolve; }),
    intervalMs: 5000,
    setIntervalFn() { scheduled = true; return 1; },
  });
  const starting = poller.start();
  poller.stop();
  release();
  await starting;
  assert.equal(scheduled, false);
});
