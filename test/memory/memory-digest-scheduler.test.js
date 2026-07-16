import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryDigestScheduler,
  cronMatches,
  parseFiveFieldCron,
} from "../../src/memory/memory-digest-scheduler.js";

function fixture({ trigger = "manual", schedule = "* * * * *", threshold = 4, now = "2026-07-13T03:00:30" } = {}) {
  const data = { spaces: [], spaceSessions: [], agentSessions: [], messages: [], memoryDigestJobs: [] };
  const calls = [];
  const timers = [];
  let current = new Date(now);
  const settings = {
    "memory.digestTrigger": trigger,
    "memory.digestSchedule": schedule,
    "memory.digestRealtimeThresholdChars": threshold,
  };
  const store = {
    list(name) { return data[name]; },
    find(name, id) { return data[name].find((item) => item.id === id) ?? null; },
  };
  const scheduler = createMemoryDigestScheduler({
    store,
    digestService: { enqueueIncremental(input) { calls.push(input); return { id: `job-${calls.length}` }; } },
    settingsStore: { getAll: () => settings },
    clock: { now: () => new Date(current) },
    setTimeoutFn(fn, delay) {
      const timer = { fn, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cleared = true; },
    logger: { error() {} },
  });
  return {
    data, calls, timers, scheduler, settings,
    setNow(value) { current = new Date(value); },
    async settle() { await new Promise((resolve) => setImmediate(resolve)); },
  };
}

function addSpace(f, id = "spc_one", agentIds = ["agt_one"], spaceSessionId = `sps_${id.slice(4)}`) {
  f.data.spaces.push({ id, seats: agentIds.map((agentId) => ({ agentId })) });
  f.data.spaceSessions.push({ id: spaceSessionId, spaceId: id, status: "active" });
  for (const agentId of new Set(agentIds)) {
    f.data.agentSessions.push({ id: `ags_${spaceSessionId}_${agentId}`, spaceSessionId, agentId, generation: 1 });
  }
}

function addMessage(f, { id, spaceId = "spc_one", spaceSessionId = `sps_${spaceId.slice(4)}`, content, status = "completed", seq }) {
  const message = { id, spaceId, spaceSessionId, content, status, _seq: seq };
  f.data.messages.push(message);
  return message;
}

test("five-field cron supports steps/ranges and process-local Date fields", () => {
  const cron = parseFiveFieldCron("*/15 2-4 * * 1-5");
  const monday = new Date(2026, 6, 13, 3, 30, 0);
  assert.equal(cronMatches(cron, monday), true);
  monday.setMinutes(31);
  assert.equal(cronMatches(cron, monday), false);
  assert.throws(() => parseFiveFieldCron("0 3 * *"), /exactly five/);
  assert.throws(() => parseFiveFieldCron("60 3 * * *"), /out of range/);
});

test("scheduled start catches up pending windows once and schedules the next minute", async () => {
  const f = fixture({ trigger: "scheduled" });
  addSpace(f, "spc_one", ["agt_one", "agt_one", "agt_two"]);
  addMessage(f, { id: "msg_one", content: "saved", seq: 1 });

  f.scheduler.start();
  await f.settle();

  assert.deepEqual(f.calls, [
    { agentId: "agt_one", spaceId: "spc_one", spaceSessionId: "sps_one", trigger: "scheduled", toMessageId: "msg_one" },
    { agentId: "agt_two", spaceId: "spc_one", spaceSessionId: "sps_one", trigger: "scheduled", toMessageId: "msg_one" },
  ]);
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].delay, 30_000);

  f.setNow("2026-07-13T03:01:00");
  f.timers[0].fn();
  await f.settle();
  assert.equal(f.calls.length, 4, "the matching cron minute uses the same incremental facade");
  f.scheduler.close();
  assert.equal(f.timers.at(-1).cleared, true);
});

test("scheduled catch-up skips a window already covered by a succeeded incremental job", async () => {
  const f = fixture({ trigger: "scheduled" });
  addSpace(f);
  addMessage(f, { id: "msg_done", content: "done", seq: 1 });
  f.data.memoryDigestJobs.push({
    id: "mdj_done", agentId: "agt_one", spaceId: "spc_one", spaceSessionId: "sps_one", mode: "incremental",
    status: "succeeded", range: { toMessageId: "msg_done" },
  });
  f.scheduler.start();
  await f.settle();
  assert.deepEqual(f.calls, []);
});

test("scheduled catch-up preserves archived SpaceSession backlog after new window", async () => {
  const f = fixture({ trigger: "scheduled" });
  addSpace(f, "spc_one", ["agt_one"], "sps_old");
  f.data.spaceSessions[0].status = "archived";
  f.data.spaceSessions.push({ id: "sps_new", spaceId: "spc_one", status: "active" });
  f.data.agentSessions.push({ id: "ags_new", spaceSessionId: "sps_new", agentId: "agt_one", generation: 1 });
  addMessage(f, { id: "msg_old", spaceSessionId: "sps_old", content: "old backlog", seq: 1 });
  addMessage(f, { id: "msg_new", spaceSessionId: "sps_new", content: "new backlog", seq: 2 });
  f.scheduler.start();
  await f.settle();
  assert.deepEqual(f.calls, [
    { agentId: "agt_one", spaceId: "spc_one", spaceSessionId: "sps_old", trigger: "scheduled", toMessageId: "msg_old" },
    { agentId: "agt_one", spaceId: "spc_one", spaceSessionId: "sps_new", trigger: "scheduled", toMessageId: "msg_new" },
  ]);
});

