import test from "node:test";
import assert from "node:assert/strict";

import { resolvePrivateAccountStatus } from "../../../frontend/src/state/agent-status.js";

const account = {
  id: "acc_a",
  presence: "online",
  activeAgentId: "agt_a",
};

test("private Account status derives offline and keeps the canonical idle state", () => {
  assert.equal(resolvePrivateAccountStatus({
    account: { ...account, presence: "offline" },
    spaceId: "spc_a",
  }), "offline");
  assert.equal(resolvePrivateAccountStatus({
    account,
    spaceId: "spc_a",
  }), "idle");
});

test("private Account status follows the active Agent in the current Space", () => {
  const agentStates = [
    {
      agentId: "agt_other",
      accountId: "acc_a",
      spaceId: "spc_a",
      status: "thinking",
      lastActiveAt: "2026-07-26T00:00:02.000Z",
    },
    {
      agentId: "agt_a",
      accountId: "acc_a",
      spaceId: "spc_a",
      status: "needs_you",
      lastActiveAt: "2026-07-26T00:00:01.000Z",
    },
  ];
  assert.equal(resolvePrivateAccountStatus({
    account,
    spaceId: "spc_a",
    agentStates,
  }), "needs you");
  assert.equal(resolvePrivateAccountStatus({
    account,
    spaceId: "spc_other",
    agentStates,
  }), "idle");
});
