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
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOpencodeAdapter } from "../../src/adapters/opencode-adapter.js";

// ---------- stub daemon ----------

async function startStubDaemon() {
  const sessions = new Set();
  let sseClients = [];
  let runHandler = null;
  let sessionCounter = 0;

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

function makeCtx({ text = "hi", sessionState = null } = {}) {
  const deltas = [];
  const activities = [];
  const persisted = [];
  const controller = new AbortController();
  return {
    ctx: {
      agent: {
        id: "agt_test",
        name: "T",
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

test("stale session is rebuilt with a session-reset activity, not silently", async () => {
  stub.setRunHandler(async ({ sessionId }) => {
    stub.emit("message.part.delta", { sessionID: sessionId, field: "text", delta: "重建后继续" });
    stub.emit("session.idle", { sessionID: sessionId });
    return {};
  });

  const { ctx, activities, persisted } = makeCtx({
    sessionState: { externalSessionId: "ses_daemon_restarted_gone" },
  });
  const result = await adapter.run(ctx);

  assert.equal(persisted.length, 1);
  assert.notEqual(persisted[0].externalSessionId, "ses_daemon_restarted_gone");
  assert.equal(result.sessionState.externalSessionId, persisted[0].externalSessionId);

  const reset = activities.find((a) => a.label === "session-reset");
  assert.ok(reset, "失效重建必须上报 session-reset activity");
  assert.equal(reset.phase, "error");
  assert.match(reset.detail, /ses_daemon_restarted_gone/);
  assert.equal(result.content, "重建后继续");
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
