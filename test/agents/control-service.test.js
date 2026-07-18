import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRouter } from "../../src/api/router.js";
import { registerAgentRoutes } from "../../src/agents/routes.js";
import { createUnownedAccount } from "../../src/agents/accounts.js";
import { createControlService } from "../../src/agents/control-service.js";
import { agentTokenFingerprint } from "../../src/agents/credentials.js";
import { createStore } from "../../src/store/store.js";

const profile = { schemaVersion: 1, kind: "cli", provider: "mock", model: "mock-v1" };

function request(router, method, url, body, headers = {}) {
  let status;
  let payload = "";
  const responseHeaders = {};
  const req = {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
  const res = {
    setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; },
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus;
      for (const [name, value] of Object.entries(nextHeaders)) responseHeaders[name.toLowerCase()] = value;
    },
    end(chunk = "") { payload += chunk; },
  };
  return router.handle(req, res).then((handled) => ({
    handled,
    status,
    headers: responseHeaders,
    json: payload ? JSON.parse(payload) : null,
  }));
}

function loginBody(accountId, daemonBootId = "daemon-a", hostId = "host-a", revision = "sha256:runtime-a") {
  return {
    accountId,
    daemonBootId,
    runtime: {
      hostId,
      kind: "cli",
      provider: "mock",
      model: "mock-v1",
      revision,
      runtimeCapabilities: { tools: [] },
    },
    workspace: {
      hostId,
      path: "/srv/vera/project-a",
      status: "ready",
      policy: { allow: ["read"] },
    },
  };
}

