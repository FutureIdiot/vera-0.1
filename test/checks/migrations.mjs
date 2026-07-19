// k. v0 → v1 一次性迁移（Phase 4.1 启动迁移 + 4.4 seat 去 accountId 反迁移）。
// 两个 check 各自起独立 gateway 子进程，用预设 fixture 数据目录。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { waitForHealth } from "./_helpers.mjs";

async function killChild(child) {
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

export async function run(ctx) {
  const { check, httpRequest, assertEqual, assert, sleep, getFreePort, fileExistsAt, repoRoot } = ctx;

  await check("k. legacy -> federation 启动迁移：portable Agent profile、Account seat、session 键重映射", async () => {
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
        NODE_ENV: "test",
        PORT: String(migPort),
        VERA_DATA_PATH: migDataDir,
        VERA_MEMORY_VAULT_PATH: join(migDataDir, "memory"),
        VERA_ALLOW_LOOPBACK_DEVELOPMENT: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let migLog = "";
    migChild.stdout.on("data", (d) => (migLog += d.toString()));
    migChild.stderr.on("data", (d) => (migLog += d.toString()));

    try {
      await waitForHealth(migPort);
      assert(true, `migration gateway healthy: ${migLog}`);

      // bootstrap 后 agents/accounts/spaces 形状应满足新契约
      const bs = await httpRequest("GET", "/api/bootstrap", undefined, migPort);
      assertEqual(bs.status, 200);
      const legAgent = bs.json.agents[0];
      assertEqual(legAgent.id, AGENT_ID);
      assertEqual(JSON.stringify(legAgent.runtimeProfile), JSON.stringify({ schemaVersion: 1, kind: "cli", provider: "mock", model: "mock-v1" }));
      assert(!("runtimeBinding" in legAgent), "public Agent must not expose runtime binding");
      assertEqual(bs.json.accounts.length, 1, "exactly one owning account derived from legacy agent");
      const account = bs.json.accounts[0];
      assertEqual(account.ownerAgentId, AGENT_ID);
      assertEqual(account.activeAgentId, null);
      assert(!("provider" in account) && !("model" in account) && !("kind" in account));

      // Phase 5.5：Space 成员身份固定为 Account。
      const space = bs.json.spaces[0];
      assertEqual(space.id, SPACE_ID);
      assert(
        !("agentId" in space.seats[0]) && typeof space.seats[0].accountId === "string",
        "seat should carry Account identity only",
      );

      // Phase 5.5 runtime：迁移只保留历史绑定，不伪造在线daemon。
      // 未重新授权的Account保持offline，广播消息不会在gateway本地执行。
      const post = await httpRequest(
        "POST",
        `/api/spaces/${SPACE_ID}/messages`,
        { author: { type: "user" }, target: { type: "broadcast" }, content: "legacy continuity check" },
        migPort,
      );
      assertEqual(post.status, 201);
      assert(Array.isArray(post.json.runs) && post.json.runs.length === 0);

      // 旧 store.json 应已改名 .legacy（分文件形态已就位）
      const legacyStill = await fileExistsAt(legacyStorePath);
      const legacyRenamed = await fileExistsAt(`${legacyStorePath}.legacy`);
      assert(!legacyStill && legacyRenamed, "legacy store.json should be renamed to .legacy");
    } finally {
      await killChild(migChild);
      await rm(migDataDir, { recursive: true, force: true });
    }
  });

  await check("k. legacy 分文件 → federation：备份旧 agents/spaces/session-states 等分文件为 .legacy", async () => {
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
        NODE_ENV: "test",
        PORT: String(migPort),
        VERA_DATA_PATH: migDir,
        VERA_MEMORY_VAULT_PATH: join(migDir, "memory"),
        VERA_ALLOW_LOOPBACK_DEVELOPMENT: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let migLog = "";
    migChild.stdout.on("data", (d) => (migLog += d.toString()));
    migChild.stderr.on("data", (d) => (migLog += d.toString()));

    try {
      await waitForHealth(migPort);
      assert(true, `split migration gateway healthy: ${migLog}`);

      const bs = await httpRequest("GET", "/api/bootstrap", undefined, migPort);
      assertEqual(bs.status, 200);
      const legAgent = bs.json.agents[0];
      assertEqual(legAgent.id, AGENT_ID);
      assertEqual(JSON.stringify(legAgent.runtimeProfile), JSON.stringify({ schemaVersion: 1, kind: "cli", provider: "mock", model: "mock-v1" }));
      assert(!("runtimeBinding" in legAgent), "split public Agent must not expose runtime binding");
      assertEqual(bs.json.accounts.length, 1);
      const account = bs.json.accounts[0];
      assertEqual(account.ownerAgentId, AGENT_ID);
      assertEqual(account.activeAgentId, null);
      assert(!("agentId" in bs.json.spaces[0].seats[0]), "seat should not carry Agent identity");
      assert(typeof bs.json.spaces[0].seats[0].accountId === "string", "seat should carry Account identity");

      assert(await fileExistsAt(join(migDir, "agents.json.legacy")), "agents.json.legacy backup missing");
      assert(await fileExistsAt(join(migDir, "session-states.json.legacy")), "session-states.json.legacy backup missing");
      assert(await fileExistsAt(join(migDir, "spaces.json.legacy")), "spaces.json.legacy backup missing");

      const post = await httpRequest(
        "POST",
        `/api/spaces/${SPACE_ID}/messages`,
        { author: { type: "user" }, target: { type: "broadcast" }, content: "split continuity" },
        migPort,
      );
      assertEqual(post.status, 201);
      assert(post.json.runs.length === 0);
    } finally {
      await killChild(migChild);
      await rm(migDir, { recursive: true, force: true });
    }
  });
}
