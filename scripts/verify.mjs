#!/usr/bin/env node
// Phase 2 验收黑盒脚本（AGENTS.md / plan.md Phase 2 最后一项）。
//
// 零依赖 Node 20+ ESM：拉起一个用临时数据目录 + 空闲端口的 gateway 子进程
// （mock adapter），走真实 HTTP / SSE 对 docs/api-contract.md 的行为逐项断言。
// 每项输出 PASS/FAIL；全过退出码 0，否则非 0。结束时杀干净子进程、清临时数据。
//
// 用法：node scripts/verify.mjs
//
// 此后所有打工 agent 交活前必跑这个脚本（AGENTS.md 工作流程）。

import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

let passCount = 0;
let failCount = 0;
const failedNames = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function fileExistsAt(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// ---- 全局状态：子进程句柄、端口、临时目录、已开 SSE 连接（结束时统一清理）----
let child = null;
let port = null;
let dataDir = null;
const openSseHandles = [];

function httpRequest(method, path, body, portOverride) {
  return new Promise((resolve, reject) => {
    const usePort = portOverride ?? port;
    const payload = body !== undefined ? JSON.stringify(body) : null;
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
    if (payload) req.write(payload);
    req.end();
  });
}

// 打开一条真实 SSE 连接，逐帧解析 `id:`/`data:` 帧为事件对象，累积在 .events
// 里；.waitFor(predicate, timeoutMs) 等一个满足条件的事件出现（已到达的立即
// resolve，否则挂起等待，超时 reject）。
function connectSse({ since } = {}) {
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
            if (!dataLine) continue; // 保活注释帧 `: ping` 等，跳过
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
        openSseHandles.push(handle);
        resolve(handle);
      },
    );
    req.on("error", reject);
  });
}

async function waitForHealth(timeoutMs = 8000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const { status, json } = await httpRequest("GET", "/api/health");
      if (status === 200 && json?.ok === true) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(100);
  }
  throw new Error(`gateway did not become healthy in time: ${lastErr?.message ?? "unknown"}`);
}

