import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventHub } from "../../src/api/sse.js";
import { createStore } from "../../src/store/store.js";
import { ensureActiveSpaceSession, ensureAgentSession } from "../../src/spaces/context-sessions.js";
import { createContextForgeService } from "../../src/spaces/context-forges.js";
import { compileForgeCapsule, emptyForgeCapsule } from "../../src/spaces/forge-capsule.js";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "vera-forge-test-"));
  const store = await createStore({ dataPath: join(root, "data"), debounceMs: 1 });
  const hub = createEventHub({ bufferSize: 100 });
  const agent = store.insert("agents", {
    id: "agt_forge",
    name: "Forge",
    runtimeProfile: { schemaVersion: 1, kind: "cli", provider: "codex", model: "gpt-test" },
    runtimeBinding: { connection: {} },
    runtimeRevision: "rev-forge",
  });
  const account = store.insert("accounts", {
    id: "acc_forge",
    name: "Forge",
    ownerAgentId: agent.id,
    activeAgentId: agent.id,
    presence: "online",
    model: "gpt-test",
    modelVersion: 1,
  });
  const space = store.insert("spaces", {
    id: "spc_forge",
    name: "Forge",
    seats: [{ accountId: account.id, responseMode: "default" }],
    createdAt: "2026-07-30T00:00:00.000Z",
  });
  const spaceSession = ensureActiveSpaceSession(store, space.id);
  ensureAgentSession(store, {
    spaceSessionId: spaceSession.id,
    accountId: account.id,
    agentId: agent.id,
  });
  try {
    await run({ store, hub, agent, account, space, spaceSession });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForDraft(service, id, status) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const draft = service.getDraft(id);
    if (draft.status === status) return draft;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Forge draft did not reach ${status}`);
}

test("Forge keeps only completed Messages, accepts manual edits, and seeds a fresh AgentSession", async () => {
  await fixture(async ({ store, hub, agent, account, space, spaceSession }) => {
    store.insert("messages", {
      id: "msg_user",
      spaceId: space.id,
      spaceSessionId: spaceSession.id,
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "保留这个目标",
      fileIds: [],
      runId: null,
      status: "completed",
      createdAt: "2026-07-30T00:00:01.000Z",
    });
    store.insert("messages", {
      id: "msg_streaming",
      spaceId: space.id,
      spaceSessionId: spaceSession.id,
      author: { type: "account", accountId: account.id },
      target: { type: "broadcast" },
      content: "未完成输出",
      fileIds: [],
      runId: "run_streaming",
      status: "streaming",
      createdAt: "2026-07-30T00:00:02.000Z",
    });
    store.insert("activities", {
      id: "act_tool",
      spaceId: space.id,
      spaceSessionId: spaceSession.id,
      runId: "run_streaming",
      accountId: account.id,
      agentId: agent.id,
      phase: "completed",
      kind: "tool",
      summary: "工具输出不得进入",
      createdAt: "2026-07-30T00:00:03.000Z",
      updatedAt: "2026-07-30T00:00:03.000Z",
    });
    let service;
    let dispatched;
    service = createContextForgeService({
      store,
      hub,
      config: {
        context: {
          forgeSourceMaxChars: 10000,
          forgeChunkChars: 6000,
          forgeCapsuleMaxChars: 6000,
          forgeTaskTimeoutMs: 1000,
        },
      },
      dispatchDaemonForge(request) {
        dispatched = request;
        if (request.event.type !== "context-forge.requested") return;
        setImmediate(() => service.submitDaemonResult({
          draftId: request.event.data.draftId,
          agentId: agent.id,
          accountId: account.id,
          input: {
            status: "succeeded",
            content: emptyForgeCapsule().replace("暂无", "自动目标"),
            execution: { runtimeRevision: agent.runtimeRevision, model: account.model, fallbackUsed: false },
          },
        }));
      },
    });

    const created = service.createDraft({ spaceId: space.id, requestId: "forge-create" });
    const ready = await waitForDraft(service, created.id, "ready");
    assert.equal(dispatched.event.type, "context-forge.requested");
    assert.deepEqual(dispatched.event.data.source.messages.map((message) => message.messageId), ["msg_user"]);
    assert.equal(JSON.stringify(dispatched).includes("工具输出不得进入"), false);
    assert.deepEqual(ready.targets[0].sourceMessageIds, ["msg_user"]);

    const edited = service.updateDraft({
      draftId: ready.id,
      ifVersion: ready.version,
      targets: [{ accountId: account.id, content: "用户手工整理后的唯一上下文" }],
    });
    assert.equal(edited.version, 2);
    const result = service.confirmDraft({
      draftId: edited.id,
      requestId: "forge-confirm",
      ifVersion: edited.version,
    });
    assert.equal(result.archivedSession.id, spaceSession.id);
    assert.equal(result.archivedSession.status, "archived");
    assert.equal(result.newSession.status, "active");
    assert.equal(result.draft.status, "confirmed");
    const nextAgentSession = store.list("agentSessions").find((session) =>
      session.spaceSessionId === result.newSession.id);
    assert.equal(nextAgentSession.generation, 1);
    assert.equal(nextAgentSession.checkpoints[0].kind, "forge");
    assert.equal(nextAgentSession.checkpoints[0].checkpoint.summary, "用户手工整理后的唯一上下文");
    assert.deepEqual(nextAgentSession.checkpoints[0].checkpoint.sourceMessageIds, ["msg_user"]);
    assert.equal(store.list("providerBindings").some((binding) =>
      binding.agentSessionId === nextAgentSession.id), false);
    assert.equal(store.list("apiHistories").some((history) =>
      history.agentSessionId === nextAgentSession.id), false);
  });
});

test("Forge confirmation becomes stale when a completed Message arrives after the frozen boundary", async () => {
  await fixture(async ({ store, hub, agent, account, space, spaceSession }) => {
    store.insert("messages", {
      id: "msg_before",
      spaceId: space.id,
      spaceSessionId: spaceSession.id,
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "before",
      fileIds: [],
      runId: null,
      status: "completed",
      createdAt: "2026-07-30T00:00:01.000Z",
    });
    let service;
    service = createContextForgeService({
      store,
      hub,
      config: {
        context: {
          forgeSourceMaxChars: 10000,
          forgeChunkChars: 6000,
          forgeCapsuleMaxChars: 6000,
          forgeTaskTimeoutMs: 1000,
        },
      },
      dispatchDaemonForge(request) {
        setImmediate(() => service.submitDaemonResult({
          draftId: request.event.data.draftId,
          agentId: agent.id,
          accountId: account.id,
          input: {
            status: "succeeded",
            content: emptyForgeCapsule(),
            execution: { runtimeRevision: agent.runtimeRevision, model: account.model, fallbackUsed: false },
          },
        }));
      },
    });
    const draft = await waitForDraft(
      service,
      service.createDraft({ spaceId: space.id, requestId: "stale-create" }).id,
      "ready",
    );
    store.insert("messages", {
      id: "msg_after",
      spaceId: space.id,
      spaceSessionId: spaceSession.id,
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "after",
      fileIds: [],
      runId: null,
      status: "completed",
      createdAt: "2026-07-30T00:00:02.000Z",
    });
    assert.throws(() => service.confirmDraft({
      draftId: draft.id,
      requestId: "stale-confirm",
      ifVersion: draft.version,
    }), (error) => error.code === "history_conflict");
    assert.equal(service.getDraft(draft.id).status, "stale");
    assert.equal(store.find("spaceSessions", spaceSession.id).status, "active");
  });
});

test("Forge rejects an invalid generated Capsule as a terminal target failure", async () => {
  await fixture(async ({ store, hub, agent, account, space, spaceSession }) => {
    store.insert("messages", {
      id: "msg_invalid_capsule",
      spaceId: space.id,
      spaceSessionId: spaceSession.id,
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "需要被提炼的内容",
      fileIds: [],
      runId: null,
      status: "completed",
      createdAt: "2026-07-30T00:00:01.000Z",
    });
    let service;
    service = createContextForgeService({
      store,
      hub,
      config: {
        context: {
          forgeSourceMaxChars: 10000,
          forgeChunkChars: 6000,
          forgeCapsuleMaxChars: 6000,
          forgeTaskTimeoutMs: 1000,
        },
      },
      dispatchDaemonForge(request) {
        setImmediate(() => service.submitDaemonResult({
          draftId: request.event.data.draftId,
          agentId: agent.id,
          accountId: account.id,
          input: {
            status: "succeeded",
            content: "missing required Forge headings",
            execution: { runtimeRevision: agent.runtimeRevision, model: account.model, fallbackUsed: false },
          },
        }));
      },
    });
    const created = service.createDraft({ spaceId: space.id, requestId: "invalid-capsule" });
    const failed = await waitForDraft(service, created.id, "failed");
    assert.equal(failed.targets[0].status, "failed");
    assert.deepEqual(failed.targets[0].error, {
      code: "forge_failed",
      message: "Forge context generation failed",
    });
  });
});

test("Forge Capsule compiler hierarchically merges bounded outputs", async () => {
  const calls = [];
  const content = await compileForgeCapsule({
    messages: Array.from({ length: 8 }, (_, index) => ({
      messageId: `msg_${index}`,
      author: { type: "user", name: "User" },
      target: { type: "broadcast" },
      content: `decision-${index}-${"x".repeat(500)}`,
      fileIds: [],
      createdAt: null,
    })),
    maxChunkChars: 3000,
    maxCapsuleChars: 3000,
    generate: async (prompt) => {
      calls.push(prompt);
      return emptyForgeCapsule().replace("暂无", `提炼-${calls.length}`);
    },
  });
  assert.match(content, /## 目标/u);
  assert.ok(calls.length > 1);
});
