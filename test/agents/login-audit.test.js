import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUnownedAccount } from "../../src/agents/accounts.js";
import { createControlService } from "../../src/agents/control-service.js";
import {
  listAccountLoginAudits,
  recordAccountLoginAudit,
} from "../../src/agents/login-audit.js";
import { createStore } from "../../src/store/store.js";

const profile = { schemaVersion: 1, kind: "cli", provider: "mock", model: "mock-v1" };

function loginBody(accountId, daemonBootId = "daemon-a") {
  return {
    accountId,
    daemonBootId,
    runtime: {
      hostId: "host-a",
      kind: "cli",
      provider: "mock",
      model: "mock-v1",
      revision: "sha256:runtime-a",
      runtimeCapabilities: { models: ["mock-v1"], tools: [] },
    },
    workspace: {
      hostId: "host-a",
      path: "/srv/vera/project-a",
      status: "ready",
      policy: { allow: ["read"] },
    },
  };
}

async function rejectedCode(promise) {
  return promise.then(
    () => null,
    (error) => error.code,
  );
}

test("login audit persists a strict newest-first projection capped at 200 per Account", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-login-audit-store-"));
  let store = await createStore({ dataPath, debounceMs: 1 });
  try {
    const created = createUnownedAccount(store, { name: "Audit" });
    for (let index = 0; index < 205; index += 1) {
      recordAccountLoginAudit(store, {
        accountId: created.account.id,
        agentId: null,
        event: "login",
        result: "rejected",
        reasonCode: "unauthorized",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
    }
    assert.equal(store.find("accounts", created.account.id).loginAudits.length, 200);
    assert.equal(listAccountLoginAudits(store, created.account.id).length, 20);
    assert.equal(listAccountLoginAudits(store, created.account.id)[0].createdAt, "2026-01-01T00:03:24.000Z");
    assert.equal(listAccountLoginAudits(store, created.account.id, { limit: 200 }).at(-1).createdAt, "2026-01-01T00:00:05.000Z");
    assert.deepEqual(Object.keys(listAccountLoginAudits(store, created.account.id)[0]), [
      "id", "accountId", "agentId", "event", "result", "reasonCode", "createdAt",
    ]);

    assert.throws(() => recordAccountLoginAudit(store, {
      accountId: created.account.id,
      agentId: null,
      event: "login",
      result: "rejected",
      reasonCode: "unauthorized",
      accessKey: "vak_must-never-persist",
    }), /unsupported fields/u);
    assert.throws(() => recordAccountLoginAudit(store, {
      accountId: created.account.id,
      agentId: null,
      event: "login",
      result: "rejected",
      reasonCode: "free_text_failure",
    }), /stable API error code/u);
    assert.throws(() => recordAccountLoginAudit(store, {
      accountId: created.account.id,
      agentId: null,
      event: "login",
      result: "rejected",
      reasonCode: "toString",
    }), /stable API error code/u);
    assert.equal(JSON.stringify(store.find("accounts", created.account.id)).includes("vak_must-never-persist"), false);

    const tied = createUnownedAccount(store, { name: "Tie order" });
    const tiedAt = "2026-01-02T00:00:00.000Z";
    store.update("accounts", tied.account.id, {
      loginAudits: [
        { id: "ala_a", accountId: tied.account.id, agentId: null, event: "login", result: "rejected", reasonCode: "unauthorized", createdAt: tiedAt },
        { id: "ala_b", accountId: tied.account.id, agentId: null, event: "login", result: "rejected", reasonCode: "unauthorized", createdAt: tiedAt },
      ],
    });
    assert.deepEqual(
      listAccountLoginAudits(store, tied.account.id).map((audit) => audit.id),
      ["ala_b", "ala_a"],
    );

    await store.close();
    store = await createStore({ dataPath, debounceMs: 1 });
    assert.equal(listAccountLoginAudits(store, created.account.id, { limit: 200 }).length, 200);
  } finally {
    await store.close();
    await rm(dataPath, { recursive: true, force: true });
  }
});

test("Control Service audits attributable enroll, key login, Session reconnect, and logout outcomes", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-login-audit-control-"));
  const store = await createStore({ dataPath, debounceMs: 1 });
  const control = createControlService({
    store,
    config: { agentDaemon: { tokensPath: join(dataPath, "agent-tokens.json"), heartbeatIntervalMs: 15000 } },
  });
  try {
    const created = createUnownedAccount(store, { name: "Control Audit" });
    const enrollment = await control.enroll({
      accountId: created.account.id,
      agent: { name: "Owner" },
      runtimeProfile: profile,
    }, { authorization: `Bearer ${created.accessKey}` });

    assert.equal(await rejectedCode(control.enroll({
      accountId: created.account.id,
      agent: { name: "Duplicate" },
      runtimeProfile: profile,
    }, { authorization: `Bearer ${created.accessKey}` })), "account_busy");

    const agentHeaders = { authorization: `Bearer ${enrollment.agentToken}` };
    assert.equal(await rejectedCode(control.login(loginBody(created.account.id), {
      ...agentHeaders,
      "x-vera-account-key": "vak_invalid",
    })), "unauthorized");

    const keyLogin = await control.login(loginBody(created.account.id), {
      ...agentHeaders,
      "x-vera-account-key": created.accessKey,
    });
    const sessionHeaders = {
      ...agentHeaders,
      "x-vera-account-session": keyLogin.accountSession.token,
    };
    await control.login(loginBody(created.account.id), sessionHeaders);
    assert.equal(await rejectedCode(control.login(loginBody(created.account.id, "daemon-b"), sessionHeaders)), "account_reauthentication_required");

    const secretMarker = "vak_body_must-not-persist";
    assert.equal(await rejectedCode(control.login({
      ...loginBody(created.account.id),
      accountKey: secretMarker,
    }, { ...agentHeaders, "x-vera-account-key": created.accessKey })), "invalid_request");

    assert.equal(await rejectedCode(control.logout(created.account.id, agentHeaders)), "account_reauthentication_required");
    await control.logout(created.account.id, sessionHeaders);

    const audits = listAccountLoginAudits(store, created.account.id, { limit: 50 });
    const outcomes = audits.map(({ event, result, reasonCode }) => `${event}:${result}:${reasonCode}`);
    assert.deepEqual(outcomes.toSorted(), [
      "enroll:rejected:account_busy",
      "enroll:succeeded:null",
      "login:rejected:invalid_request",
      "login:rejected:unauthorized",
      "login:succeeded:null",
      "logout:rejected:account_reauthentication_required",
      "logout:succeeded:null",
      "reconnect:rejected:account_reauthentication_required",
      "reconnect:succeeded:null",
    ]);
    assert.equal(JSON.stringify(store.find("accounts", created.account.id).loginAudits).includes(secretMarker), false);
    assert.ok(audits.every((audit) => Object.keys(audit).length === 7));

    const beforeUnknown = audits.length;
    assert.equal(await rejectedCode(control.login(loginBody("acc_unknown"), {
      ...agentHeaders,
      "x-vera-account-key": created.accessKey,
    })), "not_found");
    assert.equal(listAccountLoginAudits(store, created.account.id, { limit: 50 }).length, beforeUnknown);
  } finally {
    await store.close();
    await rm(dataPath, { recursive: true, force: true });
  }
});
