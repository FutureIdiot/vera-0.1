import test from "node:test";
import assert from "node:assert/strict";

import { createRouter } from "../../src/api/router.js";
import { createMemoryDigestScheduler } from "../../src/memory/memory-digest-scheduler.js";
import { registerMemoryRoutes } from "../../src/memory/routes.js";

function createStoreFixture() {
  const data = {
    agents: [{ id: "agt_owner", name: "Owner" }, { id: "agt_other", name: "Other" }],
    accounts: [
      { id: "acc_owner", ownerAgentId: "agt_owner" },
      { id: "acc_other", ownerAgentId: "agt_other" },
      { id: "acc_unseen", ownerAgentId: "agt_owner" },
    ],
    spaces: [{ id: "spc_one", seats: [{ accountId: "acc_owner" }] }],
    spaceSessions: [{ id: "sps_one", spaceId: "spc_one", status: "active" }],
    agentSessions: [
      {
        id: "ags_owner",
        spaceSessionId: "sps_one",
        accountId: "acc_owner",
        agentId: "agt_owner",
        status: "active",
        generation: 3,
        context: {
          estimatedInputTokens: 3200,
          effectiveLimitTokens: 16384,
          pressureRatio: 0.195313,
          measurement: "provider_reported",
          privateCheckpoint: "must-not-project",
        },
        checkpoints: [{ secret: "must-not-project" }],
      },
      {
        id: "ags_future_pair",
        spaceSessionId: "sps_one",
        accountId: "acc_other",
        agentId: "agt_owner",
        status: "active",
        generation: 1,
        context: {
          estimatedInputTokens: 12,
          effectiveLimitTokens: 100,
          pressureRatio: 0.12,
          measurement: "estimate",
        },
      },
    ],
    messages: [
      { id: "msg_a", spaceId: "spc_one", spaceSessionId: "sps_one", status: "completed", content: "abc", _seq: 1 },
      { id: "msg_b", spaceId: "spc_one", spaceSessionId: "sps_one", status: "completed", content: "界", _seq: 2 },
    ],
    memoryDigestJobs: [],
  };
  return {
    data,
    list(name) { return data[name] ?? []; },
    find(name, id) { return (data[name] ?? []).find((item) => item.id === id) ?? null; },
  };
}

function request(router, method, url, body) {
  let status;
  let payload = "";
  const req = {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
  const res = {
    setHeader() {},
    writeHead(nextStatus) { status = nextStatus; },
    end(chunk = "") { payload += chunk; },
  };
  return router.handle(req, res).then(() => ({ status, json: payload ? JSON.parse(payload) : null }));
}

function createFixture() {
  const store = createStoreFixture();
  const enqueued = [];
  const digestService = {
    enqueueIncremental() {},
    enqueue(input) {
      enqueued.push(input);
      return { id: "mdj_manual", ...input, status: "queued" };
    },
    listJobs() { return []; },
  };
  const digestScheduler = createMemoryDigestScheduler({
    store,
    digestService,
    settingsStore: { getAll: () => ({ "memory.digestTrigger": "manual" }) },
  });
  const router = createRouter();
  registerMemoryRoutes(router, {
    store,
    digestService,
    digestScheduler,
    retrieval: {},
    configService: {
      getConfig(agentId) {
        return {
          config: {
            agentId,
            provider: { providerId: "vera.markdown", placement: { runtime: "gateway" }, config: {} },
          },
        };
      },
    },
    memory: {
      async listWithDiagnostics() {
        return {
          memories: [
            { slug: "active-a", status: "active" },
            { slug: "active-b", status: "active" },
            { slug: "archived-a", status: "archived" },
          ],
          errors: [],
          index: { generation: 1 },
        };
      },
    },
  });
  return { store, router, enqueued };
}

test("Memory status reports bounded context pressure and honest long-term totals without hooks", async () => {
  const { router } = createFixture();
  const response = await request(router, "GET", "/api/agents/agt_owner/memory/_status");
  assert.equal(response.status, 200);
  assert.equal("hooks" in response.json, false);
  assert.deepEqual(response.json.longTerm, {
    activeCount: 2,
    archivedCount: 1,
    logicalBytes: null,
    estimatedTokens: { estimator: "vera-utf8-v1", value: null },
  });
  assert.deepEqual(response.json.pendingContext.estimatedTokens, {
    estimator: "vera-utf8-v1",
    value: 2,
  });
  assert.equal(response.json.pendingContext.messageCount, 2);
  assert.equal(response.json.pendingContext.charCount, 4);
  assert.deepEqual(response.json.pendingContext.spaces.map((item) => item.accountId), ["acc_owner"]);
  assert.deepEqual(response.json.pendingContext.spaces[0], {
    accountId: "acc_owner",
    spaceId: "spc_one",
    spaceSessionId: "sps_one",
    messageCount: 2,
    charCount: 4,
    estimatedTokens: { estimator: "vera-utf8-v1", value: 2 },
    currentContext: {
      agentSessionId: "ags_owner",
      generation: 3,
      estimatedInputTokens: 3200,
      effectiveLimitTokens: 16384,
      pressureRatio: 0.195313,
      measurement: "provider_reported",
    },
  });
  assert.equal(JSON.stringify(response.json).includes("must-not-project"), false);
});

test("manual Digest accepts only a proven Account and SpaceSession visibility scope", async () => {
  const { router, enqueued } = createFixture();
  const validBody = {
    accountId: "acc_owner",
    spaceId: "spc_one",
    spaceSessionId: "sps_one",
    mode: "range",
    fromMessageId: "msg_a",
    toMessageId: "msg_b",
  };
  const accepted = await request(router, "POST", "/api/agents/agt_owner/memory/_digest", validBody);
  assert.equal(accepted.status, 202);
  assert.deepEqual(enqueued, [{
    agentId: "agt_owner",
    accountId: "acc_owner",
    trigger: "manual",
    spaceId: "spc_one",
    spaceSessionId: "sps_one",
    mode: "range",
    fromMessageId: "msg_a",
    toMessageId: "msg_b",
  }]);

  const forgedAccount = await request(router, "POST", "/api/agents/agt_owner/memory/_digest", {
    ...validBody, accountId: "acc_other",
  });
  assert.equal(forgedAccount.status, 400);
  assert.equal(forgedAccount.json.error.code, "invalid_request");

  const unseenAccount = await request(router, "POST", "/api/agents/agt_owner/memory/_digest", {
    ...validBody, accountId: "acc_unseen",
  });
  assert.equal(unseenAccount.status, 400);
  assert.equal(unseenAccount.json.error.code, "invalid_request");

  const crossedWindow = await request(router, "POST", "/api/agents/agt_owner/memory/_digest", {
    ...validBody, spaceId: "spc_other",
  });
  assert.equal(crossedWindow.status, 400);
  assert.equal(crossedWindow.json.error.code, "invalid_request");

  const unknownField = await request(router, "POST", "/api/agents/agt_owner/memory/_digest", {
    ...validBody, sources: [],
  });
  assert.equal(unknownField.status, 400);
  assert.equal(unknownField.json.error.code, "invalid_request");
  assert.equal(enqueued.length, 1);
});