test("realtime threshold counts Unicode code points after the successful watermark", async () => {
  const f = fixture({ trigger: "realtime", threshold: 3 });
  addSpace(f);
  const old = addMessage(f, { id: "msg_old", content: "旧内容", seq: 1 });
  f.data.memoryDigestJobs.push({
    id: "mdj_old", agentId: "agt_one", spaceId: "spc_one", spaceSessionId: "sps_one", mode: "incremental",
    status: "succeeded", range: { toMessageId: old.id },
  });
  f.scheduler.start();
  const emoji = addMessage(f, { id: "msg_emoji", content: "😀a", seq: 2 });
  f.scheduler.onMessageCommitted(emoji);
  await f.settle();
  assert.equal(f.calls.length, 0, "an astral emoji is one Unicode code point, not two UTF-16 units");

  const last = addMessage(f, { id: "msg_last", content: "界", seq: 3 });
  f.scheduler.onMessageCommitted(last);
  await f.settle();
  assert.deepEqual(f.calls, [{
    agentId: "agt_one", spaceId: "spc_one", spaceSessionId: "sps_one", trigger: "realtime", toMessageId: "msg_last",
  }]);
});

test("failed jobs do not advance realtime watermarks and non-completed Messages do not count", async () => {
  const f = fixture({ trigger: "realtime", threshold: 4 });
  addSpace(f);
  addMessage(f, { id: "msg_failed_state", content: "xxxx", status: "failed", seq: 1 });
  addMessage(f, { id: "msg_evidence", content: "abcd", seq: 2 });
  f.data.memoryDigestJobs.push({
    id: "mdj_failed", agentId: "agt_one", spaceId: "spc_one", spaceSessionId: "sps_one", mode: "incremental",
    status: "failed", range: { toMessageId: "msg_evidence" },
  });
  const committed = f.data.messages[1];
  f.scheduler.start();
  f.scheduler.onMessageCommitted(committed);
  await f.settle();
  assert.equal(f.calls.length, 1);
});

test("refreshSettings keeps automatic strategies mutually exclusive and manual out of scheduler", async () => {
  const f = fixture({ trigger: "scheduled", threshold: 1 });
  addSpace(f);
  const message = addMessage(f, { id: "msg_one", content: "x", seq: 1 });
  f.scheduler.start();
  await f.settle();
  const scheduledTimer = f.timers[0];

  f.scheduler.refreshSettings({
    ...f.settings,
    "memory.digestTrigger": "realtime",
  });
  assert.equal(scheduledTimer.cleared, true);
  f.scheduler.onMessageCommitted(message);
  await f.settle();
  assert.equal(f.calls.at(-1).trigger, "realtime");

  const count = f.calls.length;
  f.scheduler.refreshSettings({ ...f.settings, "memory.digestTrigger": "manual" });
  f.scheduler.onMessageCommitted(message);
  await f.settle();
  assert.equal(f.calls.length, count, "manual remains an API/MCP concern, not a scheduler action");
});

test("an unrelated Settings refresh does not bypass cron with an immediate catch-up", async () => {
  const f = fixture({ trigger: "scheduled", schedule: "0 3 * * *" });
  addSpace(f);
  addMessage(f, { id: "msg_one", content: "one", seq: 1 });
  f.scheduler.start();
  await f.settle();
  assert.equal(f.calls.length, 1);
  addMessage(f, { id: "msg_two", content: "two", seq: 2 });
  f.scheduler.refreshSettings({ ...f.settings, "appearance.theme": "dark" });
  await f.settle();
  assert.equal(f.calls.length, 1);
});

test("onMessageCommitted never waits for or surfaces digest failures", async () => {
  const data = {
    spaces: [{ id: "spc_one", seats: [{ agentId: "agt_one" }] }],
    spaceSessions: [{ id: "sps_one", spaceId: "spc_one", status: "active" }],
    agentSessions: [{ id: "ags_one", spaceSessionId: "sps_one", agentId: "agt_one", generation: 1 }],
    messages: [{ id: "msg_one", spaceId: "spc_one", spaceSessionId: "sps_one", content: "x", status: "completed", _seq: 1 }],
    memoryDigestJobs: [],
  };
  const errors = [];
  let rejectJob;
  const scheduler = createMemoryDigestScheduler({
    store: {
      list: (name) => data[name],
      find: (name, id) => data[name].find((item) => item.id === id) ?? null,
    },
    digestService: { enqueueIncremental: () => new Promise((resolve, reject) => { rejectJob = reject; }) },
    settingsStore: { getAll: () => ({
      "memory.digestTrigger": "realtime",
      "memory.digestSchedule": "* * * * *",
      "memory.digestRealtimeThresholdChars": 1,
    }) },
    logger: { error: (...args) => errors.push(args) },
  });
  scheduler.start();
  assert.equal(scheduler.onMessageCommitted(data.messages[0]), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  rejectJob(Object.assign(new Error("provider-secret-canary"), { code: "executor_failed" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal(JSON.stringify(errors).includes("provider-secret-canary"), false);
  scheduler.close();
});
