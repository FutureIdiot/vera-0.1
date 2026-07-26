import test from "node:test";
import assert from "node:assert/strict";
import {
  filterAndSortSpaces,
  resolveSpaceCreationTarget,
  sortProjectGroups,
} from "../../../frontend/src/components/space-navigator-projection.js";

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

test("Space filtering is a derived projection and does not mutate canonical order", () => {
  const spaces = [
    {
      id: "spc_old",
      name: "Notes",
      spaceType: "notebook",
      projectId: "prj_docs",
      updatedAt: "2026-07-25T00:00:00.000Z",
    },
    {
      id: "spc_new",
      name: "Chat",
      spaceType: "chat",
      projectId: null,
      updatedAt: "2026-07-26T00:00:00.000Z",
    },
  ];

  const filtered = filterAndSortSpaces(
    spaces,
    [{ id: "prj_docs", name: "Documentation" }],
    "documentation",
  );

  assert.deepEqual(filtered.map((space) => space.id), ["spc_old"]);
  assert.deepEqual(spaces.map((space) => space.id), ["spc_old", "spc_new"]);
});

test("Projects sorting always leaves No project last", () => {
  const groups = [
    { id: "prj_old", items: [{ updatedAt: "2026-07-24T00:00:00.000Z" }] },
    { id: null, items: [{ updatedAt: "2026-07-26T00:00:00.000Z" }] },
    { id: "prj_new", items: [{ updatedAt: "2026-07-25T00:00:00.000Z" }] },
  ];

  assert.deepEqual(
    sortProjectGroups(groups).map((group) => group.id),
    ["prj_new", "prj_old", null],
  );
  assert.deepEqual(groups.map((group) => group.id), ["prj_old", null, "prj_new"]);
});
