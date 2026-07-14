#!/usr/bin/env node
// 黑盒端到端验收脚本（AGENTS.md / plan.md Phase 2 最后一项）。
//
// 零依赖 Node 20+ ESM：拉起一个用临时数据目录 + 空闲端口的 gateway 子进程
// （mock adapter），走真实 HTTP / SSE 对 docs/api-contract.md 的行为逐项断言。
// 每项输出 PASS/FAIL；全过退出码 0，否则非 0。结束时杀干净子进程、清临时数据。
//
// 用法：node scripts/verify.mjs
//
// 各 check 段拆进 test/checks/*.mjs（按 API 实体分组）：health-bootstrap /
// agent-account / space-messages / sse-flow / triggers / migrations /
// speaker-view / response-rules / settings。本文件只保留基础设施 + 按依赖序
// 顺序调用各 check 段——共享状态经 ctx 对象传递。

import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  assert,
  assertEqual,
  sleep,
  getFreePort,
  fileExistsAt,
  createCounter,
  createHttpClient,
  connectSse,
  startGateway,
} from "../test/checks/_helpers.mjs";

import * as healthBootstrap from "../test/checks/health-bootstrap.mjs";
import * as agentAccount from "../test/checks/agent-account.mjs";
import * as spaceMessages from "../test/checks/space-messages.mjs";
import * as sseFlow from "../test/checks/sse-flow.mjs";
import * as triggers from "../test/checks/triggers.mjs";
import * as migrations from "../test/checks/migrations.mjs";
import * as speakerView from "../test/checks/speaker-view.mjs";
import * as responseRules from "../test/checks/response-rules.mjs";
import * as settings from "../test/checks/settings.mjs";
import * as f1Extensions from "../test/checks/f1-extensions.mjs";
import * as pathMigrations from "../test/checks/path-migrations.mjs";
import * as f3WebCore from "../test/checks/f3-web-core.mjs";
import * as f4WebManagement from "../test/checks/f4-web-management.mjs";
import * as memoryDigest from "../test/checks/memory-digest.mjs";
import * as ollamaAdapter from "../test/checks/ollama-adapter.mjs";
import * as codexAdapter from "../test/checks/codex-adapter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const counter = createCounter();
const openSseHandles = [];
let dataDir = null;
let primaryGateway = null; // 主 gateway：a–m 都在它上面跑（n 也用它的 /api/settings）

async function startPrimaryGateway() {
  dataDir = await mkdtemp(join(tmpdir(), "vera-verify-"));
  primaryGateway = await startGateway({
    repoRoot,
    env: {
      VERA_DATA_PATH: dataDir,
      // 刻意调小缓冲（默认 2000）：一次 mock run ~12 个事件，清理重放测试需要
      // 紧接其后立即重放能命中"干净重放"分支，后续几轮 run 跑完后能触发
      // "缓冲滚过 → stream.reset"。
      VERA_SSE_BUFFER_SIZE: "20",
      VERA_MOCK_DELAY_MS: "150",
      VERA_MEMORY_VAULT_PATH: join(dataDir, "memory"),
    },
  });
}

async function stopPrimaryGateway() {
  for (const handle of openSseHandles) {
    try {
      handle.close();
    } catch {
      /* ignore */
    }
  }
  if (primaryGateway) await primaryGateway.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}

async function main() {
  await startPrimaryGateway();
  const port = primaryGateway.port;
  const httpRequest = createHttpClient(port);

  // 共享可变状态：每段 check 段读它前一段写的字段，往下一段又读它需要的。
  const ctx = {
    // 基础设施
    check: counter.check,
    assert,
    assertEqual,
    sleep,
    getFreePort,
    fileExistsAt,
    httpRequest,
    // connectSse helper：统一把打开的 handle 注册进 openSseHandles 以便
    // cleanup。下面在 ctx 建好后赋值（避免引用尚未声明的 const）。
    openSseHandles,
    port,
    repoRoot,
    dataDir,
    // 共享业务状态
    bootstrap: null,
    sse: null,
    agent: null,
    owningAccount: null,
    space: null,
    firstRunId: null,
    firstRunStartedSeq: null,
    approvalId: null,
    approveRunId: null,
    hApproveSpace: null,
  };
  ctx.connectSse = async ({ since } = {}) => {
    const handle = await connectSse({ port, since });
    openSseHandles.push(handle);
    return handle;
  };

  // 按依赖序执行各 check 段：
  await healthBootstrap.run(ctx); // a. (建 ctx.bootstrap / ctx.sse)
  await agentAccount.run(ctx); // b. (建 ctx.agent / ctx.owningAccount)
  await spaceMessages.run(ctx); // c. + d. (建 ctx.space / ctx.firstRunId)
  await sseFlow.run(ctx); // e. + f. monotonic/replay
  await triggers.run(ctx); // g. + h. + i. + j.（顺序内含使用 ctx.agent / ctx.space）
  // b. "DELETE /api/agents/:id (409)" 依赖 agent 已有消息历史，得在 e. 跑过后：
  await agentAccount.runDeleteAgentAfterHistory(ctx);
  // f-beyond-buffer 得在 verify-space 跑过数轮 run、累计事件远超缓冲大小后：
  await sseFlow.runSinceBeyondBuffer(ctx);
  // k. 独立子 gateway 跑迁移测试：
  await migrations.run(ctx);
  // l./m./n. 各自独立场景
  await speakerView.run(ctx);
  await responseRules.run(ctx);
  await settings.run(ctx);
  await memoryDigest.run(ctx);
  await ollamaAdapter.run(ctx);
  await codexAdapter.run(ctx);
  await codexAdapter.runReal(ctx);
  await f1Extensions.run(ctx);
  await f3WebCore.run(ctx);
  await f4WebManagement.run(ctx);
  await pathMigrations.run(ctx);

  console.log("");
  console.log(`${counter.getPassCount()} passed, ${counter.getFailCount()} failed`);
  if (counter.getFailCount() > 0) {
    console.log(`Failed: ${counter.getFailedNames().join(", ")}`);
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
    await stopPrimaryGateway();
  } catch (err) {
    console.error("cleanup failed:", err?.stack || err);
  }
}

if (counter.getFailCount() > 0) exitCode = 1;
process.exit(exitCode);
