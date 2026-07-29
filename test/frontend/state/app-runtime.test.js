import test from "node:test";
import assert from "node:assert/strict";

import { createAppRuntime } from "../../../frontend/src/state/app-runtime.js";

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("runtime owns one SSE connection and replays events newer than a subscriber watermark", async () => {
  const sources = [];
  const platform = {
    async getGatewayUrl() { return "https://vera.test"; },
    async fetch() { return jsonResponse({ agents: [], accounts: [], spaces: [], agentStates: [], seq: 3 }); },
    createEventSource(url) {
      const source = { url, closeCount: 0, close() { this.closeCount += 1; } };
      sources.push(source);
      return source;
    },
  };
  const runtime = createAppRuntime({ platform });
  await runtime.start();
  await flushAsyncWork();

  sources[0].onmessage({ data: JSON.stringify({ seq: 4, type: "message.created", data: { spaceId: "spc_1" } }) });
  const received = [];
  const unsubscribe = runtime.subscribe((event) => received.push(event), { since: 3 });

  assert.deepEqual(received.map((event) => event.seq), [4]);
  assert.equal(sources.length, 1);
  unsubscribe();
  runtime.close();
  assert.ok(sources[0].closeCount >= 1);
});

test("reset buffers live events and keeps the reconnect watermark at the newest replayed seq", async () => {
  const sources = [];
  const timers = [];
  let resolveResetBootstrap;
  let bootstrapRequest = 0;
  const resetBootstrap = new Promise((resolve) => { resolveResetBootstrap = resolve; });
  const platform = {
    async getGatewayUrl() { return "https://vera.test"; },
    async fetch() {
      bootstrapRequest += 1;
      if (bootstrapRequest === 1) {
        return jsonResponse({ agents: [], accounts: [], spaces: [], agentStates: [], seq: 3 });
      }
      return resetBootstrap;
    },
    createEventSource(url) {
      const source = { url, closeCount: 0, close() { this.closeCount += 1; } };
      sources.push(source);
      return source;
    },
  };
  const runtime = createAppRuntime({
    platform,
    reconnectOptions: {
      setTimer(callback) { timers.push(callback); return timers.length; },
      clearTimer() {},
      minDelayMs: 1,
    },
  });
  await runtime.start();
  await flushAsyncWork();
  const received = [];
  runtime.subscribe((event) => received.push(event));

  sources[0].onmessage({ data: JSON.stringify({ seq: 9, type: "stream.reset", data: {} }) });
  await flushAsyncWork();
  sources[0].onmessage({ data: JSON.stringify({ seq: 11, type: "message.created", data: { spaceId: "spc_1" } }) });
  resolveResetBootstrap(jsonResponse({ agents: [], accounts: [], spaces: [], agentStates: [], seq: 10 }));
  await flushAsyncWork();

  assert.deepEqual(received.map((event) => [event.type, event.seq]), [
    ["runtime.reset", 10],
    ["message.created", 11],
  ]);

  sources[0].onerror(new Event("error"));
  assert.equal(timers.length, 1);
  timers[0]();
  await flushAsyncWork();
  assert.match(sources[1].url, /since=11/);
  runtime.close();
});

test("a failed reset stays degraded and retries instead of publishing across a known gap", async () => {
  const sources = [];
  const resetTimers = [];
  let bootstrapRequest = 0;
  const platform = {
    async getGatewayUrl() { return "https://vera.test"; },
    async fetch() {
      bootstrapRequest += 1;
      if (bootstrapRequest === 1) return jsonResponse({ agents: [], accounts: [], spaces: [], agentStates: [], seq: 3 });
      if (bootstrapRequest === 2) throw new Error("bootstrap unavailable");
      return jsonResponse({ agents: [], accounts: [], spaces: [], agentStates: [], seq: 10 });
    },
    createEventSource(url) {
      const source = { url, close() {} };
      sources.push(source);
      return source;
    },
  };
  const runtime = createAppRuntime({
    platform,
    reportError() {},
    setTimer(callback) { resetTimers.push(callback); return resetTimers.length; },
    clearTimer() {},
  });
  await runtime.start();
  await flushAsyncWork();
  const received = [];
  runtime.subscribe((event) => received.push(event));

  sources[0].onmessage({ data: JSON.stringify({ seq: 7, type: "stream.reset", data: {} }) });
  await flushAsyncWork();
  sources[0].onmessage({ data: JSON.stringify({ seq: 8, type: "message.created", data: { spaceId: "spc_1" } }) });

  assert.deepEqual(received.map((event) => event.type), ["runtime.degraded"]);
  assert.equal(resetTimers.length, 1);
  resetTimers[0]();
  await flushAsyncWork();
  assert.deepEqual(received.map((event) => [event.type, event.seq]), [
    ["runtime.degraded", 3],
    ["runtime.reset", 10],
  ]);
  runtime.close();
});

