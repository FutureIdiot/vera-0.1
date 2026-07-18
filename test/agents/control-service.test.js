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
import { createEventHub } from "../../src/api/sse.js";
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

async function daemonFixture(fn) {
  const dataPath = await mkdtemp(join(tmpdir(), "vera-control-daemon-"));
  const tokensPath = join(dataPath, "agent-tokens.json");
  const store = await createStore({ dataPath, debounceMs: 1 });
  const hub = createEventHub({ bufferSize: 100 });
  const config = { agentDaemon: { tokensPath, heartbeatIntervalMs: 15000 } };
  const controlService = createControlService({ store, config, hub });
  const router = createRouter();
  registerAgentRoutes(router, { store, agentStates: { ensure() {}, list() { return []; } }, controlService });
  try {
    const created = createUnownedAccount(store, { name: "Daemon Account" });
    const enrolled = await request(router, "POST", "/api/agent/enroll", {
      accountId: created.account.id,
      agent: { name: "Daemon Agent" },
      runtimeProfile: profile,
    }, { authorization: `Bearer ${created.accessKey}` });
    const login = await request(router, "POST", "/api/agent/login", loginBody(created.account.id), {
      authorization: `Bearer ${enrolled.json.agentToken}`,
      "x-vera-account-key": created.accessKey,
    });
    await fn({ created, enrolled, login, store, hub, controlService, router });
  } finally {
    await store.close();
    await rm(dataPath, { recursive: true, force: true });
  }
}

function daemonRun(store, { id, accountId, agentId, accountSessionId, executionTransport = "daemon", status = "pending" }) {
  return store.insert("runs", {
    id,
    accountId,
    agentId,
    runtimeRevision: "sha256:runtime-a",
    delegated: false,
    status,
    executionTransport,
    accountSessionId,
    executionLeaseId: null,
    workspaceHostId: null,
    leaseAcquiredAt: null,
  });
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
    assert.match(keyLogin.json.accountSession.id, /^acs_[A-Za-z0-9]+$/u);
    assert.equal(keyLogin.json.accountSession.id.includes(sessionToken), false);
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
    assert.equal(reconnect.json.accountSession.id, keyLogin.json.accountSession.id);
    assert.equal(reconnect.json.accountSession.gatewayBootId, keyLogin.json.accountSession.gatewayBootId);

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
      executionTransport: "daemon",
      accountSessionId: keyLogin.json.accountSession.id,
      executionLeaseId: null,
      workspaceHostId: null,
      leaseAcquiredAt: null,
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
      accountSessionId: keyLogin.json.accountSession.id,
      executionLeaseId: store.find("runs", run.id).executionLeaseId,
      workspaceHostId: "host-a",
      runtimeRevision: "sha256:runtime-a",
    });
    assert.match(authorized.json.execution.executionLeaseId, /^exl_[A-Za-z0-9]+$/u);
    assert.equal(store.find("runs", run.id).status, "running");
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
    assert.equal(store.find("runs", run.id).status, "failed");

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
    store.insert("runs", {
      id: "run_rotation_pending",
      accountId,
      agentId: enrolled.json.agent.id,
      status: "pending",
    });
    const rotated = await request(router, "POST", `/api/accounts/${accountId}/access-key/rotate`);
    assert.equal(rotated.status, 200);
    assert.equal(rotated.headers["cache-control"], "no-store");
    assert.equal(store.find("runs", "run_rotation_pending").status, "failed");
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

