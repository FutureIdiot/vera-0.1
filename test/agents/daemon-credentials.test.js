import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDaemonCredentialStore } from "../../src/agents/daemon-credentials.js";
import { loadConfig } from "../../src/core/config.js";

const AGENT_TOKEN = `vat_${"a".repeat(43)}`;
const ACCOUNT_KEY = `vak_${"b".repeat(43)}`;

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "vera-daemon-credentials-"));
  const secretsPath = join(root, "secrets.json");
  try {
    await fn({ root, secretsPath, store: createDaemonCredentialStore({ secretsPath }) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("daemon credentials persist only Agent Token and optional Account Key at mode 0600", async () => {
  await fixture(async ({ secretsPath, store }) => {
    assert.equal(await store.load({ agentId: "agt_a", accountId: "acc_a" }), null);
    assert.deepEqual(await store.save({
      agentId: "agt_a", accountId: "acc_a", agentToken: AGENT_TOKEN, accountKey: ACCOUNT_KEY,
    }), { saved: true, accountKeyStored: true });
    assert.deepEqual(await store.load({ agentId: "agt_a", accountId: "acc_a" }), {
      agentToken: AGENT_TOKEN,
      accountKey: ACCOUNT_KEY,
    });
    assert.equal((await lstat(secretsPath)).mode & 0o777, 0o600);
    const persisted = JSON.parse(await readFile(secretsPath, "utf8"));
    assert.deepEqual(Object.keys(persisted.agentCredentials.agt_a).sort(), ["accountKeys", "agentToken"]);
    assert.equal(JSON.stringify(persisted).includes("AccountSession"), false);
  });
});

test("credential updates preserve unrelated secretRef data and can omit the Account Key", async () => {
  await fixture(async ({ secretsPath, store }) => {
    await writeFile(secretsPath, JSON.stringify({ providerApiKey: "provider-secret" }), { mode: 0o600 });
    await store.save({ agentId: "agt_a", accountId: "acc_a", agentToken: AGENT_TOKEN, accountKey: ACCOUNT_KEY });
    await store.save({ agentId: "agt_a", accountId: "acc_a", agentToken: AGENT_TOKEN, accountKey: null });
    assert.deepEqual(await store.load({ agentId: "agt_a", accountId: "acc_a" }), {
      agentToken: AGENT_TOKEN,
      accountKey: null,
    });
    const persisted = JSON.parse(await readFile(secretsPath, "utf8"));
    assert.equal(persisted.providerApiKey, "provider-secret");
  });
});

test("credential store rejects symlinks, loose permissions, and AccountSession fields", async () => {
  await fixture(async ({ root, secretsPath, store }) => {
    const target = join(root, "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, secretsPath);
    await assert.rejects(store.load({ agentId: "agt_a", accountId: "acc_a" }), (error) =>
      error.code === "internal" && !error.message.includes(root));
    await rm(secretsPath);

    await writeFile(secretsPath, "{}", { mode: 0o644 });
    await assert.rejects(store.load({ agentId: "agt_a", accountId: "acc_a" }), (error) => error.code === "internal");
    await chmod(secretsPath, 0o600);
    await writeFile(secretsPath, JSON.stringify({
      agentCredentials: {
        agt_a: { agentToken: AGENT_TOKEN, accountKeys: {}, accountSessionToken: "must-not-persist" },
      },
    }));
    await chmod(secretsPath, 0o600);
    await assert.rejects(store.load({ agentId: "agt_a", accountId: "acc_a" }), (error) => error.code === "internal");
  });
});

test("daemon secrets path is centralized and configurable", () => {
  assert.match(loadConfig({ HOME: "/ignored" }).agentDaemon.secretsPath, /\.vera\/secrets\.json$/u);
  assert.equal(loadConfig({ VERA_AGENT_SECRETS_PATH: "/tmp/vera-secrets.json" }).agentDaemon.secretsPath,
    "/tmp/vera-secrets.json");
});
