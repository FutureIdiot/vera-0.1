import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "../../src/store/store.js";

const ISO = "2026-07-18T00:00:00.000Z";

async function writeCurrentStore(dataPath, accounts) {
  await writeFile(join(dataPath, "accounts.json"), JSON.stringify(accounts, null, 2), "utf8");
  await writeFile(join(dataPath, "meta.json"), JSON.stringify({
    _seq: accounts.length,
    eventSeqWatermark: 0,
    contextSessionsMigrationVersion: 1,
    federationAccountMigrationVersion: 1,
  }, null, 2), "utf8");
}

function account(id, path) {
  return {
    id,
    name: id,
    ownerAgentId: null,
    presence: "offline",
    lastSeenAt: null,
    activeAgentId: null,
    runtimeCapabilities: null,
    accessKeyState: "revoked",
    accessKeyVersion: 0,
    workspace: path === null ? null : {
      accountId: id,
      hostId: " host-a ",
      path,
      status: "ready",
      policy: {},
      lastValidatedAt: ISO,
      updatedAt: ISO,
    },
    createdAt: ISO,
    updatedAt: ISO,
    _seq: id === "acc_a" ? 1 : 2,
  };
}

test("current stores normalize Account Workspace host/path idempotently", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-workspace-normalize-"));
  try {
    await writeCurrentStore(dataPath, [account("acc_a", "/srv/project/./")]);
    const store = await createStore({ dataPath, debounceMs: 1 });
    assert.equal(store.find("accounts", "acc_a").workspace.hostId, "host-a");
    assert.equal(store.find("accounts", "acc_a").workspace.path, "/srv/project");
    await store.close();

    const first = await readFile(join(dataPath, "accounts.json"), "utf8");
    const reopened = await createStore({ dataPath, debounceMs: 1 });
    await reopened.close();
    assert.equal(await readFile(join(dataPath, "accounts.json"), "utf8"), first);
  } finally {
    await rm(dataPath, { recursive: true, force: true });
  }
});

test("duplicate normalized host/path blocks startup without writing", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-workspace-duplicate-"));
  try {
    await writeCurrentStore(dataPath, [
      account("acc_a", "/srv/project"),
      account("acc_b", "/srv/project/./"),
    ]);
    const beforeNames = (await readdir(dataPath)).sort();
    const before = new Map(await Promise.all(beforeNames.map(async (name) => [name, await readFile(join(dataPath, name), "utf8")])));

    await assert.rejects(createStore({ dataPath, debounceMs: 1 }), /bind the same host\/path/u);
    assert.deepEqual((await readdir(dataPath)).sort(), beforeNames);
    for (const name of beforeNames) {
      assert.equal(await readFile(join(dataPath, name), "utf8"), before.get(name));
    }
  } finally {
    await rm(dataPath, { recursive: true, force: true });
  }
});