test("space.updated keeps the shared bootstrap projection current", async () => {
  const sources = [];
  const platform = {
    async getGatewayUrl() { return "https://vera.test"; },
    async fetch() { return jsonResponse({ agents: [], accounts: [], spaces: [], agentStates: [], seq: 1 }); },
    createEventSource(url) {
      const source = { url, close() {} };
      sources.push(source);
      return source;
    },
  };
  const runtime = createAppRuntime({ platform });
  await runtime.start();
  await flushAsyncWork();
  sources[0].onmessage({ data: JSON.stringify({ seq: 2, type: "space.updated", data: { space: { id: "spc_1", name: "One", archivedAt: null } } }) });
  assert.equal(runtime.getBootstrap().spaces[0].name, "One");
  sources[0].onmessage({ data: JSON.stringify({ seq: 3, type: "space.updated", data: { space: { id: "spc_1", name: "One", archivedAt: "now" } } }) });
  assert.deepEqual(runtime.getBootstrap().spaces, []);
  runtime.close();
});

test("space.deleted removes the Space from the shared bootstrap projection", async () => {
  const sources = [];
  const platform = {
    async getGatewayUrl() { return "https://vera.test"; },
    async fetch() {
      return jsonResponse({
        agents: [],
        accounts: [],
        spaces: [{ id: "spc_1", name: "One", archivedAt: null }],
        agentStates: [],
        seq: 1,
      });
    },
    createEventSource(url) {
      const source = { url, close() {} };
      sources.push(source);
      return source;
    },
  };
  const runtime = createAppRuntime({ platform });
  await runtime.start();
  await flushAsyncWork();
  sources[0].onmessage({
    data: JSON.stringify({ seq: 2, type: "space.deleted", data: { spaceId: "spc_1" } }),
  });
  assert.deepEqual(runtime.getBootstrap().spaces, []);
  runtime.close();
});

test("Project events upsert and delete the shared bootstrap projection", async () => {
  const sources = [];
  const platform = {
    async getGatewayUrl() { return "https://vera.test"; },
    async fetch() {
      return jsonResponse({
        agents: [],
        accounts: [],
        projects: [],
        spaces: [],
        agentStates: [],
        seq: 1,
      });
    },
    createEventSource(url) {
      const source = { url, close() {} };
      sources.push(source);
      return source;
    },
  };
  const runtime = createAppRuntime({ platform });
  await runtime.start();
  await flushAsyncWork();

  sources[0].onmessage({
    data: JSON.stringify({
      seq: 2,
      type: "project.updated",
      data: { project: { id: "prj_1", name: "Initial" } },
    }),
  });
  sources[0].onmessage({
    data: JSON.stringify({
      seq: 3,
      type: "project.updated",
      data: { project: { id: "prj_1", name: "Renamed" } },
    }),
  });
  assert.deepEqual(runtime.getBootstrap().projects, [{ id: "prj_1", name: "Renamed" }]);

  sources[0].onmessage({
    data: JSON.stringify({
      seq: 4,
      type: "project.deleted",
      data: { projectId: "prj_1" },
    }),
  });
  assert.deepEqual(runtime.getBootstrap().projects, []);
  runtime.close();
});

test("space-session.created advances the canonical active session pointer", async () => {
  const sources = [];
  const platform = {
    async getGatewayUrl() { return "https://vera.test"; },
    async fetch() { return jsonResponse({ agents: [], accounts: [], spaces: [{ id: "spc_1", activeSpaceSessionId: "sps_old" }], agentStates: [], seq: 1 }); },
    createEventSource(url) { const source = { url, close() {} }; sources.push(source); return source; },
  };
  const runtime = createAppRuntime({ platform });
  await runtime.start();
  await flushAsyncWork();
  sources[0].onmessage({ data: JSON.stringify({
    seq: 2,
    type: "space-session.created",
    data: { spaceId: "spc_1", spaceSession: { id: "sps_new" } },
  }) });
  assert.equal(runtime.getBootstrap().spaces[0].activeSpaceSessionId, "sps_new");
  sources[0].onmessage({ data: JSON.stringify({
    seq: 3,
    type: "space-session.resumed",
    data: { spaceId: "spc_1", spaceSession: { id: "sps_old" } },
  }) });
  assert.equal(runtime.getBootstrap().spaces[0].activeSpaceSessionId, "sps_old");
  runtime.close();
});

test("observation.updated keeps the shared process-visibility projection current", async () => {
  const sources = [];
  const platform = {
    async getGatewayUrl() { return "https://vera.test"; },
    async fetch() {
      return jsonResponse({
        agents: [],
        accounts: [],
        spaces: [],
        agentStates: [],
        observation: { observedSpaceId: null, revision: 0 },
        seq: 1,
      });
    },
    createEventSource(url) {
      const source = { url, close() {} };
      sources.push(source);
      return source;
    },
  };
  const runtime = createAppRuntime({ platform });
  await runtime.start();
  await flushAsyncWork();
  sources[0].onmessage({ data: JSON.stringify({
    seq: 2,
    type: "observation.updated",
    data: { observation: { observedSpaceId: "spc_1", revision: 1 } },
  }) });
  assert.deepEqual(runtime.getBootstrap().observation, { observedSpaceId: "spc_1", revision: 1 });
  runtime.close();
});