async function startGateway() {
  port = await getFreePort();
  dataDir = await mkdtemp(join(tmpdir(), "vera-verify-"));

  child = spawn(process.execPath, [join(repoRoot, "src/server.js")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      // dataPath 语义是目录（store 按集合分文件），直接传临时目录
      VERA_DATA_PATH: dataDir,
      // 刻意调小缓冲（默认 2000）：一次 mock run 本身就有 ~12 个事件，缓冲
      // 太小会导致"干净重放"测试还没来得及验证就已经跨越缓冲触发 reset；
      // 20 足够放下单次 run 的事件（验证紧接着该 run 之后立即重放），又足够
      // 小到后面几轮 run 跑完后能可靠触发"缓冲滚过 -> stream.reset"。
      VERA_SSE_BUFFER_SIZE: "20",
      // 拉长 mock 的逐块延迟，给取消（cancel）测试留出足够窗口。
      VERA_MOCK_DELAY_MS: "150",
      VERA_MEMORY_VAULT_PATH: join(dataDir, "memory"), // 别读到真实 ~/.vera/memory
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (d) => (output += d.toString()));
  child.stderr.on("data", (d) => (output += d.toString()));
  child.on("error", (err) => {
    console.error("failed to spawn gateway child process:", err);
  });

  child.__getOutput = () => output;

  await waitForHealth();
}

async function stopGateway() {
  for (const handle of openSseHandles) {
    try {
      handle.close();
    } catch {
      /* ignore */
    }
  }
  if (child) {
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
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  await startGateway();

  // ---- a. /api/health 与 /api/bootstrap 响应形状 ----
  await check("a. GET /api/health returns { app, ok } shape", async () => {
    const { status, json } = await httpRequest("GET", "/api/health");
    assertEqual(status, 200);
    assertEqual(json.app, "vera");
    assertEqual(json.ok, true);
  });

  let bootstrap;
  await check("a. GET /api/bootstrap returns agents/accounts/spaces/agentStates/seq shape", async () => {
    const { status, json } = await httpRequest("GET", "/api/bootstrap");
    assertEqual(status, 200);
    assert(Array.isArray(json.agents), "agents should be an array");
    assert(Array.isArray(json.accounts), "accounts should be an array (4.1)");
    assert(Array.isArray(json.spaces), "spaces should be an array");
    assert(Array.isArray(json.agentStates), "agentStates should be an array");
    assert(typeof json.seq === "number", "seq should be a number");
    bootstrap = json;
  });

  // 从 bootstrap 时刻的 seq 开始订阅，这样后续所有实时事件都会被这条持久连接捕获。
  const sse = await connectSse({ since: bootstrap?.seq ?? 0 });

  // ---- b. Agent/Account 拆分（Phase 4.1）----
  // 契约（api-contract.md 4.1 修订）：Agent 只保留身份 {id,name,createdAt,updatedAt}；
  // 连接类字段（kind/provider/connection/model）落到自动派生的 owning account。
  let agent;
  let owningAccount;
  await check("b. POST /api/agents returns { agent, account } 并把连接字段从 agent 剥到 account", async () => {
    const { status, json } = await httpRequest("POST", "/api/agents", {
      name: "VerifyMock",
      kind: "cli",
      provider: "mock",
      connection: {},
      model: "mock-v1",
    });
    assertEqual(status, 201);
    assert(json.agent?.id?.startsWith("agt_"), "agent id should have agt_ prefix");
    // 4.1 收敛：agent 不再携带连接字段
    assert(
      !("kind" in json.agent) && !("provider" in json.agent) && !("connection" in json.agent) && !("model" in json.agent),
      "agent must not carry kind/provider/connection/model (4.1)",
    );
    assertEqual(json.agent.name, "VerifyMock");
    // connection 类字段应进 account
    assert(json.account?.id?.startsWith("acc_"), "account id should have acc_ prefix");
    assertEqual(json.account.owningAgentId, json.agent.id);
    assertEqual(json.account.kind, "cli");
    assertEqual(json.account.provider, "mock");
    assertEqual(json.account.model, "mock-v1");
    agent = json.agent;
    owningAccount = json.account;
  });

  await check("b. PATCH /api/agents/:id 只改 name，连接字段不走此接口", async () => {
    const { status, json } = await httpRequest("PATCH", `/api/agents/${agent.id}`, { name: "VerifyMock2", model: "ignored" });
    assertEqual(status, 200);
    assertEqual(json.agent.name, "VerifyMock2");
    assert(
      !("model" in json.agent) && !("provider" in json.agent),
      "PATCH /api/agents must not surface connection fields",
    );
    agent = json.agent;
  });

  await check("b. GET /api/accounts lists the auto-derived owning account", async () => {
    const { status, json } = await httpRequest("GET", "/api/accounts");
    assertEqual(status, 200);
    assert(Array.isArray(json.accounts));
    assert(json.accounts.some((a) => a.id === owningAccount.id), "owning account should be in the list");
  });

  await check("b. GET /api/accounts?agentId=... 按拥有者过滤", async () => {
    const { status, json } = await httpRequest("GET", `/api/accounts?agentId=${agent.id}`);
    assertEqual(status, 200);
    assertEqual(json.accounts.length, 1);
    assertEqual(json.accounts[0].owningAgentId, agent.id);
  });

  await check("b. PATCH /api/accounts/:id 改 model（换模型改 account 不改 agent 身份）", async () => {
    const { status, json } = await httpRequest("PATCH", `/api/accounts/${owningAccount.id}`, { model: "mock-v2" });
    assertEqual(status, 200);
    assertEqual(json.account.model, "mock-v2");
    assertEqual(json.account.id, owningAccount.id);
    owningAccount = json.account;
  });

  let secondAccount;
  await check("b. POST /api/agents/:id/accounts 为同一 agent 增加第二条 account", async () => {
    const { status, json } = await httpRequest("POST", `/api/agents/${agent.id}/accounts`, {
      name: "VerifyMock 第二账户",
      kind: "cli",
      provider: "mock",
      connection: {},
      model: "",
    });
    assertEqual(status, 201);
    assert(json.account?.id?.startsWith("acc_"));
    assert(json.account.id !== owningAccount.id, "second account must be a different id");
    assertEqual(json.account.owningAgentId, agent.id);
    secondAccount = json.account;
  });

  await check("b. DELETE /api/accounts/:id 不可删唯一 owning account（409），删多余 account 成功（204）", async () => {
    // 先删第二个（agent 名下还有 owning 共两条，应成功）
    const delSecond = await httpRequest("DELETE", `/api/accounts/${secondAccount.id}`);
    assertEqual(delSecond.status, 204);
    // 再删唯一剩的 owning account，应当 409 拒绝
    const sole = await httpRequest("DELETE", `/api/accounts/${owningAccount.id}`);
    assertEqual(sole.status, 409);
    assertEqual(sole.json.error.code, "conflict");
  });

  await check("b. 多 agent 同 Space 共享同一 account：外部会话随 account 走不随 agent 走", async () => {
    // 建第二个 agent，再开一个 Space：seatA 是 agent（用 owningAccount），seatB 是
    // agent2 驾驶同一个 owningAccount（开别人的账户做别人的项目，ground truth 2.2）。
    // 一次 broadcast 触发两 run，都用 owningAccount → 共享同一条 (account, Space)
    // sessionState → mock counter 必须接龙递增，证明 session 键已从 (agentId,spaceId)
    // 改为 (accountId,spaceId)。
    const agent2Resp = await httpRequest("POST", "/api/agents", {
      name: "VerifyMock2b",
      kind: "cli",
      provider: "mock",
      connection: {},
      model: "mock-spare",
    });
    assertEqual(agent2Resp.status, 201);
    const agent2 = agent2Resp.json.agent;

    const spaceResp = await httpRequest("POST", "/api/spaces", {
      name: "driving-space",
      seats: [
        { agentId: agent.id, accountId: owningAccount.id, responseMode: "default" },
        { agentId: agent2.id, accountId: owningAccount.id, responseMode: "default" },
      ],
    });
    assertEqual(spaceResp.status, 201);
    const driveSpace = spaceResp.json.space;

    const post = await httpRequest("POST", `/api/spaces/${driveSpace.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "driving continuity check",
    });
    assertEqual(post.status, 201);
    assertEqual(post.json.runs.length, 2, "two seats both default mode -> two runs");

    // 等两个 run 都结束，把它们的 reply Message 内容拼起来
    const runIds = post.json.runs.map((r) => r.id);
    const waitOne = (rid) => sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === rid, 10000);
    const [end1, end2] = await Promise.all(runIds.map(waitOne));
    assertEqual(end1.data.run.status, "completed");
    assertEqual(end2.data.run.status, "completed");

    const allReplies = sse.events
      .filter((e) => e.type === "message.completed" && [end1, end2].some((en) => en.data.run.replyMessageIds.includes(e.data.message.id)))
      .map((e) => e.data.message.content)
      .join(" ");
    assert(/回声第 1 次/.test(allReplies) && /回声第 2 次/.test(allReplies), `expected mock counter to chain 1->2 across both runs sharing one account; got: ${allReplies}`);
  });

  // ---- c. Space 创建与 seats ----
  let space;
  await check("c. POST /api/spaces creates space with agent seated", async () => {
    const { status, json } = await httpRequest("POST", "/api/spaces", {
      name: "verify-space",
      topic: "verify.mjs 黑盒验收",
      seats: [{ agentId: agent.id, responseMode: "default" }],
    });
    assertEqual(status, 201);
    assert(json.space?.id?.startsWith("spc_"), "space id should have spc_ prefix");
    assertEqual(json.space.seats.length, 1);
    assertEqual(json.space.seats[0].agentId, agent.id);
    assertEqual(json.space.seats[0].responseMode, "default");
    space = json.space;
  });

  // ---- d. POST messages -> 201 带 message + runs ----
  let firstRunId;
  await check("d. POST /api/spaces/:id/messages returns 201 with message + runs", async () => {
    const { status, json } = await httpRequest("POST", `/api/spaces/${space.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "hello agent",
    });
    assertEqual(status, 201);
    assert(json.message?.id?.startsWith("msg_"), "message id should have msg_ prefix");
    assert(Array.isArray(json.runs) && json.runs.length === 1, "expected exactly one run for the seated agent");
    assert(json.runs[0].id.startsWith("run_"), "run id should have run_ prefix");
    firstRunId = json.runs[0].id;
  });

  // ---- e. SSE 全链路顺序 + 多气泡 ----
  let firstRunStartedSeq;
  await check("e. SSE run.started -> message.created(streaming) -> delta -> completed -> run.ended order", async () => {
    const runStarted = await sse.waitFor((e) => e.type === "run.started" && e.data.run.id === firstRunId, 5000);
    const runEnded = await sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === firstRunId, 10000);
    assertEqual(runEnded.data.run.status, "completed");
    firstRunStartedSeq = runStarted.seq;

    const related = sse.events.filter((e) => e.seq >= runStarted.seq && e.seq <= runEnded.seq);
    const types = related.map((e) => e.type);

    const idxRunStarted = types.indexOf("run.started");
    const idxMessageCreated = types.indexOf("message.created");
    const idxMessageDelta = types.indexOf("message.delta");
    const idxMessageCompleted = types.indexOf("message.completed");
    const idxRunEnded = types.indexOf("run.ended");

    assert(idxRunStarted !== -1 && idxMessageCreated !== -1 && idxMessageDelta !== -1 && idxMessageCompleted !== -1 && idxRunEnded !== -1, `missing expected event types in: ${JSON.stringify(types)}`);
    assert(idxRunStarted < idxMessageCreated, "run.started must precede message.created");
    assert(idxMessageCreated < idxMessageDelta, "message.created must precede message.delta");
    assert(idxMessageDelta < idxMessageCompleted, "message.delta must precede message.completed");
    assert(idxMessageCompleted < idxRunEnded, "message.completed must precede run.ended");

    const firstCreated = related.find((e) => e.type === "message.created");
    assertEqual(firstCreated.data.message.status, "streaming", "first bubble should be created as streaming");

    const completedCount = related.filter((e) => e.type === "message.completed").length;
    assert(completedCount >= 2, `expected >=2 message.completed bubbles (mock replies with two paragraphs), got ${completedCount}`);
  });

  await check("b. DELETE /api/agents/:id rejected once agent has message history (409)", async () => {
    const { status, json } = await httpRequest("DELETE", `/api/agents/${agent.id}`);
    assertEqual(status, 409);
    assertEqual(json.error.code, "conflict");
  });

  // ---- f. seq 单调 / since 重放（其余部分：见文末 "since 超出缓冲 -> reset"）----
  await check("f. seq is strictly monotonic across all captured events", async () => {
    for (let i = 1; i < sse.events.length; i += 1) {
      assert(sse.events[i].seq > sse.events[i - 1].seq, `seq must strictly increase at index ${i}`);
    }
  });

  await check("f. reconnect with ?since=<seq> replays only missed events", async () => {
    // 用第一个 run 的 run.started 作为书签，紧接着该 run 结束后立即重放：
    // 此时距 since 只过去了这一个 run 的事件量（远小于 VERA_SSE_BUFFER_SIZE=20），
    // 保证命中"干净重放"分支而不是"缓冲已滚过 -> reset"分支。
    assert(typeof firstRunStartedSeq === "number", "firstRunStartedSeq must be captured by the 'e.' check above");
    const expected = sse.events.filter((e) => e.seq > firstRunStartedSeq).length;

    const replaySse = await connectSse({ since: firstRunStartedSeq });
    await sleep(300);
    assert(replaySse.events.length >= expected, `expected replay to include >= ${expected} events, got ${replaySse.events.length}`);
    assert(replaySse.events.every((e) => e.seq > firstRunStartedSeq), "replay must only include events after since");
    assert(!replaySse.events.some((e) => e.type === "stream.reset"), "clean replay should not contain stream.reset");
    replaySse.close();
  });

  // ---- g. 会话连续性 ----
  await check("g. sessionState counter increments across successive messages", async () => {
    const { status, json } = await httpRequest("POST", `/api/spaces/${space.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "second message",
    });
    assertEqual(status, 201);
    const runId = json.runs[0].id;
    const runEnded = await sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === runId, 10000);
    assertEqual(runEnded.data.run.status, "completed");
    const replyIds = runEnded.data.run.replyMessageIds;
    const combined = sse.events
      .filter((e) => e.type === "message.completed" && replyIds.includes(e.data.message.id))
      .map((e) => e.data.message.content)
      .join(" ");
    assert(/回声第 2 次/.test(combined), `expected mock counter at 2 in reply, got: ${combined}`);
  });

  // ---- h. 触发词：!!error / !!approve ----
  await check("h. '!!error' trigger word ends run failed with error.code", async () => {
    const { status, json } = await httpRequest("POST", `/api/spaces/${space.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "please !!error now",
    });
    assertEqual(status, 201);
    const runId = json.runs[0].id;
    const runEnded = await sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === runId, 10000);
    assertEqual(runEnded.data.run.status, "failed");
    assert(runEnded.data.run.error?.code === "provider_error", `expected error.code provider_error, got ${JSON.stringify(runEnded.data.run.error)}`);
  });

  let approvalId;
  let approveRunId;
  await check("h. '!!approve' trigger word raises approval.requested", async () => {
    const { status, json } = await httpRequest("POST", `/api/spaces/${space.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "deploy it !!approve",
    });
    assertEqual(status, 201);
    approveRunId = json.runs[0].id;
    const requested = await sse.waitFor((e) => e.type === "approval.requested" && e.data.approval.runId === approveRunId, 10000);
    assertEqual(requested.data.approval.status, "pending");
    assert(Array.isArray(requested.data.approval.options) && requested.data.approval.options.includes("allow"));
    approvalId = requested.data.approval.id;
  });

  await check("h. POST /api/approvals/:id/answer resolves the approval (allow)", async () => {
    const { status, json } = await httpRequest("POST", `/api/approvals/${approvalId}/answer`, { answer: "allow" });
    assertEqual(status, 200);
    assertEqual(json.approval.status, "answered");
    assertEqual(json.approval.answer, "allow");
    // 让 run 跑完，避免和后面的 cancel 测试互相干扰。
    await sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === approveRunId, 10000);
  });

  await check("h. repeated answer on the same approval returns 409 conflict", async () => {
    const { status, json } = await httpRequest("POST", `/api/approvals/${approvalId}/answer`, { answer: "deny" });
    assertEqual(status, 409);
    assertEqual(json.error.code, "conflict");
  });

  // ---- i. 取消在飞 run ----
  await check("i. POST /api/runs/:id/cancel cancels an in-flight run", async () => {
    const { status, json } = await httpRequest("POST", `/api/spaces/${space.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "long running task for cancel test",
    });
    assertEqual(status, 201);
    const runId = json.runs[0].id;

    // 给 run 一点时间真正进入飞行状态（mock 的逐块延迟被拉长到 150ms，足够留窗口）。
    await sleep(50);
    const cancelResp = await httpRequest("POST", `/api/runs/${runId}/cancel`, {});
    assertEqual(cancelResp.status, 200);

    const runEnded = await sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === runId, 10000);
    assertEqual(runEnded.data.run.status, "cancelled");
  });

  await check("f. since beyond ring buffer triggers stream.reset", async () => {
    // 到这里已经跑完 5 个 run（e/g/h-error/h-approve/i-cancel），累计事件数
    // 远超 VERA_SSE_BUFFER_SIZE=20，since=0 必然已经滚出缓冲区，gateway 必须
    // 发 stream.reset 而不是静默重放/丢弃。
    const resetSse = await connectSse({ since: 0 });
    await sleep(300);
    const hasReset = resetSse.events.some((e) => e.type === "stream.reset");
    assert(hasReset, `expected a stream.reset frame, got types: ${JSON.stringify(resetSse.events.map((e) => e.type))}`);
    resetSse.close();
  });

  // ---- j. timeline 分页 + 三种 itemType ----
  await check("j. GET timeline includes message/activity/approval itemTypes", async () => {
    const { status, json } = await httpRequest("GET", `/api/spaces/${space.id}/timeline?limit=500`);
    assertEqual(status, 200);
    assert(Array.isArray(json.items), "timeline response should have items array");
    const types = new Set(json.items.map((i) => i.itemType));
    assert(types.has("message"), `expected a message itemType, got types: ${[...types]}`);
    assert(types.has("activity"), `expected an activity itemType, got types: ${[...types]}`);
    assert(types.has("approval"), `expected an approval itemType, got types: ${[...types]}`);
  });

  await check("j. GET timeline before/limit pagination does not repeat items", async () => {
    const page1 = await httpRequest("GET", `/api/spaces/${space.id}/timeline?limit=3`);
    assertEqual(page1.status, 200);
    assertEqual(page1.json.items.length, 3, "first page should have exactly `limit` items");
    const cursor = page1.json.items[page1.json.items.length - 1].id;

    const page2 = await httpRequest("GET", `/api/spaces/${space.id}/timeline?before=${cursor}&limit=3`);
    assertEqual(page2.status, 200);
    const page1Ids = new Set(page1.json.items.map((i) => i.id));
    for (const item of page2.json.items) {
      assert(!page1Ids.has(item.id), `page2 item ${item.id} should not repeat page1`);
    }
  });

  // ---- k. v0 → v1 一次性迁移（Phase 4.1 启动迁移）----
  // 旧 agent 记录里内嵌 kind/provider/connection/model；store 启动时拆出派生
  // owning account、session-states 键 ${agentId}:${spaceId} 重映射为
  // ${accountId}:${spaceId}。旧文件留 .legacy，幂等（api-contract.md
  // 「v0/v1 兼容说明」）。
  await check("k. v0 -> v1 启动迁移：agent 连接字段拆到 account、session-states 键重映射", async () => {
    const migDataDir = await mkdtemp(join(tmpdir(), "vera-migrate-"));
    const legacyStorePath = join(migDataDir, "store.json");
    const AGENT_ID = "agt_legacy01";
    const SPACE_ID = "spc_legacy01";
    const ISO = "2026-06-01T00:00:00.000Z";
    const legacyPayload = {
      _seq: 42,
      eventSeqWatermark: 0,
      agents: [
        {
          id: AGENT_ID,
          name: "Legacy",
          createdAt: ISO,
          updatedAt: ISO,
          kind: "cli",
          provider: "mock",
          connection: { command: "/bin/true" },
          model: "mock-v1",
        },
      ],
      spaces: [
        {
          id: SPACE_ID,
          name: "legacy space",
          topic: "",
          createdAt: ISO,
          seats: [{ agentId: AGENT_ID, responseMode: "default" }],
        },
      ],
      messages: [],
      activities: [],
      approvals: [],
      runs: [],
      sessionStates: { [`${AGENT_ID}:${SPACE_ID}`]: { count: 7 } },
    };
    await writeFile(legacyStorePath, JSON.stringify(legacyPayload, null, 2), "utf8");

    const migPort = await getFreePort();
    const migChild = spawn(process.execPath, [join(repoRoot, "src/server.js")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(migPort),
        VERA_DATA_PATH: migDataDir,
        VERA_MEMORY_VAULT_PATH: join(migDataDir, "memory"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let migLog = "";
    migChild.stdout.on("data", (d) => (migLog += d.toString()));
    migChild.stderr.on("data", (d) => (migLog += d.toString()));

    try {
      // 等健康
      const start = Date.now();
      let healthy = false;
      while (Date.now() - start < 8000) {
        try {
          const { status, json } = await httpRequest("GET", "/api/health", undefined, migPort);
          if (status === 200 && json?.ok) {
            healthy = true;
            break;
          }
        } catch {
          /* keep polling */
        }
        await sleep(100);
      }
      assert(healthy, `migration gateway did not become healthy: ${migLog}`);

      // bootstrap 后 agents/accounts/spaces 形状应满足新契约
      const bs = await httpRequest("GET", "/api/bootstrap", undefined, migPort);
      assertEqual(bs.status, 200);
      const legAgent = bs.json.agents[0];
      assertEqual(legAgent.id, AGENT_ID);
      assert(
        !("kind" in legAgent) &&
          !("provider" in legAgent) &&
          !("connection" in legAgent) &&
          !("model" in legAgent),
        "legacy agent must be stripped of connection fields",
      );
      assertEqual(bs.json.accounts.length, 1, "exactly one owning account derived from legacy agent");
      const account = bs.json.accounts[0];
      assertEqual(account.owningAgentId, AGENT_ID);
      assertEqual(account.provider, "mock");
      assertEqual(account.model, "mock-v1");
      assertEqual(account.kind, "cli");

      // seat.accountId 应被回填为派生 account 的 id
      const space = bs.json.spaces[0];
      assertEqual(space.id, SPACE_ID);
      assertEqual(space.seats[0].accountId, account.id, "seat.accountId should backfill to derived owning account");

      // session-states 键重映射：post 消息后 mock 计数器应从 7 续到 8
      const post = await httpRequest(
        "POST",
        `/api/spaces/${SPACE_ID}/messages`,
        { author: { type: "user" }, target: { type: "broadcast" }, content: "legacy continuity check" },
        migPort,
      );
      assertEqual(post.status, 201);
      assert(Array.isArray(post.json.runs) && post.json.runs.length === 1);

      let legacyMsg = null;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const tl = await httpRequest("GET", `/api/spaces/${SPACE_ID}/timeline?limit=50`, undefined, migPort);
        const found = tl.json.items.find(
          (i) => i.itemType === "message" && i.runId === post.json.runs[0].id && i.author?.type === "agent",
        );
        if (found && found.status === "completed") {
          legacyMsg = found;
          break;
        }
        await sleep(100);
      }
      assert(legacyMsg, "legacy run did not complete in time");
      assert(
        /回声第 8 次/.test(legacyMsg.content),
        `expected mock counter to continue from 7 -> 8 after remap, got: ${legacyMsg.content}`,
      );

      // 旧 store.json 应已改名 .legacy（分文件形态已就位）
      const legacyStill = await fileExistsAt(legacyStorePath);
      const legacyRenamed = await fileExistsAt(`${legacyStorePath}.legacy`);
      assert(!legacyStill && legacyRenamed, "legacy store.json should be renamed to .legacy");
    } finally {
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          migChild.kill("SIGKILL");
          resolve();
        }, 2000);
        migChild.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
        migChild.kill("SIGTERM");
      });
      await rm(migDataDir, { recursive: true, force: true });
    }
  });

  await check("k. v0 分文件 → v1 启动迁移：备份旧 agents/spaces/session-states 等分文件为 .legacy", async () => {
    // 真实生产路径：Phase 2 起就用分文件 data/，但旧 agents.json 还内嵌
    // kind/provider/connection/model。4.1 binary 启动应检测到、备份分文件为
    // .legacy（可回滚）、改写为 v1 形态（agent 已收口 + 派生 account + 重映射
    // session-states + seat.accountId 回填）。
    const migDir = await mkdtemp(join(tmpdir(), "vera-migrate-split-"));
    const AGENT_ID = "agt_split01";
    const SPACE_ID = "spc_split01";
    const ISO = "2026-06-01T00:00:00.000Z";
    const splitFiles = {
      "agents.json": [
        {
          id: AGENT_ID,
          name: "SplitLegacy",
          createdAt: ISO,
          updatedAt: ISO,
          kind: "cli",
          provider: "mock",
          connection: { command: "/bin/true" },
          model: "mock-v1",
        },
      ],
      "accounts.json": [],
      "spaces.json": [
        {
          id: SPACE_ID,
          name: "split space",
          topic: "",
          createdAt: ISO,
          seats: [{ agentId: AGENT_ID, responseMode: "default" }],
        },
      ],
      "session-states.json": { [`${AGENT_ID}:${SPACE_ID}`]: { count: 3 } },
      "meta.json": { _seq: 9, eventSeqWatermark: 0 },
      "messages.json": [],
      "activities.json": [],
      "approvals.json": [],
      "runs.json": [],
    };
    for (const [name, content] of Object.entries(splitFiles)) {
      await writeFile(join(migDir, name), JSON.stringify(content, null, 2), "utf8");
    }

    const migPort = await getFreePort();
    const migChild = spawn(process.execPath, [join(repoRoot, "src/server.js")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(migPort),
        VERA_DATA_PATH: migDir,
        VERA_MEMORY_VAULT_PATH: join(migDir, "memory"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let migLog = "";
    migChild.stdout.on("data", (d) => (migLog += d.toString()));
    migChild.stderr.on("data", (d) => (migLog += d.toString()));

    try {
      const start = Date.now();
      let healthy = false;
      while (Date.now() - start < 8000) {
        try {
          const { status, json } = await httpRequest("GET", "/api/health", undefined, migPort);
          if (status === 200 && json?.ok) {
            healthy = true;
            break;
          }
        } catch {
          /* keep polling */
        }
        await sleep(100);
      }
      assert(healthy, `split migration gateway did not become healthy: ${migLog}`);

      const bs = await httpRequest("GET", "/api/bootstrap", undefined, migPort);
      assertEqual(bs.status, 200);
      // agent 收口
      const legAgent = bs.json.agents[0];
      assertEqual(legAgent.id, AGENT_ID);
      assert(
        !("kind" in legAgent) && !("provider" in legAgent) && !("connection" in legAgent) && !("model" in legAgent),
        "split legacy agent must be stripped",
      );
      // account 派生
      assertEqual(bs.json.accounts.length, 1);
      const account = bs.json.accounts[0];
      assertEqual(account.owningAgentId, AGENT_ID);
      assertEqual(account.provider, "mock");
      assertEqual(account.model, "mock-v1");
      // seat.accountId 回填
      assertEqual(bs.json.spaces[0].seats[0].accountId, account.id);

      // 分文件被备份为 .legacy（agents / accounts / spaces / session-states / meta）
      assert(await fileExistsAt(join(migDir, "agents.json.legacy")), "agents.json.legacy backup missing");
      assert(await fileExistsAt(join(migDir, "session-states.json.legacy")), "session-states.json.legacy backup missing");
      assert(await fileExistsAt(join(migDir, "spaces.json.legacy")), "spaces.json.legacy backup missing");

      // session-states 已重映射到 acc_xxx:spc 一侧：post 消息跑一次 run，counter 从 3 -> 4
      const post = await httpRequest(
        "POST",
        `/api/spaces/${SPACE_ID}/messages`,
        { author: { type: "user" }, target: { type: "broadcast" }, content: "split continuity" },
        migPort,
      );
      assertEqual(post.status, 201);
      assert(post.json.runs.length === 1);

      let legacyMsg = null;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const tl = await httpRequest("GET", `/api/spaces/${SPACE_ID}/timeline?limit=50`, undefined, migPort);
        const found = tl.json.items.find(
          (i) => i.itemType === "message" && i.runId === post.json.runs[0].id && i.author?.type === "agent",
        );
        if (found && found.status === "completed") {
          legacyMsg = found;
          break;
        }
        await sleep(100);
      }
      assert(legacyMsg, "split legacy run did not complete in time");
      assert(/回声第 4 次/.test(legacyMsg.content), `expected counter continue 3 -> 4; got: ${legacyMsg.content}`);
    } finally {
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          migChild.kill("SIGKILL");
          resolve();
        }, 2000);
        migChild.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
        migChild.kill("SIGTERM");
      });
      await rm(migDir, { recursive: true, force: true });
    }
  });

  console.log("");
  console.log(`${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    console.log(`Failed: ${failedNames.join(", ")}`);
  }
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error("verify.mjs crashed before completing all checks:");
  console.error(err?.stack || err);
  exitCode = 1;
} finally {
  try {
    await stopGateway();
  } catch (err) {
    console.error("cleanup failed:", err?.stack || err);
  }
}

if (failCount > 0) exitCode = 1;
process.exit(exitCode);
