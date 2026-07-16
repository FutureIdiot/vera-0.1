import test from "node:test";
import assert from "node:assert/strict";
import { resolveSpaceCreationSeats } from "../../../frontend/src/components/space-navigator.js";

const agents = [
  { id: "agt_a", name: "Alpha" },
  { id: "agt_b", name: "Beta" },
];

test("Space creation has no seats until a contact is selected", () => {
  assert.deepEqual(resolveSpaceCreationSeats(agents, [], "agent:none"), []);
  assert.deepEqual(resolveSpaceCreationSeats(agents, [], null), []);
});

test("Space creation inherits the selected contact member set", () => {
  assert.deepEqual(resolveSpaceCreationSeats(agents, [], "agent:agt_a"), [
    { agentId: "agt_a", responseMode: "default" },
  ]);

  const spaces = [{
    id: "spc_group",
    seats: [{ agentId: "agt_b" }, { agentId: "agt_a" }],
  }];
  assert.deepEqual(resolveSpaceCreationSeats(agents, spaces, "group:agt_a,agt_b"), [
    { agentId: "agt_a", responseMode: "default" },
    { agentId: "agt_b", responseMode: "default" },
  ]);
});