test("Control Service closes the owner credential, Workspace, Session, and Execution loop", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-control-service-"));
  const tokensPath = join(dataPath, "agent-tokens.json");
  const store = await createStore({ dataPath, debounceMs: 1 });
  const config = { agentDaemon: { tokensPath, heartbeatIntervalMs: 15000 } };
  const configuredAgents = [];
  const controlService = createControlService({
    store,
    config,
    memoryConfigService: { ensureAgentConfig(agentId) { configuredAgents.push(agentId); } },
  });
  const router = createRouter();
  registerAgentRoutes(router, {
    store,
    agentStates: { ensure() {}, list() { return []; } },
    controlService,
  });

  try {
    const created = createUnownedAccount(store, { name: "Control" });
    const enrolled = await request(router, "POST", "/api/agent/enroll", {
      accountId: created.account.id,
      agent: { name: "Owner" },
      runtimeProfile: profile,
    }, { authorization: `Bearer ${created.accessKey}` });
    assert.equal(enrolled.status, 201);
    assert.equal(enrolled.headers["cache-control"], "no-store");
    assert.match(enrolled.json.agentToken, /^vat_[A-Za-z0-9_-]{43}$/u);
    assert.deepEqual(JSON.parse(await readFile(tokensPath, "utf8"))[enrolled.json.agent.id], agentTokenFingerprint(enrolled.json.agentToken));
    assert.equal((await readFile(tokensPath, "utf8")).includes(enrolled.json.agentToken), false);
    assert.deepEqual(configuredAgents, [enrolled.json.agent.id]);
    assert.equal(store.list("unitBindings").filter((binding) => binding.agentId === enrolled.json.agent.id).length, 3);
    assert.equal("accessKeyHash" in enrolled.json.account, false);
    assert.equal(enrolled.json.account.workspace, null);

    const agentToken = enrolled.json.agentToken;
    const accountId = created.account.id;
    const keyLogin = await request(router, "POST", "/api/agent/login", loginBody(accountId), {
      authorization: `Bearer ${agentToken}`,
      "x-vera-account-key": created.accessKey,
    });
    assert.equal(keyLogin.status, 200);
    assert.equal(keyLogin.headers["cache-control"], "no-store");
    const sessionToken = keyLogin.json.accountSession.token;
    assert.match(sessionToken, /^vas_[A-Za-z0-9_-]{43}$/u);
    assert.equal("path" in keyLogin.json.workspace, false);
    assert.equal("policy" in keyLogin.json.workspace, false);
    assert.equal("path" in keyLogin.json.account.workspace, false);
    assert.equal("policy" in keyLogin.json.account.workspace, false);
    assert.equal(store.find("accounts", accountId).workspace.path, "/srv/vera/project-a");

    const agentBeforeMismatch = structuredClone(store.find("agents", enrolled.json.agent.id));
    const accountBeforeMismatch = structuredClone(store.find("accounts", accountId));
    const badLoginBody = loginBody(accountId, "daemon-a", "host-a", "sha256:runtime-b");
    badLoginBody.workspace.path = "/srv/other-project";
    const failedReconnect = await request(router, "POST", "/api/agent/login", badLoginBody, {
      authorization: `Bearer ${agentToken}`,
      "x-vera-account-session": sessionToken,
    });
    assert.equal(failedReconnect.status, 409);
    assert.equal(failedReconnect.json.error.code, "workspace_unavailable");
    assert.deepEqual(store.find("agents", enrolled.json.agent.id), agentBeforeMismatch);
    assert.deepEqual(store.find("accounts", accountId), accountBeforeMismatch);

    const reconnect = await request(router, "POST", "/api/agent/login", loginBody(accountId), {
      authorization: `Bearer ${agentToken}`,
      "x-vera-account-session": sessionToken,
    });
    assert.equal(reconnect.status, 200);
    assert.equal("token" in reconnect.json.accountSession, false);

    const wrongDaemonBoot = await request(router, "POST", "/api/agent/login", loginBody(accountId, "daemon-b"), {
      authorization: `Bearer ${agentToken}`,
      "x-vera-account-session": sessionToken,
    });
    assert.equal(wrongDaemonBoot.status, 401);
    assert.equal(wrongDaemonBoot.json.error.code, "account_reauthentication_required");

    const registered = await request(router, "POST", "/api/agent/workspace/register", {
      accountId,
      daemonBootId: "daemon-a",
      runtimeRevision: "sha256:runtime-a",
      workspace: {
        hostId: "host-a",
        path: "/srv/vera/project-a",
        status: "ready",
        policy: { allow: ["write"] },
      },
    }, {
      authorization: `Bearer ${agentToken}`,
      "x-vera-account-session": sessionToken,
    });
    assert.equal(registered.status, 200);
    assert.equal("path" in registered.json.workspace, false);

    const run = store.insert("runs", {
      id: "run_control",
      accountId,
      agentId: enrolled.json.agent.id,
      runtimeRevision: "sha256:runtime-a",
      delegated: false,
      status: "pending",
    });
    const authorized = await request(router, "POST", "/api/agent/workspace/authorize", {
      accountId,
      runId: run.id,
      workspaceHostId: "host-a",
      runtimeRevision: "sha256:runtime-a",
    }, {
      authorization: `Bearer ${agentToken}`,
      "x-vera-account-session": sessionToken,
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(authorized.json.execution, {
      runId: run.id,
      accountId,
      agentId: enrolled.json.agent.id,
      workspaceHostId: "host-a",
      runtimeRevision: "sha256:runtime-a",
    });
    assert.equal(JSON.stringify(authorized.json).includes("/srv/vera/project-a"), false);

    const keyOnSessionEndpoint = await request(router, "POST", "/api/agent/workspace/authorize", {
      accountId,
      runId: run.id,
      workspaceHostId: "host-a",
      runtimeRevision: "sha256:runtime-a",
    }, {
      authorization: `Bearer ${agentToken}`,
      "x-vera-account-session": sessionToken,
      "x-vera-account-key": created.accessKey,
    });
    assert.equal(keyOnSessionEndpoint.status, 400);
    assert.equal(keyOnSessionEndpoint.json.error.code, "invalid_request");

    const missingSession = await request(router, "POST", "/api/agent/workspace/register", {
      accountId,
      daemonBootId: "daemon-a",
      runtimeRevision: "sha256:runtime-a",
      workspace: { hostId: "host-a", path: "/srv/vera/project-a", status: "ready", policy: {} },
    }, { authorization: `Bearer ${agentToken}` });
    assert.equal(missingSession.status, 401);
    assert.equal(missingSession.json.error.code, "account_reauthentication_required");

    const mismatch = await request(router, "POST", "/api/agent/workspace/register", {
      accountId,
      daemonBootId: "daemon-a",
      runtimeRevision: "sha256:runtime-a",
      workspace: { hostId: "host-b", path: "/srv/other", status: "ready", policy: {} },
    }, {
      authorization: `Bearer ${agentToken}`,
      "x-vera-account-session": sessionToken,
    });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.json.error.code, "workspace_unavailable");

    const logout = await request(router, "DELETE", `/api/agent/sessions/${accountId}`, undefined, {
      authorization: `Bearer ${agentToken}`,
      "x-vera-account-session": sessionToken,
    });
    assert.equal(logout.status, 204);
    assert.equal(store.find("accounts", accountId).presence, "offline");

    const oldSession = await request(router, "POST", "/api/agent/login", loginBody(accountId), {
      authorization: `Bearer ${agentToken}`,
      "x-vera-account-session": sessionToken,
    });
    assert.equal(oldSession.status, 401);
    assert.equal(oldSession.json.error.code, "account_reauthentication_required");

    const relogin = await request(router, "POST", "/api/agent/login", loginBody(accountId), {
      authorization: `Bearer ${agentToken}`,
      "x-vera-account-key": created.accessKey,
    });
    assert.equal(relogin.status, 200);
    const preRotationSession = relogin.json.accountSession.token;
    const rotated = await request(router, "POST", `/api/accounts/${accountId}/access-key/rotate`);
    assert.equal(rotated.status, 200);
    assert.equal(rotated.headers["cache-control"], "no-store");
    const invalidatedByRotation = await request(router, "POST", "/api/agent/login", loginBody(accountId), {
      authorization: `Bearer ${agentToken}`,
      "x-vera-account-session": preRotationSession,
    });
    assert.equal(invalidatedByRotation.status, 401);
    assert.equal(invalidatedByRotation.json.error.code, "account_reauthentication_required");

    const postRotationLogin = await request(router, "POST", "/api/agent/login", loginBody(accountId), {
      authorization: `Bearer ${agentToken}`,
      "x-vera-account-key": rotated.json.accessKey,
    });
    assert.equal(postRotationLogin.status, 200);
    const preGatewayRestartSession = postRotationLogin.json.accountSession.token;

    const restartedControlService = createControlService({ store, config });
    const restartedRouter = createRouter();
    registerAgentRoutes(restartedRouter, {
      store,
      agentStates: { ensure() {}, list() { return []; } },
      controlService: restartedControlService,
    });
    const invalidatedByGatewayBoot = await request(
      restartedRouter,
      "POST",
      "/api/agent/login",
      loginBody(accountId),
      {
        authorization: `Bearer ${agentToken}`,
        "x-vera-account-session": preGatewayRestartSession,
      },
    );
    assert.equal(invalidatedByGatewayBoot.status, 401);
    assert.equal(invalidatedByGatewayBoot.json.error.code, "account_reauthentication_required");

    const persistedTokens = await readFile(tokensPath, "utf8");
    assert.equal(persistedTokens.includes(sessionToken), false);
    assert.equal(persistedTokens.includes(created.accessKey), false);
  } finally {
    await store.close();
    await rm(dataPath, { recursive: true, force: true });
  }
});

