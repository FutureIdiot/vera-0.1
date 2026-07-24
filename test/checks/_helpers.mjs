// verify.mjs 黑盒端到端测试的共享工具（scripts/verify.mjs 与各 check 模块共用）。
// 独立于 src/ 业务代码，纯测试基础设施：HTTP / SSE 客户端、gateway 子进程
// 启停、断言、check 统计。零依赖 Node 20+ ESM。

import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createDaemonClient } from "../../src/agents/daemon-client.js";
import { createMockAdapter } from "../../src/adapters/mock-adapter.js";

const mockDaemons = new Set();

export async function stopMockDaemons() {
  const clients = [...mockDaemons];
  mockDaemons.clear();
  await Promise.allSettled(clients.map((client) => client.stop()));
}

export async function startTestDaemon({
  port,
  agentId,
  accountId,
  agentToken,
  accountKey,
  runtime,
  workspace,
  executor,
  memoryExecutor = null,
}) {
  const daemon = createDaemonClient({
    gatewayUrl: `http://127.0.0.1:${port}`,
    agentId,
    accountId,
    runtime,
    workspace,
    credentialStore: {
      async load() { return { agentToken, accountKey }; },
    },
    executor,
    memoryExecutor,
  });
  await daemon.start();
  mockDaemons.add(daemon);
  await sleep(25);
  return daemon;
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

export function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function fileExistsAt(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// 统计 + check 函数：各 check 模块通过 ctx.check(name, fn) 注册一项断言。
export function createCounter() {
  let passCount = 0;
  let failCount = 0;
  const failedNames = [];

  async function check(name, fn) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
      passCount += 1;
    } catch (err) {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err?.stack || err?.message || err}`);
      failCount += 1;
      failedNames.push(name);
    }
  }

  return {
    check,
    getPassCount: () => passCount,
    getFailCount: () => failCount,
    getFailedNames: () => failedNames,
  };
}

// 给定主端口，造一个 HTTP 请求客户端。portOverride 用于并行起的临时 gateway
// （k. 迁移测试、n.4 重启持久化测试）。
export function createHttpClient(defaultPort) {
  function httpRequest(method, path, body, portOverride) {
    return new Promise((resolve, reject) => {
      const usePort = portOverride ?? defaultPort;
      const payload = body !== undefined ? JSON.stringify(body) : null;
      const timeoutMs = 8000;
      const req = http.request(
        {
          host: "127.0.0.1",
          port: usePort,
          path,
          method,
          headers: payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (raw += chunk));
          res.on("end", () => {
            let json = null;
            if (raw) {
              try {
                json = JSON.parse(raw);
              } catch {
                json = raw;
              }
            }
            resolve({ status: res.statusCode, json });
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`${method} ${path} timed out after ${timeoutMs}ms`));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
  return httpRequest;
}

export function createBinaryHttpClient(defaultPort) {
  return async function binaryRequest(method, path, { headers = {}, body, portOverride } = {}) {
    const response = await fetch(`http://127.0.0.1:${portOverride ?? defaultPort}${path}`, {
      method,
      headers,
      body,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    let json = null;
    if ((response.headers.get("content-type") ?? "").includes("application/json") && buffer.length > 0) {
      json = JSON.parse(buffer.toString("utf8"));
    }
    return { status: response.status, headers: response.headers, buffer, json };
  };
}

export async function createOnlineMockAccount({ port, name }) {
  const hostId = `verify-${crypto.randomUUID()}`;
  async function jsonRequest(path, { method = "GET", headers = {}, body } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${JSON.stringify(json)}`);
    return json;
  }

  const created = await jsonRequest("/api/accounts", { method: "POST", body: { name } });
  const enrolled = await jsonRequest("/api/agent/enroll", {
    method: "POST",
    headers: { Authorization: `Bearer ${created.accessKey}` },
    body: {
      accountId: created.account.id,
      agent: { name: `${name} Agent` },
      runtimeProfile: { schemaVersion: 1, kind: "cli", provider: "mock", model: "mock-v1" },
    },
  });
  const runtime = {
    hostId,
    kind: "cli",
    provider: "mock",
    model: "mock-v1",
    revision: `sha256:${hostId}`,
    runtimeCapabilities: { models: ["mock-v1"], tools: [] },
  };
  const workspace = {
    hostId,
    path: `/tmp/${hostId}`,
    status: "ready",
    policy: { allow: ["read", "write"] },
  };
  const adapter = createMockAdapter({ chunkDelayMs: 150 });
  const daemon = await startTestDaemon({
    port,
    agentId: enrolled.agent.id,
    accountId: created.account.id,
    agentToken: enrolled.agentToken,
    accountKey: created.accessKey,
    runtime, workspace,
    executor: {
      execute(context) {
        return adapter.run({
          runtime,
          workspacePath: workspace.path,
          agent: context.agent,
          account: context.account,
          sessionMode: context.input.sessionMode,
          prompt: { text: context.input.promptText },
          providerBinding: context.input.providerBinding ?? null,
          spaceSessionId: context.run.spaceSessionId,
          agentSessionId: context.run.agentSessionId,
          contextGeneration: context.run.contextGeneration,
          signal: context.signal,
          onDelta: context.onDelta,
          onActivity: context.onActivity,
          requestApproval: context.requestApproval,
          persistProviderBinding: context.persistProviderBinding,
        });
      },
      shutdown: () => adapter.shutdown?.(),
    },
  });
  const detail = await jsonRequest(`/api/accounts/${created.account.id}`);
  return {
    agent: detail.ownerAgent,
    account: detail.account,
    agentToken: enrolled.agentToken,
    accountSession: { id: daemon.state.accountSessionId },
    daemon,
  };
}

export async function enrollDaemonIdentity({ port, name, runtimeProfile }) {
  async function request(path, { method = "GET", headers = {}, body } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${JSON.stringify(json)}`);
    return json;
  }
  const created = await request("/api/accounts", { method: "POST", body: { name } });
  const enrolled = await request("/api/agent/enroll", {
    method: "POST",
    headers: { Authorization: `Bearer ${created.accessKey}` },
    body: {
      accountId: created.account.id,
      agent: { name: `${name} Agent` },
      runtimeProfile,
    },
  });
  return {
    agent: enrolled.agent,
    account: enrolled.account,
    agentToken: enrolled.agentToken,
    accountKey: created.accessKey,
  };
}

