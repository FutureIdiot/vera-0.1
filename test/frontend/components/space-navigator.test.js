import test from "node:test";
import assert from "node:assert/strict";
import { resolveSpaceCreationTarget } from "../../../frontend/src/components/space-navigator.js";

const accounts = [
  { id: "acc_a", name: "Alpha" },
  { id: "acc_b", name: "Beta" },
];

test("Space creation has no seats until a contact is selected", () => {
  assert.deepEqual(resolveSpaceCreationTarget(accounts, [], "account:none"), {
    groupId: null,
    seats: [],
  });
  assert.deepEqual(resolveSpaceCreationTarget(accounts, [], null), {
    groupId: null,
    seats: [],
  });
});

test("Space creation inherits the selected contact member set", () => {
  assert.deepEqual(resolveSpaceCreationTarget(accounts, [], "account:acc_a"), {
    groupId: null,
    seats: [{ accountId: "acc_a", responseMode: "default" }],
  });

  const groups = [{
    id: "grp_ab",
    name: "Alpha Beta",
    topic: "",
    accountIds: ["acc_b", "acc_a"],
  }];
  assert.deepEqual(resolveSpaceCreationTarget(accounts, groups, "group:grp_ab"), {
    groupId: "grp_ab",
    seats: [
      { accountId: "acc_b", responseMode: "default" },
      { accountId: "acc_a", responseMode: "default" },
    ],
  });
});
