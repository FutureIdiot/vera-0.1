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
  viewCompiler: { groupDeltaMaxMessages: 20, groupDeltaMaxChars: 4000 },
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

async function withFixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "vera-run-controller-test-"));
  const store = await createStore({ dataPath: join(dir, "store.json"), debounceMs: 10 });
  const memory = createMemoryVault({ vaultPath: join(dir, "vault"), residentIndexMaxLines: 25 });
  const hub = createEventHub({ bufferSize: 100 });
  try {
    await fn({ store, memory, hub, vaultPath: join(dir, "vault") });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("prepends resident index to prompt when no sessionState exists yet", async () => {
  await withFixture(async ({ store, memory, hub }) => {
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

    const run = executeRun({ store, hub, config: CONFIG, agent, account, space, triggerMessage, adapter, agentStates: null, memory });
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
  await withFixture(async ({ store, memory, hub }) => {
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
      memory,
    });
    await waitFor(hub, (e) => e.type === "run.ended" && e.data.run.id === firstRun.id);
    assert.match(captured[0], /Vera 记忆库常驻索引/, "first message of a fresh session should be prefixed");

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
      memory,
    });
    await waitFor(hub, (e) => e.type === "run.ended" && e.data.run.id === secondRun.id);

    assert.equal(captured.length, 2);
    assert.equal(captured[1], "second message", "no injection once sessionState already exists");
  });
});

test("injection only decorates the prompt; stored Message.content stays unpolluted", async () => {
  await withFixture(async ({ store, memory, hub }) => {
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

    const run = executeRun({ store, hub, config: CONFIG, agent, account, space, triggerMessage, adapter, agentStates: null, memory });
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
      memory: undefined,
    });
    await waitFor(hub, (e) => e.type === "run.ended" && e.data.run.id === run.id);
    assert.equal(captured[0], "no memory wired");
  });
});