// 打开一条真实 SSE 连接，逐帧解析为事件对象，累积在 .events；waitFor 等
// 满足条件的事件出现。
export function connectSse({ port, since } = {}) {
  return new Promise((resolve, reject) => {
    const path = since !== undefined && since !== null ? `/api/events?since=${since}` : "/api/events";
    const req = http.get(
      { host: "127.0.0.1", port, path, headers: { Accept: "text/event-stream" } },
      (res) => {
        let buffer = "";
        const events = [];
        const waiters = [];

        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            let envelope;
            try {
              envelope = JSON.parse(dataLine.slice("data: ".length));
            } catch {
              continue;
            }
            events.push(envelope);
            for (let i = waiters.length - 1; i >= 0; i -= 1) {
              if (waiters[i].predicate(envelope)) {
                waiters[i].resolve(envelope);
                waiters.splice(i, 1);
              }
            }
          }
        });

        const handle = {
          events,
          waitFor(predicate, timeoutMs = 5000) {
            const already = events.find(predicate);
            if (already) return Promise.resolve(already);
            return new Promise((res2, rej2) => {
              const timer = setTimeout(() => {
                const i = waiters.findIndex((w) => w.res2 === res2);
                if (i !== -1) waiters.splice(i, 1);
                rej2(new Error("timeout waiting for SSE event"));
              }, timeoutMs);
              waiters.push({
                res2,
                predicate,
                resolve: (env) => {
                  clearTimeout(timer);
                  res2(env);
                },
              });
            });
          },
          close() {
            req.destroy();
          },
        };
        resolve(handle);
      },
    );
    req.on("error", reject);
  });
}

export async function waitForHealth(port, timeoutMs = 8000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (resp.ok) {
        const json = await resp.json();
        if (json?.ok === true) return;
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(100);
  }
  throw new Error(`gateway did not become healthy in time: ${lastErr?.message ?? "unknown"}`);
}

// 起一个临时 gateway 子进程（mock adapter），用 passed env 覆盖默认。返回
// { child, port, stop() }。调用方负责手动 stop。
export async function startGateway({ repoRoot, env, cwd = repoRoot }) {
  const port = await getFreePort();
  const resolvedEnv = { ...env };
  if (resolvedEnv.VERA_ALLOW_LOOPBACK_DEVELOPMENT === undefined) {
    resolvedEnv.VERA_ALLOW_LOOPBACK_DEVELOPMENT = "true";
  }
  if (resolvedEnv.NODE_ENV === undefined) resolvedEnv.NODE_ENV = "test";
  if (resolvedEnv.VERA_DATA_PATH && !resolvedEnv.VERA_FILES_ATTACHMENTS_PATH) {
    resolvedEnv.VERA_FILES_ATTACHMENTS_PATH = join(resolvedEnv.VERA_DATA_PATH, "files");
  }
  if (resolvedEnv.VERA_DATA_PATH && !resolvedEnv.VERA_AGENT_TOKENS_PATH) {
    resolvedEnv.VERA_AGENT_TOKENS_PATH = join(resolvedEnv.VERA_DATA_PATH, "agent-tokens.json");
  }
  const child = spawn(process.execPath, [`${repoRoot}/src/server.js`], {
    cwd,
    env: { ...process.env, PORT: String(port), ...resolvedEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (d) => (output += d.toString()));
  child.stderr.on("data", (d) => (output += d.toString()));
  child.on("error", (err) => {
    console.error("failed to spawn gateway child process:", err);
  });
  child.__getOutput = () => output;

  try {
    await waitForHealth(port);
  } catch (err) {
    child.kill("SIGKILL");
    throw new Error(`${err.message}\ngateway output:\n${output}`);
  }

  async function stop() {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  return { child, port, stop };
}
