import test from "node:test";
import assert from "node:assert/strict";

import {
  parseWorkspace,
  projectWorkspace,
  refreshWorkspaceBinding,
} from "../../src/spaces/workspace-control.js";

const workspaceInput = (path, overrides = {}) => ({
  hostId: "host-a",
  path,
  status: "ready",
  policy: { allow: ["read"] },
  ...overrides,
});

test("parseWorkspace canonicalizes equivalent absolute paths", () => {
  assert.equal(parseWorkspace(workspaceInput("/srv/vera/project-a/.")).path, "/srv/vera/project-a");
  assert.equal(parseWorkspace(workspaceInput("/srv/vera/project-a/child/../")).path, "/srv/vera/project-a");
  assert.throws(
    () => parseWorkspace(workspaceInput("relative/project")),
    (error) => error.code === "invalid_request",
  );
});

test("first Workspace binding rejects a normalized host and path already owned by another Account", () => {
  const account = { id: "acc-new", workspace: null };
  const other = {
    id: "acc-other",
    workspace: workspaceInput("/srv/vera/project-a/"),
  };

  let caught;
  assert.throws(
    () => refreshWorkspaceBinding(account, parseWorkspace(workspaceInput("/srv/vera/project-a/.")), {
      runtimeHostId: "host-a",
      accounts: [account, other],
    }),
    (error) => {
      caught = error;
      return error.code === "workspace_unavailable";
    },
  );
  assert.equal(caught.message.includes("acc-other"), false);
  assert.equal(caught.message.includes("/srv/vera/project-a"), false);
});

test("same Account reconnect matches canonical path and refreshes status", () => {
  const account = {
    id: "acc-owner",
    workspace: workspaceInput("/srv/vera/project-a/"),
  };
  const incoming = parseWorkspace(workspaceInput("/srv/vera/project-a/.", {
    status: "degraded",
    policy: { allow: ["write"] },
  }));
  const refreshed = refreshWorkspaceBinding(account, incoming, {
    runtimeHostId: "host-a",
    accounts: [account],
  });

  assert.equal(refreshed.path, "/srv/vera/project-a");
  assert.equal(refreshed.status, "degraded");
  assert.deepEqual(refreshed.policy, { allow: ["read"] });
  assert.notEqual(refreshed.updatedAt, undefined);
});

test("Workspace control is pure with respect to Space, Message, and File records", () => {
  const records = {
    spaces: [{ id: "spc-1", name: "Space" }],
    messages: [{ id: "msg-1", spaceId: "spc-1", content: "hello" }],
    files: [{ id: "file-1", ownerSpaceId: "spc-1", name: "note.txt" }],
  };
  const before = structuredClone(records);
  const account = { id: "acc-owner", workspace: null };
  const binding = refreshWorkspaceBinding(account, parseWorkspace(workspaceInput("/srv/vera/project-a")), {
    runtimeHostId: "host-a",
    accounts: [account],
  });

  assert.equal(binding.accountId, account.id);
  assert.deepEqual(records, before);
  assert.deepEqual(projectWorkspace({
    ...binding,
    path: "/srv/vera/project-a",
    policy: { allow: ["write"] },
  }), {
    accountId: account.id,
    hostId: "host-a",
    status: "ready",
    lastValidatedAt: binding.lastValidatedAt,
    updatedAt: binding.updatedAt,
  });
});