test("Control Service keeps non-owner access closed and refuses duplicate owner login", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-control-owner-"));
  const store = await createStore({ dataPath, debounceMs: 1 });
  const controlService = createControlService({
    store,
    config: { agentDaemon: { tokensPath: join(dataPath, "tokens.json"), heartbeatIntervalMs: 15000 } },
  });
  const router = createRouter();
  registerAgentRoutes(router, { store, agentStates: { ensure() {}, list() { return []; } }, controlService });
  try {
    const first = createUnownedAccount(store, { name: "First" });
    const second = createUnownedAccount(store, { name: "Second" });
    const firstEnroll = await request(router, "POST", "/api/agent/enroll", {
      accountId: first.account.id, agent: { name: "First Agent" }, runtimeProfile: profile,
    }, { authorization: `Bearer ${first.accessKey}` });
    const secondEnroll = await request(router, "POST", "/api/agent/enroll", {
      accountId: second.account.id, agent: { name: "Second Agent" }, runtimeProfile: profile,
    }, { authorization: `Bearer ${second.accessKey}` });
    const body = loginBody(first.account.id);
    const ownerLogin = await request(router, "POST", "/api/agent/login", body, {
      authorization: `Bearer ${firstEnroll.json.agentToken}`,
      "x-vera-account-key": first.accessKey,
    });
    assert.equal(ownerLogin.status, 200);
    const duplicate = await request(router, "POST", "/api/agent/login", { ...body, daemonBootId: "daemon-b" }, {
      authorization: `Bearer ${firstEnroll.json.agentToken}`,
      "x-vera-account-key": first.accessKey,
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.error.code, "account_busy");
    const nonOwner = await request(router, "POST", "/api/agent/login", body, {
      authorization: `Bearer ${secondEnroll.json.agentToken}`,
      "x-vera-account-key": first.accessKey,
    });
    assert.equal(nonOwner.status, 403);
    assert.equal(nonOwner.json.error.code, "delegation_unavailable");
  } finally {
    await store.close();
    await rm(dataPath, { recursive: true, force: true });
  }
});
