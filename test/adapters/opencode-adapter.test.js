// OpenCode daemon adapter 单测：不碰真实 opencode 二进制。
// - 假 daemon：本地 node:http stub，模拟 salvage-notes 实测的协议子集
//   （GET/POST /api/session、GET /api/session/:id、GET /api/event SSE）。
// - 假 CLI：临时目录里生成的可执行 node 脚本。"serve" 模式空转当常驻进程
//   （健康检查打到 stub 的固定端口上）；"run" 模式 POST stub 的 /control/run，
//   由各测试用例注入的 handler 决定发什么 SSE 事件、返回什么 stdout。

import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { getEventListeners } from "node:events";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOpencodeAdapter } from "../../src/adapters/opencode-adapter.js";
import { MEMORY_DIGEST_OUTPUT_JSON_SCHEMA, validateDigestProposals } from "../../src/memory/memory-proposals.js";

// ---------- stub daemon ----------

async function startStubDaemon() {
  const sessions = new Set();
  let sseClients = [];
  let runHandler = null;
  let digestHandler = null;
  let sessionCounter = 0;
  let toolIds = ["bash", "read", "write"];
  const digestRequests = [];
  const deletedDigestSessions = [];

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session") {
      sessionCounter += 1;
      const id = `ses_stub_${sessionCounter}`;
      sessions.add(id);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { id } }));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/session/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop());
      res.writeHead(sessions.has(id) ? 200 : 404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      sseClients.push(res);
      req.on("close", () => {
        sseClients = sseClients.filter((c) => c !== res);
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/experimental/tool/ids") {
      digestRequests.push({ kind: "tools", directory: url.searchParams.get("directory") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: toolIds }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/session") {
      const body = await readBody(req);
      sessionCounter += 1;
      const id = `ses_digest_${sessionCounter}`;
      sessions.add(id);
      digestRequests.push({ kind: "create", sessionId: id, directory: url.searchParams.get("directory"), body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { id } }));
      return;
    }
    const digestMessageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
    if (req.method === "POST" && digestMessageMatch) {
      const sessionId = decodeURIComponent(digestMessageMatch[1]);
      const body = await readBody(req);
      const request = { kind: "message", sessionId, directory: url.searchParams.get("directory"), body };
      digestRequests.push(request);
      if (!digestHandler) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "no digest handler" } }));
        return;
      }
      try {
        const result = await digestHandler(request);
        res.writeHead(result?.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(result?.body ?? result ?? {}));
      } catch {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stub digest failure" } }));
      }
      return;
    }
    const digestDeleteMatch = url.pathname.match(/^\/session\/([^/]+)$/);
    if (req.method === "DELETE" && digestDeleteMatch) {
      const sessionId = decodeURIComponent(digestDeleteMatch[1]);
      sessions.delete(sessionId);
      deletedDigestSessions.push({ sessionId, directory: url.searchParams.get("directory") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: true }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/control/run") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (!runHandler) {
        res.writeHead(500);
        res.end("{}");
        return;
      }
      try {
        const result = await runHandler(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result ?? {}));
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end("{}");
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    seedSession: (id) => sessions.add(id),
    emit(type, data) {
      const frame = `data: ${JSON.stringify({ type, data })}\n\n`;
      for (const client of sseClients) client.write(frame);
    },
    setRunHandler(fn) {
      runHandler = fn;
    },
    setDigestHandler(fn) {
      digestHandler = fn;
    },
    setToolIds(ids) {
      toolIds = ids;
    },
    resetDigest() {
      digestHandler = null;
      toolIds = ["bash", "read", "write"];
      digestRequests.length = 0;
      deletedDigestSessions.length = 0;
    },
    digestRequests,
    deletedDigestSessions,
    sseClientCount: () => sseClients.length,
    close() {
      return new Promise((resolve) => {
        for (const client of sseClients) client.end();
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

// ---------- 假 opencode 二进制 ----------

const FAKE_CLI_SOURCE = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "serve") {
  setInterval(() => {}, 1 << 30); // 常驻空转，等 SIGTERM
} else if (args[0] === "run") {
  const attach = args[args.indexOf("--attach") + 1];
  const sessionId = args[args.indexOf("-s") + 1];
  const prompt = args[args.length - 1];
  fetch(attach + "/control/run", { method: "POST", body: JSON.stringify({ sessionId, prompt, args }) })
    .then(async (resp) => {
      const j = await resp.json().catch(() => ({}));
      if (j.stdout) process.stdout.write(j.stdout);
      process.exit(j.exitCode ?? 0);
    })
    .catch(() => process.exit(1));
}
`;

// ---------- 共享装置 ----------

const stub = await startStubDaemon();
const binDir = await mkdtemp(join(tmpdir(), "vera-oc-fake-"));
const fakeBinary = join(binDir, "opencode");
await writeFile(fakeBinary, FAKE_CLI_SOURCE, { mode: 0o755 });

function adapterConfig(overrides = {}) {
  return {
    binary: fakeBinary,
    daemonPort: stub.port, // 固定端口：健康检查/HTTP/SSE 全打到 stub 上
    idleShutdownMs: 60_000,
    watchdogMs: 60_000,
    healthCheckTimeoutMs: 3000,
    shutdownGraceMs: 500,
    ...overrides,
  };
}

const adapter = createOpencodeAdapter({ config: adapterConfig() });
const extraAdapters = [];

after(async () => {
  await adapter.shutdown();
  for (const extra of extraAdapters) await extra.shutdown();
  await stub.close();
  await rm(binDir, { recursive: true, force: true });
});

function makeCtx({ text = "hi", sessionState = null, recompileForNewSession } = {}) {
  const deltas = [];
  const activities = [];
  const persisted = [];
  const controller = new AbortController();
  return {
    ctx: {
      agent: {
        id: "agt_test",
        name: "T",
      },
      account: {
        id: "acc_test",
        kind: "cli",
        provider: "opencode",
        connection: { command: null, args: [] },
        model: "",
      },
      prompt: { text },
      sessionState,
      workspacePath: tmpdir(),
      onDelta: (d) => deltas.push(d),
      onActivity: (evt) => activities.push(evt),
      requestApproval: async () => "deny",
      persistSessionState: (state) => persisted.push(state),
      ...(recompileForNewSession ? { recompileForNewSession } : {}),
      signal: controller.signal,
    },
    deltas,
    activities,
    persisted,
    controller,
  };
}

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("waitFor timed out"));
      }
    }, 20);
  });
}

function makeDigestCtx({ model = "navy/deepseek-v4-pro", signal } = {}) {
  return {
    account: {
      id: "acc_test",
      kind: "cli",
      provider: "opencode",
      model,
      connection: { command: fakeBinary, args: [] },
    },
    payload: {
      agent: { id: "agt_test", name: "T" },
      chunks: [{ id: "dch_1", messages: [{ messageId: "msg_1", content: "remember this" }] }],
      facts: [],
      proposalSchema: { type: "object" },
    },
    signal: signal ?? new AbortController().signal,
  };
}

function digestSuccess(proposals = []) {
  return { body: { data: { info: { structured: { proposals } }, parts: [] } } };
}

// ---------- 用例 ----------

test("normal streaming with a valid existing session", async () => {
  stub.seedSession("ses_known");
  stub.setRunHandler(async ({ sessionId }) => {
    stub.emit("message.part.delta", { sessionID: sessionId, field: "text", delta: "你好" });
    stub.emit("message.part.updated", {
      sessionID: sessionId,
      part: { type: "tool", tool: "bash", callID: "call-1", state: { status: "pending", title: "npm test" } },
    });
    stub.emit("message.part.delta", { sessionID: sessionId, field: "text", delta: "，世界" });
    stub.emit("message.part.updated", {
      sessionID: sessionId,
      part: { type: "tool", tool: "bash", callID: "call-1", state: { status: "completed", title: "npm test", output: "ok" } },
    });
    stub.emit("session.idle", { sessionID: sessionId });
    return { stdout: "STDOUT-FALLBACK-IGNORED" };
  });

  const { ctx, deltas, activities, persisted } = makeCtx({
    sessionState: { externalSessionId: "ses_known" },
  });
  const result = await adapter.run(ctx);

  assert.equal(result.content, "你好，世界"); // delta 累积优先于 stdout
  assert.deepEqual(result.sessionState, { externalSessionId: "ses_known" });
  assert.deepEqual(deltas, ["你好", "，世界"]);
  assert.equal(persisted.length, 0, "复用有效会话时不应重新持久化");

  const toolActivities = activities.filter((a) => a.phase === "tool");
  assert.equal(toolActivities.length, 2);
  assert.equal(toolActivities[0].toolStatus, "pending");
  assert.equal(toolActivities[1].toolStatus, "completed");
  assert.equal(toolActivities[0].callId, "call-1");
  assert.equal(toolActivities[1].callId, "call-1");
  assert.ok(!activities.some((a) => a.label === "session-reset"), "有效会话不应上报 session-reset");
});

test("first run without sessionState creates a session and persists it immediately", async () => {
  stub.setRunHandler(async ({ sessionId }) => {
    stub.emit("message.part.delta", { sessionID: sessionId, field: "text", delta: "首答" });
    stub.emit("session.idle", { sessionID: sessionId });
    return {};
  });

  const { ctx, activities, persisted } = makeCtx({ sessionState: null });
  const result = await adapter.run(ctx);

  assert.equal(persisted.length, 1, "新会话必须立即 persistSessionState");
  assert.match(persisted[0].externalSessionId, /^ses_stub_/);
  assert.deepEqual(result.sessionState, persisted[0]);
  assert.equal(result.content, "首答");
  assert.ok(!activities.some((a) => a.label === "session-reset"), "首建不是失效重建，不应上报 session-reset");
});

test("invalid non-null session state recompiles before creating and persisting a replacement", async () => {
  let runnerPrompt = null;
  stub.setRunHandler(async ({ sessionId, prompt }) => {
    runnerPrompt = prompt;
    stub.emit("message.part.delta", { sessionID: sessionId, field: "text", delta: "非法状态已恢复" });
    stub.emit("session.idle", { sessionID: sessionId });
    return {};
  });
  const order = [];
  const { ctx, activities, persisted } = makeCtx({
    text: "INVALID STATE PROMPT",
    sessionState: { externalSessionId: 42 },
    recompileForNewSession: async (reason) => {
      order.push({ type: "recompile", reason });
      return { text: "FRESH INVALID-STATE PROMPT" };
    },
  });
  ctx.persistSessionState = (state) => { order.push({ type: "persist" }); persisted.push(state); };
  const result = await adapter.run(ctx);
  assert.deepEqual(order, [
    { type: "recompile", reason: { reason: "invalid" } },
    { type: "persist" },
  ]);
  assert.equal(runnerPrompt, "FRESH INVALID-STATE PROMPT");
  assert.equal(result.sessionState.externalSessionId, persisted[0].externalSessionId);
  assert.match(activities.find((item) => item.label === "session-reset")?.detail ?? "", /invalid/u);
});

test("stale session is rebuilt with a session-reset activity, not silently", async () => {
  let runnerPrompt = null;
  stub.setRunHandler(async ({ sessionId, prompt }) => {
    runnerPrompt = prompt;
    stub.emit("message.part.delta", { sessionID: sessionId, field: "text", delta: "重建后继续" });
    stub.emit("session.idle", { sessionID: sessionId });
    return {};
  });

  const resetOrder = [];
  const { ctx, activities, persisted } = makeCtx({
    text: "STALE PROMPT",
    sessionState: { externalSessionId: "ses_daemon_restarted_gone" },
    recompileForNewSession: async (reason) => {
      resetOrder.push({ type: "recompile", reason });
      return { text: "FRESH OPENCODE PROMPT" };
    },
  });
  ctx.persistSessionState = (state) => {
    resetOrder.push({ type: "persist" });
    persisted.push(state);
  };
  const result = await adapter.run(ctx);

  assert.deepEqual(resetOrder, [
    { type: "recompile", reason: { reason: "missing" } },
    { type: "persist" },
  ], "recall session must reset before the replacement provider session is persisted");
  assert.equal(persisted.length, 1);
  assert.notEqual(persisted[0].externalSessionId, "ses_daemon_restarted_gone");
  assert.equal(result.sessionState.externalSessionId, persisted[0].externalSessionId);

  const reset = activities.find((a) => a.label === "session-reset");
  assert.ok(reset, "失效重建必须上报 session-reset activity");
  assert.equal(reset.phase, "error");
  assert.match(reset.detail, /ses_daemon_restarted_gone/);
  assert.equal(runnerPrompt, "FRESH OPENCODE PROMPT");
  assert.equal(result.content, "重建后继续");
});

test("ordinary OpenCode provider errors do not recompile the Memory recall session", async () => {
  stub.seedSession("ses_provider_error");
  stub.setRunHandler(async ({ sessionId }) => {
    stub.emit("session.error", { sessionID: sessionId, error: "ordinary provider failure" });
    return {};
  });
  const reasons = [];
  const { ctx } = makeCtx({
    sessionState: { externalSessionId: "ses_provider_error" },
    recompileForNewSession: async (reason) => {
      reasons.push(reason);
      return { text: "ordinary errors must not use this" };
    },
  });
  await assert.rejects(() => adapter.run(ctx), (error) => error.code === "provider_error");
  assert.deepEqual(reasons, []);
});

test("cancel: abort SIGTERMs the child, throws cancelled, and removes the abort listener", async () => {
  stub.setRunHandler(async ({ sessionId }) => {
    stub.emit("message.part.delta", { sessionID: sessionId, field: "text", delta: "开始了" });
    await new Promise(() => {}); // 永不 idle、永不回 CLI
  });

  const { ctx, deltas, controller } = makeCtx({ sessionState: null });
  const pending = adapter.run(ctx);
  await waitFor(() => deltas.length >= 1);
  controller.abort();

  await assert.rejects(pending, (err) => {
    assert.equal(err.name, "AdapterError");
    assert.equal(err.code, "cancelled");
    return true;
  });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0, "abort listener 必须被移除（旧 repo bug）");
});

test("watchdog: run with no completion times out with timed_out", async () => {
  const timeoutAdapter = createOpencodeAdapter({ config: adapterConfig({ watchdogMs: 400 }) });
  extraAdapters.push(timeoutAdapter);
  stub.setRunHandler(async () => {
    await new Promise(() => {}); // 永不完成
  });

  const { ctx } = makeCtx({ sessionState: null });
  await assert.rejects(
    () => timeoutAdapter.run(ctx),
    (err) => {
      assert.equal(err.name, "AdapterError");
      assert.equal(err.code, "timed_out");
      return true;
    },
  );
});

test("missing binary fails fast with unavailable", async () => {
  const brokenAdapter = createOpencodeAdapter({
    config: adapterConfig({ binary: "/nonexistent/path/opencode" }),
  });
  const { ctx } = makeCtx({ sessionState: null });
  await assert.rejects(
    () => brokenAdapter.run(ctx),
    (err) => {
      assert.equal(err.name, "AdapterError");
      assert.equal(err.code, "unavailable");
      return true;
    },
  );
});

test("kind/provider mismatch fails before starting OpenCode", async () => {
  const { ctx } = makeCtx();
  ctx.account = { ...ctx.account, kind: "api", provider: "ollama" };
  await assert.rejects(() => adapter.run(ctx), (error) => error.code === "unavailable");
  await assert.rejects(
    () => adapter.digestMemory({ ...makeDigestCtx(), account: ctx.account }),
    (error) => error.code === "executor_unavailable",
  );
});

test("runner args carry -s <sessionId>, --dangerously-skip-permissions and the prompt", async () => {
  let seenArgs = null;
  stub.setRunHandler(async ({ sessionId, args, prompt }) => {
    seenArgs = { sessionId, args, prompt };
    stub.emit("session.idle", { sessionID: sessionId });
    return { stdout: "done" };
  });

  stub.seedSession("ses_args_check");
  const { ctx } = makeCtx({ text: "只回一个字：好", sessionState: { externalSessionId: "ses_args_check" } });
  const result = await adapter.run(ctx);

  assert.equal(seenArgs.sessionId, "ses_args_check");
  assert.ok(seenArgs.args.includes("--dangerously-skip-permissions"));
  assert.ok(seenArgs.args.includes("-c"));
  assert.equal(seenArgs.prompt, "只回一个字：好");
  assert.equal(result.content, "done", "零 delta 时 content 用 stdout 兜底");
});

test("digestMemory uses a fresh isolated session and directory with wildcard/tool deny and structured output", async () => {
  stub.resetDigest();
  stub.setToolIds(["bash", "read", "custom.tool"]);
  stub.setDigestHandler(async () => digestSuccess([{ action: "skip", skipReason: "no_reusable_fact" }]));

  const first = await adapter.digestMemory(makeDigestCtx());
  const second = await adapter.digestMemory(makeDigestCtx());
  assert.deepEqual(first.proposals, [{ action: "skip", skipReason: "no_reusable_fact" }]);
  assert.equal(first.execution.fallbackUsed, false);
  assert.equal(first.execution.effectiveModel, "navy/deepseek-v4-pro");

  const creates = stub.digestRequests.filter((request) => request.kind === "create");
  const messages = stub.digestRequests.filter((request) => request.kind === "message");
  assert.equal(creates.length, 2);
  assert.equal(messages.length, 2);
  assert.notEqual(creates[0].sessionId, creates[1].sessionId, "each digest call must create a new session");
  assert.notEqual(creates[0].directory, creates[1].directory, "each digest call must create a new directory");
  for (const create of creates) {
    assert.deepEqual(create.body.permission, [{ permission: "*", pattern: "*", action: "deny" }]);
    assert.deepEqual(create.body.model, { id: "deepseek-v4-pro", providerID: "navy" });
  }
  for (const request of messages) {
    assert.deepEqual(request.body.tools, { bash: false, read: false, "custom.tool": false });
    assert.equal(request.body.format.type, "json_schema");
    assert.equal(request.body.format.retryCount, 2);
    assert.equal(request.body.format.schema.type, "object");
    assert.equal(request.body.parts[0].text.includes('"proposalSchema"'), false, "schema must not be duplicated in prompt text");
    assert.deepEqual(request.body.model, { providerID: "navy", modelID: "deepseek-v4-pro" });
    assert.equal(request.directory, creates.find((create) => create.sessionId === request.sessionId).directory);
  }
  assert.deepEqual(stub.deletedDigestSessions.map((item) => item.sessionId).sort(), creates.map((item) => item.sessionId).sort());
  for (const create of creates) {
    await assert.rejects(() => stat(create.directory), (error) => error.code === "ENOENT");
  }
  assert.equal(second.execution.attempts, 1, "primary success must not use fallback");
});

test("digestMemory rejects a missing provider/model id as executor_unavailable", async () => {
  await assert.rejects(
    () => adapter.digestMemory(makeDigestCtx({ model: "deepseek-v4-pro" })),
    (error) => error.code === "executor_unavailable",
  );
});

test("digestMemory quota exhaustion retries once in a new session with the configured free model", async () => {
  for (const quotaError of [
    { status: 402, error: { name: "APIError", data: { statusCode: 402, responseBody: '{"error":{"code":"quota_exhausted"}}' } } },
    { status: 429, error: { name: "APIError", data: { statusCode: 429, responseBody: '{"error":{"code":"insufficient_quota"}}' } } },
  ]) {
    stub.resetDigest();
    const fallbackAdapter = createOpencodeAdapter({ config: adapterConfig({
      memoryDigestQuotaFallbacks: { "navy/deepseek-v4-pro": "opencode/deepseek-v4-flash-free" },
    }) });
    extraAdapters.push(fallbackAdapter);
    stub.setDigestHandler(async ({ body }) => {
      if (body.model.providerID === "navy") return { status: quotaError.status, body: { error: quotaError.error } };
      return digestSuccess([]);
    });

    const result = await fallbackAdapter.digestMemory(makeDigestCtx());
    assert.deepEqual(result.execution, {
      adapter: "opencode",
      primaryModel: "navy/deepseek-v4-pro",
      effectiveModel: "opencode/deepseek-v4-flash-free",
      fallbackUsed: true,
      fallbackReason: "quota_exhausted",
      attempts: 2,
    });
    const creates = stub.digestRequests.filter((request) => request.kind === "create");
    assert.equal(creates.length, 2);
    assert.notEqual(creates[0].sessionId, creates[1].sessionId);
    assert.deepEqual(creates.map((request) => request.body.model), [
      { id: "deepseek-v4-pro", providerID: "navy" },
      { id: "deepseek-v4-flash-free", providerID: "opencode" },
    ]);
  }
});

test("ordinary 429, 401, and invalid structured output never trigger quota fallback", async () => {
  const cases = [
    async () => ({ status: 402, body: { error: { name: "APIError", data: { statusCode: 402, message: "payment required" } } } }),
    async () => ({ status: 429, body: { error: { name: "APIError", data: { statusCode: 429, message: "rate limited, retry later" } } } }),
    async () => ({ status: 401, body: { error: { name: "ProviderAuthError", data: { statusCode: 401, message: "unauthorized" } } } }),
    async () => ({ body: { data: { info: { structured: { wrong: [] } }, parts: [] } } }),
  ];
  for (const handler of cases) {
    stub.resetDigest();
    const noFallbackAdapter = createOpencodeAdapter({ config: adapterConfig({
      memoryDigestQuotaFallbacks: { "navy/deepseek-v4-pro": "opencode/deepseek-v4-flash-free" },
    }) });
    extraAdapters.push(noFallbackAdapter);
    stub.setDigestHandler(handler);
    await assert.rejects(() => noFallbackAdapter.digestMemory(makeDigestCtx()), (error) => error.code === "executor_failed");
    assert.equal(stub.digestRequests.filter((request) => request.kind === "create").length, 1);
  }
});

test("a non-Navy OpenCode model never uses the Navy quota fallback mapping", async () => {
  stub.resetDigest();
  const otherModel = "opencode/deepseek-v4-flash-free";
  const noOtherFallbackAdapter = createOpencodeAdapter({ config: adapterConfig({
    memoryDigestQuotaFallbacks: { [otherModel]: "opencode/another-model" },
  }) });
  extraAdapters.push(noOtherFallbackAdapter);
  stub.setDigestHandler(async () => ({
    status: 402,
    body: { error: { name: "APIError", data: { statusCode: 402, type: "quota_exhausted" } } },
  }));
  await assert.rejects(
    () => noOtherFallbackAdapter.digestMemory(makeDigestCtx({ model: otherModel })),
    (error) => error.code === "executor_failed",
  );
  assert.equal(stub.digestRequests.filter((request) => request.kind === "create").length, 1);
});

test("digestMemory rejects any tool event even when the REST response would succeed", async () => {
  stub.resetDigest();
  stub.setDigestHandler(async ({ sessionId }) => {
    await waitFor(() => stub.sseClientCount() > 0);
    stub.emit("message.part.updated", {
      sessionID: sessionId,
      part: { type: "tool", tool: "bash", callID: "forbidden", state: { status: "pending" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return digestSuccess([]);
  });
  await assert.rejects(() => adapter.digestMemory(makeDigestCtx()), (error) => error.code === "executor_failed");
  assert.equal(stub.digestRequests.filter((request) => request.kind === "create").length, 1);
});

test("digestMemory aborts and cleans its independent session/directory", async () => {
  stub.resetDigest();
  stub.setDigestHandler(async () => new Promise(() => {}));
  const controller = new AbortController();
  const pending = adapter.digestMemory(makeDigestCtx({ signal: controller.signal }));
  await waitFor(() => stub.digestRequests.some((request) => request.kind === "message"));
  const directory = stub.digestRequests.find((request) => request.kind === "create").directory;
  controller.abort();
  await assert.rejects(pending, (error) => error.code === "cancelled");
  await assert.rejects(() => stat(directory), (error) => error.code === "ENOENT");
  assert.equal(stub.deletedDigestSessions.length, 1);
});

test("digestMemory enforces its own timeout without changing chat watchdog behavior", async () => {
  stub.resetDigest();
  const timeoutAdapter = createOpencodeAdapter({ config: adapterConfig({ digestTimeoutMs: 50 }) });
  extraAdapters.push(timeoutAdapter);
  stub.setDigestHandler(async () => new Promise(() => {}));
  await assert.rejects(() => timeoutAdapter.digestMemory(makeDigestCtx()), (error) => error.code === "timed_out");
  assert.equal(stub.deletedDigestSessions.length, 1);
});

test("opt-in real OpenCode digestMemory smoke", {
  skip: process.env.VERA_TEST_OPENCODE !== "1" ? "set VERA_TEST_OPENCODE=1 to spend a real model request" : false,
  timeout: 190_000,
}, async () => {
  const binary = process.env.VERA_OPENCODE_BIN || "/Users/theta/.opencode/bin/opencode";
  const primaryModel = process.env.VERA_TEST_OPENCODE_PRIMARY_MODEL || "navy/deepseek-v4-pro";
  const fallbackModel = process.env.VERA_TEST_OPENCODE_FALLBACK_MODEL || "opencode/deepseek-v4-flash-free";
  const realAdapter = createOpencodeAdapter({
    config: {
      binary,
      daemonPort: 0,
      idleShutdownMs: 60_000,
      watchdogMs: 180_000,
      digestTimeoutMs: 180_000,
      healthCheckTimeoutMs: 20_000,
      shutdownGraceMs: 5_000,
      memoryDigestQuotaFallbacks: { [primaryModel]: fallbackModel },
    },
  });
  try {
    const result = await realAdapter.digestMemory({
      account: {
        id: "acc_smoke", kind: "cli", provider: "opencode",
        model: primaryModel, connection: { command: binary, args: [] },
      },
      payload: {
        agent: { id: "agt_smoke", name: "Smoke" },
        chunks: [{
          id: "dch_smoke",
          fromMessageId: "msg_smoke",
          toMessageId: "msg_smoke",
          messageCount: 1,
          charCount: 26,
          messages: [{
            messageId: "msg_smoke",
            author: { type: "user" },
            target: { type: "broadcast" },
            content: "请记住：Vera 的测试颜色是蓝色。",
            createdAt: "2026-07-13T00:00:00.000Z",
          }],
        }],
        facts: [],
        proposalSchema: MEMORY_DIGEST_OUTPUT_JSON_SCHEMA,
      },
      signal: AbortSignal.timeout(180_000),
    });
    assert.ok(Array.isArray(result.proposals));
    assert.equal(result.execution.adapter, "opencode");
    assert.equal(result.execution.primaryModel, primaryModel);
    assert.ok([primaryModel, fallbackModel].includes(result.execution.effectiveModel));
    assert.equal(result.execution.attempts, result.execution.fallbackUsed ? 2 : 1);
    validateDigestProposals({
      proposals: result.proposals,
      messages: [{ id: "msg_smoke", spaceId: "spc_smoke", status: "completed", content: "请记住：Vera 的测试颜色是蓝色。" }],
      agentId: "agt_smoke",
      spaceId: "spc_smoke",
      jobId: "mdj_smoke",
    });
  } finally {
    await realAdapter.shutdown();
  }
});
