import test from "node:test";
import assert from "node:assert/strict";
import { boundApiMessages, checkpointForAgent, checkpointTurnText, estimateTokens } from "../../src/spaces/run-context.js";

test("Agent checkpoint excludes Messages from blocked Agents", () => {
  const records = {
    accounts: [
      { id: "acc_reader", ownerAgentId: "agt_reader" },
      { id: "acc_visible", ownerAgentId: "agt_visible" },
      { id: "acc_blocked", ownerAgentId: "agt_blocked" },
    ],
    spaceSessions: [{ id: "sps_1", spaceId: "spc_1" }],
    spaces: [{
      id: "spc_1",
      seats: [{ accountId: "acc_reader", blockAccountIds: ["acc_blocked"] }],
    }],
    messages: [
      {
        id: "msg_visible", spaceSessionId: "sps_1", status: "completed", _seq: 1,
        author: { type: "account", accountId: "acc_visible" }, executingAgentId: "agt_visible", content: "visible",
      },
      {
        id: "msg_blocked", spaceSessionId: "sps_1", status: "completed", _seq: 2,
        author: { type: "account", accountId: "acc_blocked" }, executingAgentId: "agt_blocked", content: "private blocked text",
      },
      {
        id: "msg_user", spaceSessionId: "sps_1", status: "completed", _seq: 3,
        author: { type: "user" }, content: "user message",
      },
    ],
    runs: [],
    agentSessions: [],
  };
  const store = {
    find(collection, id) {
      return records[collection].find((item) => item.id === id) ?? null;
    },
    list(collection) {
      return records[collection];
    },
  };

  const checkpoint = checkpointForAgent(store, {
    spaceSessionId: "sps_1",
    agentId: "agt_reader",
    recentTurnLimit: 8,
  });
  assert.deepEqual(checkpoint.sourceMessageIds, ["msg_visible", "msg_user"]);
  assert.doesNotMatch(checkpoint.summary, /private blocked text/u);

  const bounded = checkpointForAgent(store, {
    spaceSessionId: "sps_1",
    agentId: "agt_reader",
    recentTurnLimit: 8,
    maxChars: 140,
  });
  assert.deepEqual(bounded.sourceMessageIds, ["msg_visible", "msg_user"]);
  assert.ok(bounded.summary.length <= 140);
});

test("API history pressure removes a whole multi-bubble turn", () => {
  const prefix = { role: "system", content: "system" };
  const current = { role: "user", content: "current" };
  const messages = [
    prefix,
    { role: "user", content: "old input" },
    { role: "assistant", content: "old bubble one" },
    { role: "assistant", content: "old bubble two" },
    current,
  ];
  assert.deepEqual(boundApiMessages(messages, estimateTokens([prefix, current])), [prefix, current]);
});

test("checkpoint carries recent completed Runs as complete structured turns", () => {
  const records = {
    accounts: [{ id: "acc_a", ownerAgentId: "agt_a" }],
    spaceSessions: [{ id: "sps_1", spaceId: "spc_1" }],
    spaces: [{ id: "spc_1", seats: [{ accountId: "acc_a" }] }],
    agentSessions: [{ id: "ags_1", spaceSessionId: "sps_1", agentId: "agt_a", status: "active", checkpoints: [] }],
    messages: [
      { id: "msg_in", spaceSessionId: "sps_1", status: "completed", _seq: 1, author: { type: "user" }, target: { type: "broadcast" }, content: "question" },
      { id: "msg_out_1", spaceSessionId: "sps_1", status: "completed", _seq: 3, author: { type: "account", accountId: "acc_a" }, executingAgentId: "agt_a", content: "part one" },
      { id: "msg_out_2", spaceSessionId: "sps_1", status: "completed", _seq: 4, author: { type: "account", accountId: "acc_a" }, executingAgentId: "agt_a", content: "part two" },
    ],
    runs: [{ id: "run_1", spaceSessionId: "sps_1", agentId: "agt_a", status: "completed", _seq: 2, triggerMessageId: "msg_in", replyMessageIds: ["msg_out_1", "msg_out_2"] }],
  };
  const store = {
    find(collection, id) { return records[collection].find((item) => item.id === id) ?? null; },
    list(collection) { return records[collection]; },
  };
  const checkpoint = checkpointForAgent(store, { spaceSessionId: "sps_1", agentId: "agt_a", recentTurnLimit: 2 });
  assert.equal(checkpoint.summary, "");
  assert.deepEqual(checkpoint.recentTurns[0].assistant.map((item) => item.content), ["part one", "part two"]);
  assert.ok(checkpoint.summary.length + checkpoint.recentTurns.map(checkpointTurnText).join("\n\n").length <= 4000);
});

test("checkpoint refuses a single complete turn that cannot fit its budget", () => {
  const huge = "x".repeat(200);
  const records = {
    accounts: [{ id: "acc_a", ownerAgentId: "agt_a" }],
    spaceSessions: [{ id: "sps_1", spaceId: "spc_1" }],
    spaces: [{ id: "spc_1", seats: [{ accountId: "acc_a" }] }],
    agentSessions: [{ id: "ags_1", spaceSessionId: "sps_1", agentId: "agt_a", status: "active", checkpoints: [] }],
    messages: [
      { id: "msg_in", spaceSessionId: "sps_1", status: "completed", _seq: 1, author: { type: "user" }, content: huge },
      { id: "msg_out", spaceSessionId: "sps_1", status: "completed", _seq: 3, author: { type: "account", accountId: "acc_a" }, executingAgentId: "agt_a", content: huge },
    ],
    runs: [{ id: "run_1", spaceSessionId: "sps_1", agentId: "agt_a", status: "completed", _seq: 2, triggerMessageId: "msg_in", replyMessageIds: ["msg_out"] }],
  };
  const store = {
    find(collection, id) { return records[collection].find((item) => item.id === id) ?? null; },
    list(collection) { return records[collection]; },
  };
  assert.throws(() => checkpointForAgent(store, {
    spaceSessionId: "sps_1", agentId: "agt_a", recentTurnLimit: 8, maxChars: 100,
  }), (error) => error.code === "context_capacity");
});
