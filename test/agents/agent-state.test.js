import test from "node:test";
import assert from "node:assert/strict";

import { createRouter } from "../../src/api/router.js";
import { createAgentStateTracker, AGENT_STATE_STATUSES } from "../../src/agents/agent-state.js";
import { registerAgentRoutes } from "../../src/agents/routes.js";

const AGENT_ID = "agt_state_owner";
const ACCOUNT_ID = "acc_state_owner";
const SPACE_A = "spc_state_a";
const SPACE_B = "spc_state_b";

function authority(overrides = {}) {
  return {
    agentId: AGENT_ID,
    ownerAgentId: AGENT_ID,
    accountId: ACCOUNT_ID,
    spaceId: SPACE_A,
    ...overrides,
  };
}

function declaration(overrides = {}) {
  return {
    agentId: AGENT_ID,
    accountId: ACCOUNT_ID,
    spaceId: SPACE_A,
    status: "coding",
    detail: "reviewing AgentState",
    ...overrides,
  };
}

function request(router, url) {
  let status;
  let payload = "";
  const req = { method: "GET", url, headers: {}, async *[Symbol.asyncIterator]() {} };
  const res = {
    setHeader() {},
    writeHead(nextStatus) { status = nextStatus; },
    end(chunk = "") { payload += chunk; },
  };
  return router.handle(req, res).then(() => ({ status, json: JSON.parse(payload) }));
}

test("daemon declarations use independent agentId:accountId:spaceId keys and publish exact states", () => {
  const events = [];
  let tick = 0;
  const tracker = createAgentStateTracker({
    hub: { publish(type, payload) { events.push({ type, payload }); } },
    now: () => new Date(`2026-07-19T00:00:0${tick++}.000Z`),
  });

  const first = tracker.declare(authority(), declaration());
  const second = tracker.declare(
    authority({ spaceId: SPACE_B }),
    declaration({ spaceId: SPACE_B, status: "reading", detail: "reading tests" }),
  );
  const updated = tracker.declare(authority(), declaration({ status: "typing", detail: "writing result" }));

  assert.deepEqual(first, {
    agentId: AGENT_ID,
    accountId: ACCOUNT_ID,
    spaceId: SPACE_A,
    status: "coding",
    detail: "reviewing AgentState",
    lastActiveAt: "2026-07-19T00:00:00.000Z",
  });
  assert.deepEqual(tracker.list(), [updated, second]);
  assert.equal(events.length, 3);
  assert.deepEqual(events.at(-1), {
    type: "agent.state.updated",
    payload: { agentState: updated },
  });

  first.status = "away";
  events.at(-1).payload.agentState.status = "away";
  assert.equal(tracker.list({ spaceId: SPACE_A })[0].status, "typing");
});

test("all documented statuses are accepted and legacy gateway inference creates no state", () => {
  const tracker = createAgentStateTracker({ hub: { publish() {} } });
  for (const status of AGENT_STATE_STATUSES) {
    assert.equal(tracker.declare(authority(), declaration({ status })).status, status);
  }
  const count = tracker.list().length;
  assert.equal(tracker.ensure(AGENT_ID), null);
  assert.equal(tracker.setWorking(AGENT_ID, SPACE_B), null);
  assert.equal(tracker.setIdle(AGENT_ID), null);
  assert.equal(tracker.list().length, count);
  assert.equal(tracker.list().some((state) => state.status === "working"), false);
});

test("declarations reject non-owner authority and forged Agent, Account, or Space dimensions", () => {
  const tracker = createAgentStateTracker({ hub: { publish() {} } });

  assert.throws(
    () => tracker.declare(authority({ ownerAgentId: "agt_someone_else" }), declaration()),
    (error) => error.code === "delegation_unavailable",
  );
  for (const [field, value] of [
    ["agentId", "agt_forged"],
    ["accountId", "acc_forged"],
    ["spaceId", "spc_forged"],
  ]) {
    assert.throws(
      () => tracker.declare(authority(), declaration({ [field]: value })),
      (error) => error.code === "forbidden" && error.message.includes(field),
    );
  }
  assert.deepEqual(tracker.list(), []);
});

test("declarations enforce the strict shape, enum, and single-line detail", () => {
  const tracker = createAgentStateTracker({ hub: { publish() {} } });
  const invalid = [
    null,
    [],
    {},
    { ...declaration(), status: "working" },
    { ...declaration(), detail: null },
    { ...declaration(), detail: "line one\nline two" },
    { ...declaration(), lastActiveAt: "forged" },
    { ...declaration(), extra: true },
  ];
  for (const candidate of invalid) {
    assert.throws(
      () => tracker.declare(authority(), candidate),
      (error) => error.code === "invalid_request",
    );
  }
  assert.deepEqual(tracker.list(), []);
});

test("GET /api/agent-states forwards spaceId, accountId, and agentId filters", async () => {
  const calls = [];
  const router = createRouter();
  registerAgentRoutes(router, {
    store: {},
    agentStates: {
      list(filters) {
        calls.push(filters);
        return [{ ...declaration(), lastActiveAt: "2026-07-19T00:00:00.000Z" }];
      },
    },
  });

  const response = await request(
    router,
    `/api/agent-states?spaceId=${SPACE_A}&accountId=${ACCOUNT_ID}&agentId=${AGENT_ID}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ spaceId: SPACE_A, accountId: ACCOUNT_ID, agentId: AGENT_ID }]);
  assert.equal(response.json.agentStates[0].accountId, ACCOUNT_ID);
});
