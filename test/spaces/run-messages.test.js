import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventHub } from "../../src/api/sse.js";
import { createRunMessageService } from "../../src/spaces/run-messages.js";
import { createStore } from "../../src/store/store.js";

const CONFIG = {
  agentCommunication: {
    maxDepth: 4,
    maxChildrenPerRun: 8,
    maxMessagesPerRoot: 128,
    maxContentChars: 12000,
    maxSourceMessageIds: 16,
    maxEvidenceChars: 16000,
    deliveryTimeoutMs: 300000,
    idempotencyRetentionMs: 86400000,
  },
};

function agent(id) {
  return {
    id,
    name: id,
    runtimeProfile: { schemaVersion: 1, kind: "cli", provider: "codex", model: "model-a" },
    runtimeBinding: { runtimeSnapshot: { runtimeCapabilities: { models: ["model-a"] } } },
    runtimeRevision: `sha256:${id}`,
  };
}

function account(id, agentId) {
  return {
    id,
    name: id,
    ownerAgentId: agentId,
    activeAgentId: agentId,
    presence: "online",
    model: "model-a",
    modelVersion: 1,
    workspace: { hostId: `host-${id}`, path: `/srv/${id}`, status: "ready", policy: {} },
  };
}

test("delegate freezes an isolated cross-Agent Child and returns its result only to the parent inbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "vera-run-messages-"));
  const store = await createStore({ dataPath: root, debounceMs: 1 });
  const hub = createEventHub({ bufferSize: 100 });
  try {
    const agentA = store.insert("agents", agent("agt_a"));
    const agentB = store.insert("agents", agent("agt_b"));
    const agentC = store.insert("agents", agent("agt_c"));
    const accountA = store.insert("accounts", account("acc_a", agentA.id));
    const accountB = store.insert("accounts", account("acc_b", agentB.id));
    const accountC = store.insert("accounts", account("acc_c", agentC.id));
    store.insert("groups", {
      id: "grp_one", name: "Group", accountIds: [accountA.id, accountB.id],
    });
    store.insert("spaces", {
      id: "spc_group",
      groupId: "grp_one",
      spaceType: "chat",
      archivedAt: null,
      seats: [
        { accountId: accountA.id, responseMode: "default" },
        { accountId: accountB.id, responseMode: "default" },
      ],
    });
    const source = store.insert("messages", {
      id: "msg_source",
      spaceId: "spc_group",
      spaceSessionId: "sps_group",
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "Only this evidence is allowed",
      fileIds: ["fil_must_not_cross"],
      runId: null,
      status: "completed",
      createdAt: "2026-07-29T00:00:00.000Z",
    });
    store.insert("runs", {
      id: "run_root",
      rootRunId: "run_root",
      parentRunId: null,
      role: "root",
      depth: 0,
      outputPolicy: "space",
      agentId: agentA.id,
      accountId: accountA.id,
      spaceId: "spc_group",
      spaceSessionId: "sps_group",
      triggerMessageId: source.id,
      status: "running",
      createdAt: "2026-07-29T00:00:00.000Z",
    });
    const sessions = new Map([
      [accountA.id, { id: "acs_a", agentId: agentA.id }],
      [accountB.id, { id: "acs_b", agentId: agentB.id }],
      [accountC.id, { id: "acs_c", agentId: agentC.id }],
    ]);
    const scheduled = [];
    const notifications = [];
    const service = createRunMessageService({
      store,
      hub,
      config: CONFIG,
      controlService: { getSession: (accountId) => sessions.get(accountId) ?? null },
      scheduleChildRun(input) { scheduled.push(input); },
      notifyRunMessage(runId, sequence) { notifications.push({ runId, sequence }); },
    });

    assert.deepEqual(service.delegationTargets(store.find("runs", "run_root")), [
      {
        agentId: agentB.id,
        accountId: accountB.id,
        name: accountB.name,
      },
      {
        agentId: agentC.id,
        accountId: accountC.id,
        name: accountC.name,
      },
    ]);
    const first = service.createDelegate("run_root", {
      kind: "delegate",
      recipientAgentId: agentC.id,
      content: "Inspect the boundary",
      sourceMessageIds: [source.id],
      idempotencyKey: "tool-call-1",
    });
    const repeated = service.createDelegate("run_root", {
      kind: "delegate",
      recipientAgentId: agentC.id,
      content: "This retry body is ignored",
      sourceMessageIds: [],
      idempotencyKey: "tool-call-1",
    });
    assert.equal(repeated.run.id, first.run.id);
    assert.equal(store.list("runs").filter((run) => run.role === "child").length, 1);
    assert.equal(store.list("runMessages").length, 1);
    assert.equal(scheduled.length, 1);
    assert.deepEqual(scheduled[0].delegatePacket, {
      instruction: "Inspect the boundary",
      sourceRunId: "run_root",
      evidence: [{
        sourceMessageId: source.id,
        authorSnapshot: { type: "user", name: "User" },
        content: source.content,
      }],
    });
    assert.equal(JSON.stringify(scheduled[0].delegatePacket).includes("fil_must_not_cross"), false);
    assert.equal(first.run.agentSessionId, null);
    assert.equal(first.run.contextGeneration, null);
    assert.equal(first.run.outputPolicy, "source");
    assert.equal(first.run.accountId, accountC.id);

    store.update("runs", first.run.id, { status: "running" });
    store.insert("runs", {
      ...structuredClone(store.find("runs", "run_root")),
      id: "run_root_b",
      rootRunId: "run_root_b",
      parentRunId: null,
      agentId: agentC.id,
      accountId: accountC.id,
      triggerMessageId: "msg_other",
    });
    assert.throws(
      () => service.createDelegate("run_root_b", {
        kind: "delegate",
        recipientAgentId: agentA.id,
        content: "Do not deadlock both Accounts",
        sourceMessageIds: [],
        idempotencyKey: "cycle",
      }),
      (error) => error.code === "account_busy",
    );
    service.completeSourceRun(first.run.id, {
      status: "completed",
      content: "Boundary is intact.",
    });
    assert.deepEqual(notifications, [{ runId: "run_root", sequence: 2 }]);
    const inbox = service.inbox("run_root", 0);
    assert.equal(inbox.runMessages.length, 1);
    assert.equal(inbox.runMessages[0].kind, "result");
    assert.equal(inbox.runMessages[0].content, "Boundary is intact.");
    assert.equal(store.list("messages").length, 1, "Child output never becomes a public Message");
    assert.equal(store.list("activities").length, 0);
    const consumed = service.consume("run_root", inbox.runMessages[0].id);
    assert.equal(consumed.deliveryState, "consumed");
    store.insert("runs", {
      ...structuredClone(store.find("runs", "run_root_b")),
      id: "run_root_b_same_trigger",
      rootRunId: "run_root_b_same_trigger",
      agentId: agentB.id,
      accountId: accountB.id,
      triggerMessageId: source.id,
    });
    const siblingOutput = store.insert("messages", {
      id: "msg_sibling_output",
      spaceId: "spc_group",
      spaceSessionId: "sps_group",
      author: { type: "account", accountId: accountA.id },
      target: { type: "broadcast" },
      content: "Both Accounts are already answering the same User turn",
      fileIds: [],
      runId: "run_root",
      status: "completed",
      createdAt: "2026-07-29T00:00:02.000Z",
    });
    assert.deepEqual(service.routeAccountMessage(siblingOutput), []);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
