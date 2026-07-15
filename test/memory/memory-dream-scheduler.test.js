import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryDreamScheduler, dreamScheduleMatches, nextDreamRunAt } from "../../src/memory/memory-dream-scheduler.js";

test("Dream daily and weekly schedules use their declared IANA timezone", () => {
  const instant = new Date("2026-07-15T00:30:00.000Z");
  assert.equal(dreamScheduleMatches({ mode: "daily", timezone: "Asia/Tokyo", time: "09:30" }, instant), true);
  assert.equal(dreamScheduleMatches({ mode: "weekly", timezone: "Asia/Tokyo", weekday: 3, time: "09:30" }, instant), true);
  assert.equal(nextDreamRunAt({ mode: "daily", timezone: "UTC", time: "00:31" }, instant), "2026-07-15T00:31:00.000Z");
});

test("Dream scheduler catches up only the latest matching slot with a stable key", async () => {
  const calls = [];
  const record = {
    version: "cfg-one",
    config: {
      agentId: "agt_sched01",
      provider: { providerId: "vera.markdown", config: {} },
      dream: { schedule: { mode: "daily", timezone: "UTC", time: "03:00" } },
    },
  };
  const scheduler = createMemoryDreamScheduler({
    configService: { listAll: () => [record] },
    dreamService: { enqueue: async (input) => { calls.push(input); } },
    clock: { now: () => new Date("2026-07-15T04:00:00.000Z") },
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn: () => {},
  });
  scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.close();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, "agt_sched01");
  assert.equal(calls[0].trigger, "scheduled");
  assert.match(calls[0].scheduleKey, /^sha256:[a-f0-9]{64}$/);
});
