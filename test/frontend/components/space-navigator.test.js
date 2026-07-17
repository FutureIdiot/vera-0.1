import test from "node:test";
import assert from "node:assert/strict";
import { resolveSpaceCreationSeats } from "../../../frontend/src/components/space-navigator.js";

const accounts = [
  { id: "acc_a", name: "Alpha" },
  { id: "acc_b", name: "Beta" },
];

test("Space creation has no seats until a contact is selected", () => {
  assert.deepEqual(resolveSpaceCreationSeats(accounts, [], "account:none"), []);
  assert.deepEqual(resolveSpaceCreationSeats(accounts, [], null), []);
});

test("Space creation inherits the selected contact member set", () => {
  assert.deepEqual(resolveSpaceCreationSeats(accounts, [], "account:acc_a"), [
    { accountId: "acc_a", responseMode: "default" },
  ]);

  const spaces = [{
    id: "spc_group",
    seats: [{ accountId: "acc_b" }, { accountId: "acc_a" }],
  }];
  assert.deepEqual(resolveSpaceCreationSeats(accounts, spaces, "group:acc_a,acc_b"), [
    { accountId: "acc_a", responseMode: "default" },
    { accountId: "acc_b", responseMode: "default" },
  ]);
});
