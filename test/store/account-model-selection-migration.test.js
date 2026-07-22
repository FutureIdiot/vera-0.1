import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "../../src/store/store.js";

const ISO = "2026-07-23T00:00:00.000Z";

test("Account model selection migration initializes owned and unowned current Accounts idempotently", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-account-model-migration-"));
  try {
    await writeFile(join(dataPath, "agents.json"), JSON.stringify([{
      id: "agt_model_owner",
      name: "Owner",
      runtimeProfile: { schemaVersion: 1, kind: "cli", provider: "codex", model: "gpt-default" },
      runtimeBinding: { connection: {} },
      runtimeRevision: "sha256:owner",
      createdAt: ISO,
      updatedAt: ISO,
      _seq: 1,
    }]), "utf8");
    await writeFile(join(dataPath, "accounts.json"), JSON.stringify([{
      id: "acc_owned", name: "Owned", ownerAgentId: "agt_model_owner", presence: "offline",
      lastSeenAt: null, activeAgentId: null, runtimeCapabilities: null,
      accessKeyState: "revoked", accessKeyVersion: 0, workspace: null,
      createdAt: ISO, updatedAt: ISO, _seq: 2,
    }, {
      id: "acc_unowned", name: "Unowned", ownerAgentId: null, presence: "offline",
      lastSeenAt: null, activeAgentId: null, runtimeCapabilities: null,
      accessKeyState: "active", accessKeyVersion: 1, workspace: null,
      createdAt: ISO, updatedAt: ISO, _seq: 3,
    }]), "utf8");
    await writeFile(join(dataPath, "meta.json"), JSON.stringify({
      _seq: 3,
      eventSeqWatermark: 0,
      contextSessionsMigrationVersion: 1,
      federationAccountMigrationVersion: 1,
      accountModelSelectionMigrationVersion: 0,
    }), "utf8");

    const store = await createStore({ dataPath, debounceMs: 1 });
    assert.deepEqual(
      (({ model, modelVersion }) => ({ model, modelVersion }))(store.find("accounts", "acc_owned")),
      { model: "gpt-default", modelVersion: 1 },
    );
    assert.deepEqual(
      (({ model, modelVersion }) => ({ model, modelVersion }))(store.find("accounts", "acc_unowned")),
      { model: null, modelVersion: 0 },
    );
    await store.close();
    const meta = JSON.parse(await readFile(join(dataPath, "meta.json"), "utf8"));
    assert.equal(meta.accountModelSelectionMigrationVersion, 1);

    const reopened = await createStore({ dataPath, debounceMs: 1 });
    assert.equal(reopened.find("accounts", "acc_owned").model, "gpt-default");
    assert.equal(reopened.find("accounts", "acc_owned").modelVersion, 1);
    await reopened.close();
  } finally {
    await rm(dataPath, { recursive: true, force: true });
  }
});
