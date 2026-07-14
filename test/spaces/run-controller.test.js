// 常驻索引注入行为（api-contract.md「常驻索引注入」）：外部会话首条消息头部
// 注入 residentIndex() 的块；已有 sessionState 的后续消息不重复注入。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../src/store/store.js";
import { createEventHub } from "../../src/api/sse.js";
import { createMemoryVault } from "../../src/memory/memory.js";
import { executeRun } from "../../src/spaces/run-controller.js";

const CONFIG = {
  bubbles: { boundaryPattern: "\\n\\s*\\n", minLength: 1, maxLength: 800 },
  activity: { detailMaxLength: 2000 },
  viewCompiler: {
    groupDeltaMaxMessages: 20,
    groupDeltaMaxChars: 4000,
    groupDeltaHeader: "=== 群内最近发言 ===",
    groupDeltaUserLabel: "用户",
    groupDeltaOmittedHint: "（更早的发言数量已达上限）",
  },
};

function waitFor(hub, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timeout waiting for event; saw types: ${seen.join(",")}`));
    }, timeoutMs);
    const unsubscribe = hub.subscribe({
      write(frame) {
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) return;
        const envelope = JSON.parse(dataLine.slice("data: ".length));
        seen.push(envelope.type);
        if (predicate(envelope)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(envelope);
        }
      },
    });
  });
}

function fakeAdapter(capture) {
  return {
    async run(ctx) {
      capture.push(ctx.prompt.text);
      return { content: "reply text", sessionState: { turn: (ctx.sessionState?.turn ?? 0) + 1 } };
    },
  };
}

function createMemoryRetrievalStub(memory) {
  const sessions = new Map();
  let sequence = 0;
  const keyFor = ({ agentId, accountId, spaceId }) => `${agentId}:${accountId}:${spaceId}`;
  return {
    async ensureSession(input) {
      const key = keyFor(input);
      if (input.reset) sessions.delete(key);
      if (!sessions.has(key)) sessions.set(key, { id: `mrs_test_${++sequence}` });
      return sessions.get(key);
    },
    async resetSession(input) {
      sessions.delete(keyFor(input));
    },
    async residentIndex(agentId) {
      const active = (await memory.listMemories(agentId)).filter((item) => item.status === "active");
      if (active.length === 0) return null;
      return [
        "Vera 记忆库常驻索引：",
        "相关时调用 Vera Memory MCP 的 memory_fetch_detail 展开 [[slug]] 查看详情。",
        "",
        ...active.map((item) => `- [[${item.slug}]] — ${item.description}`),
      ].join("\n");
    },
    async searchForInjection() {
      return { block: null, response: { items: [], cursor: null } };
    },
  };
}

async function withFixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "vera-run-controller-test-"));
  const store = await createStore({ dataPath: join(dir, "store.json"), debounceMs: 10 });
  const memory = createMemoryVault({ vaultPath: join(dir, "vault") });
  const memoryRetrieval = createMemoryRetrievalStub(memory);
  const hub = createEventHub({ bufferSize: 100 });
  try {
    await fn({ store, memory, memoryRetrieval, hub, vaultPath: join(dir, "vault") });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("prepends resident index to prompt when no sessionState exists yet", async () => {
  await withFixture(async ({ store, memory, memoryRetrieval, hub }) => {
    await memory.saveMemory("agt_test1", {
      slug: "project-rule-one",
      type: "project_rule",
      description: "常驻钩子示例",
      content: "细节正文",
    });

    const agent = { id: "agt_test1" };
    const account = { id: "acc_test1" };
    const space = { id: "spc_test1", seats: [] };
    const triggerMessage = { id: "msg_test1", content: "hello agent" };
    const captured = [];
    const adapter = fakeAdapter(captured);

    const run = executeRun({ store, hub, config: CONFIG, agent, account, space, triggerMessage, adapter, agentStates: null, memoryRetrieval });
    await waitFor(hub, (e) => e.type === "run.ended" && e.data.run.id === run.id);

    assert.equal(captured.length, 1);
    assert.match(captured[0], /Vera 记忆库常驻索引/);
    assert.match(captured[0], /\[\[project-rule-one\]\] — 常驻钩子示例/);
    assert.match(captured[0], /调用 Vera Memory MCP 的 memory_fetch_detail 展开 \[\[slug\]\]/);
    assert.doesNotMatch(captured[0], /文件库：|\.vera\/memory/, "prompt must not expose the vault path");
    assert.ok(captured[0].endsWith("hello agent"), "original message content should trail the injected block");
  });
});

test("does not inject resident index once sessionState is already persisted", async () => {
  await withFixture(async ({ store, memory, memoryRetrieval, hub }) => {
    await memory.saveMemory("agt_test2", {
      slug: "project-rule-two",
      type: "project_rule",
      description: "不该被注入",
      content: "细节正文",
    });

    const agent = { id: "agt_test2" };
    const account = { id: "acc_test2" };
    const space = { id: "spc_test2", seats: [] };
    const captured = [];
    const adapter = fakeAdapter(captured);

    // 第一条消息建立 sessionState
    const firstRun = executeRun({
      store,
      hub,
      config: CONFIG,
      agent,
      account,
      space,
      triggerMessage: { id: "msg_first", content: "first message" },
      adapter,
      agentStates: null,
      memoryRetrieval,
    });
    await waitFor(hub, (e) => e.type === "run.ended" && e.data.run.id === firstRun.id);
    assert.match(captured[0], /Vera 记忆库常驻索引/, "first message of a fresh session should be prefixed");

    await memory.saveMemory(agent.id, {
      slug: "late-session-rule", type: "project_rule",
      description: "只应在下个外部会话出现", content: "late authority",
    });

    // 第二条消息：sessionState 已存在，不应再注入
    const secondRun = executeRun({
      store,
      hub,
      config: CONFIG,
      agent,
      account,
      space,
      triggerMessage: { id: "msg_second", content: "second message" },
      adapter,
      agentStates: null,
      memoryRetrieval,
    });
    await waitFor(hub, (e) => e.type === "run.ended" && e.data.run.id === secondRun.id);

    assert.equal(captured.length, 2);
    assert.equal(captured[1], "second message", "no injection once sessionState already exists");

    const nextSpace = { id: "spc_test2_next", seats: [] };
    const thirdRun = executeRun({
      store, hub, config: CONFIG, agent, account, space: nextSpace,
      triggerMessage: { id: "msg_third", content: "third message" },
      adapter, agentStates: null, memoryRetrieval,
    });
    await waitFor(hub, (e) => e.type === "run.ended" && e.data.run.id === thirdRun.id);
    assert.match(captured[2], /late-session-rule/u, "a new external session should batch-publish the edited resident index");
  });
});

test("injection only decorates the prompt; stored Message.content stays unpolluted", async () => {
  await withFixture(async ({ store, memory, memoryRetrieval, hub }) => {
    await memory.saveMemory("agt_test4", {
      slug: "project-rule-store",
      type: "project_rule",
      description: "只该进 prompt，不该进 store",
      content: "细节正文",
    });

    const agent = { id: "agt_test4" };
    const account = { id: "acc_test4" };
    const space = { id: "spc_test4", seats: [] };
    // 按 postMessage 的真实流程：trigger 消息先落 store，再交给 executeRun
    const triggerMessage = store.insert("messages", {
      id: "msg_stored1",
      spaceId: space.id,
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "original user words",
      runId: null,
      status: "completed",
      createdAt: new Date().toISOString(),
    });
    const captured = [];
    const adapter = fakeAdapter(captured);

    const run = executeRun({ store, hub, config: CONFIG, agent, account, space, triggerMessage, adapter, agentStates: null, memoryRetrieval });
    await waitFor(hub, (e) => e.type === "run.ended" && e.data.run.id === run.id);

    // prompt 里有注入块
    assert.match(captured[0], /Vera 记忆库常驻索引/);
    assert.ok(captured[0].endsWith("original user words"));
    // store 里的触发消息原样未动，且没有任何一条消息（含 agent 回复气泡）
    // 被注入内容污染
    assert.equal(store.find("messages", "msg_stored1").content, "original user words");
    for (const msg of store.list("messages")) {
      assert.ok(!msg.content.includes("Vera 记忆库常驻索引"), `message ${msg.id} must not contain injected block`);
    }
  });
});

test("memory being absent (undefined) does not crash prompt assembly", async () => {
  await withFixture(async ({ store, hub }) => {
    const agent = { id: "agt_test3" };
    const account = { id: "acc_test3" };
    const space = { id: "spc_test3", seats: [] };
    const captured = [];
    const adapter = fakeAdapter(captured);

    const run = executeRun({
      store,
      hub,
      config: CONFIG,
      agent,
      account,
      space,
      triggerMessage: { id: "msg_test3", content: "no memory wired" },
      adapter,
      agentStates: null,
      memoryRetrieval: undefined,
    });
    await waitFor(hub, (e) => e.type === "run.ended" && e.data.run.id === run.id);
    assert.equal(captured[0], "no memory wired");
  });
});

test("structured prompt snapshot fixes resident, group, trigger, and retrieval physical order", async () => {
  await withFixture(async ({ store, hub }) => {
    const agent = { id: "agt_api", name: "Gemma" };
    const account = { id: "acc_api" };
    const space = { id: "spc_api", seats: [] };
    store.insert("messages", {
      id: "msg_other", spaceId: space.id, author: { type: "agent", agentId: "agt_other" },
      target: { type: "broadcast" }, content: "temporary group context", status: "completed",
      createdAt: "2026-07-14T00:00:00.000Z",
    });
    const triggerMessage = store.insert("messages", {
      id: "msg_user", spaceId: space.id, author: { type: "user" }, target: { type: "broadcast" },
      content: "raw user question", status: "completed", createdAt: "2026-07-14T00:00:01.000Z",
    });
    let captured;
    let searchInput;
    const memoryRetrieval = {
      async ensureSession() { return { id: "mrs_snapshot" }; },
      async resetSession() {},
      async residentIndex() { return "RESIDENT"; },
      async searchForInjection(input) {
        searchInput = input;
        return { block: "RETRIEVAL", response: { items: [{ slug: "rule" }], cursor: null } };
      },
    };
    const adapter = {
      async run(ctx) {
        captured = ctx.prompt;
        return { content: "answer", sessionState: { ok: true } };
      },
    };
    const run = executeRun({ store, hub, config: CONFIG, agent, account, space, triggerMessage, adapter, memoryRetrieval });
    await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === run.id);

    const group = "=== 群内最近发言 ===\n- agent: temporary group context";
    assert.equal(captured.text, `RESIDENT\n\n${group}\n\nraw user question\n\nRETRIEVAL`);
    assert.equal(captured.turnText, `${group}\n\nraw user question\n\nRETRIEVAL`);
    assert.equal(captured.historyUserText, "raw user question");
    assert.equal(captured.historyEnvelopeText, "raw user question\n\nRETRIEVAL");
    assert.equal(captured.residentBlock, "RESIDENT");
    assert.equal(captured.retrievalBlock, "RETRIEVAL");
    assert.deepEqual(searchInput, {
      context: {
        agentId: agent.id,
        memorySessionId: "mrs_snapshot",
        runId: run.id,
        spaceId: space.id,
        triggerMessageId: triggerMessage.id,
      },
      query: "raw user question",
    });
  });
});

test("automatic retrieval failure omits the block without failing the run", async () => {
  await withFixture(async ({ store, hub }) => {
    const agent = { id: "agt_failopen" };
    const account = { id: "acc_failopen" };
    const space = { id: "spc_failopen", seats: [] };
    const captured = [];
    const memoryRetrieval = {
      async ensureSession() { return { id: "mrs_failopen" }; },
      async resetSession() {},
      async residentIndex() { return null; },
      async searchForInjection() { throw new Error("derived index unavailable"); },
    };
    const run = executeRun({
      store, hub, config: CONFIG, agent, account, space,
      triggerMessage: { id: "msg_failopen", content: "chat must continue" },
      adapter: fakeAdapter(captured), memoryRetrieval,
    });
    const ended = await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === run.id);
    assert.equal(ended.data.run.status, "completed");
    assert.deepEqual(captured, ["chat must continue"]);
  });
});

test("one Memory recall session deduplicates automatic injection across provider turns", async () => {
  await withFixture(async ({ store, hub }) => {
    const agent = { id: "agt_dedupe" };
    const account = { id: "acc_dedupe" };
    const space = { id: "spc_dedupe", seats: [] };
    const ensureCalls = [];
    const delivered = new Set();
    const memoryRetrieval = {
      async ensureSession(input) {
        ensureCalls.push(input);
        return { id: "mrs_shared" };
      },
      async resetSession() {},
      async residentIndex() { return null; },
      async searchForInjection({ context }) {
        if (delivered.has(context.memorySessionId)) return { block: null, response: { items: [] } };
        delivered.add(context.memorySessionId);
        return { block: "MEMORY ONCE", response: { items: [{ slug: "once" }] } };
      },
    };
    const captured = [];
    const adapter = fakeAdapter(captured);
    const first = executeRun({
      store, hub, config: CONFIG, agent, account, space,
      triggerMessage: { id: "msg_dedupe_1", content: "first" }, adapter, memoryRetrieval,
    });
    await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === first.id);
    const second = executeRun({
      store, hub, config: CONFIG, agent, account, space,
      triggerMessage: { id: "msg_dedupe_2", content: "second" }, adapter, memoryRetrieval,
    });
    await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === second.id);

    assert.deepEqual(captured, ["first\n\nMEMORY ONCE", "second"]);
    assert.deepEqual(ensureCalls.map((call) => call.reset), [true, false]);
    assert.ok(ensureCalls.every((call) => call.accountId === account.id && call.spaceId === space.id));
  });
});

test("recompileForNewSession resets once and returns one fresh prompt Promise", async () => {
  await withFixture(async ({ store, hub }) => {
    const agent = { id: "agt_recompile" };
    const account = { id: "acc_recompile" };
    const space = { id: "spc_recompile", seats: [] };
    store.setSessionState(account.id, space.id, { externalSessionId: "old" });
    const ensureCalls = [];
    const resetCalls = [];
    const searchedSessions = [];
    let sequence = 0;
    const memoryRetrieval = {
      async ensureSession(input) {
        ensureCalls.push(input);
        return { id: `mrs_recompile_${++sequence}` };
      },
      async resetSession(input) {
        assert.equal(store.getSessionState(account.id, space.id), null, "provider state must clear before recall reset");
        resetCalls.push(input);
      },
      async residentIndex() { return "FRESH RESIDENT"; },
      async searchForInjection({ context }) {
        searchedSessions.push(context.memorySessionId);
        return { block: `MEMORY ${context.memorySessionId}`, response: { items: [] } };
      },
    };
    let initialPrompt;
    let freshPrompt;
    let identicalPromise = false;
    const adapter = {
      async run(ctx) {
        initialPrompt = ctx.prompt;
        const first = ctx.recompileForNewSession({ reason: "missing" });
        const second = ctx.recompileForNewSession({ reason: "invalid" });
        identicalPromise = first === second;
        freshPrompt = await first;
        assert.strictEqual(await second, freshPrompt);
        return { content: "fresh answer", sessionState: { externalSessionId: "new" } };
      },
    };
    const triggerMessage = { id: "msg_recompile", content: "same frozen trigger" };
    const run = executeRun({
      store, hub, config: CONFIG, agent, account, space, triggerMessage, adapter, memoryRetrieval,
    });
    await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === run.id);

    assert.equal(identicalPromise, true);
    assert.equal(resetCalls.length, 1);
    assert.deepEqual(ensureCalls.map((call) => call.reset), [false, false]);
    assert.deepEqual(searchedSessions, ["mrs_recompile_1", "mrs_recompile_2"]);
    assert.equal(initialPrompt.text, "same frozen trigger\n\nMEMORY mrs_recompile_1");
    assert.equal(freshPrompt.text, "FRESH RESIDENT\n\nsame frozen trigger\n\nMEMORY mrs_recompile_2");
    assert.equal(freshPrompt.historyEnvelopeText, "same frozen trigger\n\nMEMORY mrs_recompile_2");
    assert.deepEqual(store.getSessionState(account.id, space.id), { externalSessionId: "new" });
  });
});

test("prompt setup failure ends the Run and releases Agent state before adapter execution", async () => {
  await withFixture(async ({ store, hub }) => {
    const agent = { id: "agt_setupfail" };
    const account = { id: "acc_setupfail" };
    const space = { id: "spc_setupfail", seats: [] };
    let adapterCalled = false;
    const states = [];
    const memoryRetrieval = {
      async ensureSession() { throw new Error("sidecar setup failed at /private/secret/path"); },
      async resetSession() {},
      async residentIndex() { return null; },
      async searchForInjection() { return { block: null }; },
    };
    const run = executeRun({
      store, hub, config: CONFIG, agent, account, space,
      triggerMessage: { id: "msg_setupfail", content: "hello" },
      adapter: { async run() { adapterCalled = true; return { content: "unexpected" }; } },
      agentStates: { setWorking() { states.push("working"); }, setIdle() { states.push("idle"); } },
      memoryRetrieval,
    });
    const ended = await waitFor(hub, (event) => event.type === "run.ended" && event.data.run.id === run.id);
    assert.equal(ended.data.run.status, "failed");
    assert.equal(ended.data.run.error.code, "internal");
    assert.equal(ended.data.run.error.message, "prompt compilation failed");
    assert.doesNotMatch(JSON.stringify(ended.data.run.error), /private|secret|path/u);
    assert.equal(adapterCalled, false);
    assert.deepEqual(states, ["working", "idle"]);
    assert.equal(store.find("runs", run.id).status, "failed");
  });
});