test("daemon authorize claims one lease idempotently and rejects unsafe transports or Sessions", async () => {
  await daemonFixture(async ({ created, enrolled, login, store, router, hub, controlService }) => {
    const session = login.json.accountSession;
    const headers = {
      authorization: `Bearer ${enrolled.json.agentToken}`,
      "x-vera-account-session": session.token,
    };
    const events = [];
    const unsubscribe = hub.subscribe({
      write(frame) {
        const line = frame.split("\n").find((item) => item.startsWith("data: "));
        if (line) events.push(JSON.parse(line.slice("data: ".length)));
      },
    });
    try {
      const first = daemonRun(store, {
        id: "run_daemon_first",
        accountId: created.account.id,
        agentId: enrolled.json.agent.id,
        accountSessionId: session.id,
      });
      const claimed = await request(router, "POST", "/api/agent/workspace/authorize", {
        accountId: created.account.id,
        runId: first.id,
        workspaceHostId: "host-a",
        runtimeRevision: "sha256:runtime-a",
      }, headers);
      assert.equal(claimed.status, 200);
      assert.match(claimed.json.execution.executionLeaseId, /^exl_[A-Za-z0-9]+$/u);
      assert.equal(store.find("runs", first.id).status, "running");
      assert.equal(events.filter((event) => event.type === "run.started").length, 1);

      const retried = await request(router, "POST", "/api/agent/workspace/authorize", {
        accountId: created.account.id,
        runId: first.id,
        workspaceHostId: "host-a",
        runtimeRevision: "sha256:runtime-a",
      }, headers);
      assert.deepEqual(retried.json, claimed.json);
      assert.equal(events.filter((event) => event.type === "run.started").length, 1);

      const queued = daemonRun(store, {
        id: "run_daemon_queued",
        accountId: created.account.id,
        agentId: enrolled.json.agent.id,
        accountSessionId: session.id,
      });
      const busy = await request(router, "POST", "/api/agent/workspace/authorize", {
        accountId: created.account.id,
        runId: queued.id,
        workspaceHostId: "host-a",
        runtimeRevision: "sha256:runtime-a",
      }, headers);
      assert.equal(busy.status, 409);
      assert.equal(busy.json.error.code, "account_busy");
      assert.equal(store.find("runs", queued.id).status, "pending");

      store.update("runs", first.id, { status: "completed" });
      const queuedClaim = await request(router, "POST", "/api/agent/workspace/authorize", {
        accountId: created.account.id,
        runId: queued.id,
        workspaceHostId: "host-a",
        runtimeRevision: "sha256:runtime-a",
      }, headers);
      assert.equal(queuedClaim.status, 200);

      const terminal = daemonRun(store, {
        id: "run_terminal",
        accountId: created.account.id,
        agentId: enrolled.json.agent.id,
        accountSessionId: session.id,
        status: "completed",
      });
      const terminalResult = await request(router, "POST", "/api/agent/workspace/authorize", {
        accountId: created.account.id,
        runId: terminal.id,
        workspaceHostId: "host-a",
        runtimeRevision: "sha256:runtime-a",
      }, headers);
      assert.equal(terminalResult.status, 409);
      assert.equal(terminalResult.json.error.code, "conflict");

      const local = daemonRun(store, {
        id: "run_gateway_local",
        accountId: created.account.id,
        agentId: enrolled.json.agent.id,
        accountSessionId: session.id,
        executionTransport: "gateway-local",
      });
      const localResult = await request(router, "POST", "/api/agent/workspace/authorize", {
        accountId: created.account.id,
        runId: local.id,
        workspaceHostId: "host-a",
        runtimeRevision: "sha256:runtime-a",
      }, headers);
      assert.equal(localResult.status, 409);
      assert.equal(localResult.json.error.code, "conflict");

      const sessionIdOnly = await controlService.authenticateAccountSession(
        { accountId: created.account.id },
        { authorization: headers.authorization, "x-vera-account-session": session.id },
      ).then(() => null, (error) => error);
      assert.equal(sessionIdOnly.code, "account_reauthentication_required");

      const authenticated = await controlService.authenticateAccountSession(
        { accountId: created.account.id },
        headers,
      );
      assert.equal(authenticated.session.id, session.id);
      assert.equal("tokenHash" in authenticated.session, false);
      assert.equal("identity" in authenticated, false);

      await request(router, "DELETE", `/api/agent/sessions/${created.account.id}`, undefined, headers);
      const relogin = await request(router, "POST", "/api/agent/login", loginBody(created.account.id), {
        authorization: `Bearer ${enrolled.json.agentToken}`,
        "x-vera-account-key": created.accessKey,
      });
      const oldSessionRun = daemonRun(store, {
        id: "run_old_session",
        accountId: created.account.id,
        agentId: enrolled.json.agent.id,
        accountSessionId: session.id,
      });
      const staleToken = await request(router, "POST", "/api/agent/workspace/authorize", {
        accountId: created.account.id,
        runId: oldSessionRun.id,
        workspaceHostId: "host-a",
        runtimeRevision: "sha256:runtime-a",
      }, {
        authorization: `Bearer ${enrolled.json.agentToken}`,
        "x-vera-account-session": session.token,
      });
      assert.equal(staleToken.status, 401);
      assert.equal(staleToken.json.error.code, "account_reauthentication_required");
      const oldSession = await request(router, "POST", "/api/agent/workspace/authorize", {
        accountId: created.account.id,
        runId: oldSessionRun.id,
        workspaceHostId: "host-a",
        runtimeRevision: "sha256:runtime-a",
      }, {
        authorization: `Bearer ${enrolled.json.agentToken}`,
        "x-vera-account-session": relogin.json.accountSession.token,
      });
      assert.equal(oldSession.status, 403);
      assert.equal(oldSession.json.error.code, "forbidden");
    } finally {
      unsubscribe();
    }
  });
});

test("concurrent daemon authorize requests serialize to one lease", async () => {
  await daemonFixture(async ({ created, enrolled, login, store, router, hub }) => {
    const session = login.json.accountSession;
    const first = daemonRun(store, {
      id: "run_concurrent_a",
      accountId: created.account.id,
      agentId: enrolled.json.agent.id,
      accountSessionId: session.id,
    });
    const second = daemonRun(store, {
      id: "run_concurrent_b",
      accountId: created.account.id,
      agentId: enrolled.json.agent.id,
      accountSessionId: session.id,
    });
    const headers = {
      authorization: `Bearer ${enrolled.json.agentToken}`,
      "x-vera-account-session": session.token,
    };
    const body = (runId) => ({
      accountId: created.account.id,
      runId,
      workspaceHostId: "host-a",
      runtimeRevision: "sha256:runtime-a",
    });
    const results = await Promise.all([
      request(router, "POST", "/api/agent/workspace/authorize", body(first.id), headers),
      request(router, "POST", "/api/agent/workspace/authorize", body(second.id), headers),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    assert.equal(store.list("runs").filter((run) => run.status === "running").length, 1);
    assert.equal(hub.currentSeq(), 1);
  });
});