test("local Space and Group merges plus presence events update the canonical bootstrap projection", async () => {
  const sources = [];
  const platform = {
    async getGatewayUrl() { return "https://vera.test"; },
    async fetch() {
      return jsonResponse({
        agents: [],
        accounts: [{ id: "acc_1", presence: "offline" }],
        groups: [],
        spaces: [],
        agentStates: [],
        seq: 1,
      });
    },
    createEventSource(url) { const source = { url, close() {} }; sources.push(source); return source; },
  };
  const runtime = createAppRuntime({ platform });
  await runtime.start();
  await flushAsyncWork();
  runtime.mergeSpace({ id: "spc_local", name: "Local", archivedAt: null });
  assert.equal(runtime.getBootstrap().spaces[0].id, "spc_local");
  runtime.mergeGroup({ id: "grp_local", name: "Local Group", accountIds: ["acc_1", "acc_2"] });
  assert.equal(runtime.getBootstrap().groups[0].id, "grp_local");
  sources[0].onmessage({ data: JSON.stringify({ seq: 2, type: "account.presence.updated", data: { accountId: "acc_1", presence: "online", lastSeenAt: "now", activeAgentId: "agt_1" } }) });
  assert.deepEqual(runtime.getBootstrap().accounts[0], { id: "acc_1", presence: "online", lastSeenAt: "now", activeAgentId: "agt_1" });
  runtime.close();
});

test("local Project merges update the canonical projection and notify subscribers once", async () => {
  const platform = {
    async getGatewayUrl() { return "https://vera.test"; },
    async fetch() {
      return jsonResponse({
        agents: [],
        accounts: [],
        projects: [],
        groups: [],
        spaces: [],
        agentStates: [],
        seq: 1,
      });
    },
    createEventSource() { return { close() {} }; },
  };
  const runtime = createAppRuntime({ platform });
  await runtime.start();
  await flushAsyncWork();
  const received = [];
  runtime.subscribe((event) => received.push(event));

  runtime.mergeProject({ id: "prj_local", name: "Local" });
  runtime.mergeProject({ id: "prj_local", name: "Updated" });

  assert.deepEqual(runtime.getBootstrap().projects, [{ id: "prj_local", name: "Updated" }]);
  assert.deepEqual(received.map((event) => event.type), ["project.updated", "project.updated"]);
  assert.equal(received[0].data.project.name, "Local");
  assert.equal(received[1].data.project.name, "Updated");
  runtime.close();
});

test("local Agent and Account mutations keep route transitions on the canonical projection", async () => {
  const platform = {
    async getGatewayUrl() { return "https://vera.test"; },
    async fetch() { return jsonResponse({ agents: [], accounts: [], spaces: [], agentStates: [], seq: 1 }); },
    createEventSource() { return { close() {} }; },
  };
  const runtime = createAppRuntime({ platform });
  await runtime.start();
  await flushAsyncWork();
  const agent = { id: "agt_new", name: "New" };
  const account = { id: "acc_new", ownerAgentId: agent.id, name: "New account" };
  runtime.mergeAgent(agent);
  runtime.mergeAccount(account);
  assert.deepEqual(runtime.getBootstrap().agents.find((item) => item.id === agent.id), agent);
  assert.deepEqual(runtime.getBootstrap().accounts.find((item) => item.id === account.id), account);
  runtime.removeAccount(account.id);
  assert.equal(runtime.getBootstrap().accounts.some((item) => item.id === account.id), false);
  runtime.mergeAccount(account);
  runtime.removeAgent(agent.id);
  assert.equal(runtime.getBootstrap().agents.some((item) => item.id === agent.id), false);
  assert.equal(runtime.getBootstrap().accounts.some((item) => item.ownerAgentId === agent.id), false);
  runtime.close();
});

test("AgentState events merge by Agent, Account, and Space without cross-Account replacement", async () => {
  const sources = [];
  const platform = {
    async getGatewayUrl() { return "https://vera.test"; },
    async fetch() { return jsonResponse({ agents: [], accounts: [], spaces: [], agentStates: [], seq: 1 }); },
    createEventSource(url) { const source = { url, close() {} }; sources.push(source); return source; },
  };
  const runtime = createAppRuntime({ platform });
  await runtime.start();
  await flushAsyncWork();

  const state = (accountId, status, seq) => ({
    seq,
    type: "agent.state.updated",
    data: {
      agentState: {
        agentId: "agt_shared",
        accountId,
        spaceId: "spc_shared",
        status,
        detail: "",
        lastActiveAt: `2026-07-19T00:00:0${seq}.000Z`,
      },
    },
  });
  sources[0].onmessage({ data: JSON.stringify(state("acc_a", "coding", 2)) });
  sources[0].onmessage({ data: JSON.stringify(state("acc_b", "reading", 3)) });
  sources[0].onmessage({ data: JSON.stringify(state("acc_a", "typing", 4)) });

  assert.deepEqual(runtime.getBootstrap().agentStates.map(({ accountId, status }) => ({ accountId, status })), [
    { accountId: "acc_a", status: "typing" },
    { accountId: "acc_b", status: "reading" },
  ]);
  runtime.close();
});
