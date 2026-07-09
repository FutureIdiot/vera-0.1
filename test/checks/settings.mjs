// n. 系统配置（Phase 4.5）：GET/PATCH /api/settings + 字段白名单校验 + 重启持久化。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { waitForHealth } from "./_helpers.mjs";

async function killChild(child) {
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

export async function run(ctx) {
  const { check, httpRequest, assertEqual, assert, sleep, getFreePort, repoRoot } = ctx;

  await check("n.1 GET /api/settings 返回合并视图含所有白名单 key + 默认值", async () => {
    const { status, json } = await httpRequest("GET", "/api/settings");
    assertEqual(status, 200);
    const s = json.settings;
    assertEqual(typeof s, "object");
    assert(!Array.isArray(s), "settings should be an object not array");
    const expectedKeys = [
      "isolation.memory",
      "isolation.files",
      "isolation.agentState",
      "memory.digestTrigger",
      "memory.digestSchedule",
      "memory.injectionBudgetResidentLines",
      "presentation.bubbleBoundaryPattern",
      "presentation.bubbleMinLength",
      "presentation.bubbleMaxLength",
    ];
    for (const key of expectedKeys) {
      assert(Object.prototype.hasOwnProperty.call(s, key), `settings should include key ${key}`);
    }
    assertEqual(s["isolation.memory"], "isolated");
    assertEqual(s["isolation.files"], "isolated");
    assertEqual(s["isolation.agentState"], "globalVisible");
    assertEqual(s["memory.digestTrigger"], "scheduled");
    assertEqual(s["memory.digestSchedule"], "0 3 * * *");
    assertEqual(s["memory.injectionBudgetResidentLines"], 25);
    assertEqual(s["presentation.bubbleBoundaryPattern"], "\\n\\s*\\n");
    assertEqual(s["presentation.bubbleMinLength"], 1);
    assertEqual(s["presentation.bubbleMaxLength"], 800);
  });

  await check("n.2 PATCH 部分覆盖 enum 字段 -> 200 且后续 GET 反映新值", async () => {
    const patch = await httpRequest("PATCH", "/api/settings", {
      settings: { "isolation.memory": "globalReadable" },
    });
    assertEqual(patch.status, 200);
    assertEqual(patch.json.settings["isolation.memory"], "globalReadable");
    assertEqual(patch.json.settings["isolation.files"], "isolated");

    const get = await httpRequest("GET", "/api/settings");
    assertEqual(get.status, 200);
    assertEqual(get.json.settings["isolation.memory"], "globalReadable");
  });

  await check("n.3 PATCH 未知 key -> 400 invalid_request；enum 无效值 -> 400；无副作用", async () => {
    const unknown = await httpRequest("PATCH", "/api/settings", {
      settings: { "not.a.real.key": "whatever" },
    });
    assertEqual(unknown.status, 400);
    assertEqual(unknown.json.error.code, "invalid_request");

    const badEnum = await httpRequest("PATCH", "/api/settings", {
      settings: { "isolation.memory": "bogusValue" },
    });
    assertEqual(badEnum.status, 400);
    assertEqual(badEnum.json.error.code, "invalid_request");

    const badNumber = await httpRequest("PATCH", "/api/settings", {
      settings: { "presentation.bubbleMaxLength": "not-a-number" },
    });
    assertEqual(badNumber.status, 400);
    assertEqual(badNumber.json.error.code, "invalid_request");

    const badShape = await httpRequest("PATCH", "/api/settings", {
      notSettings: { "isolation.memory": "globalReadable" },
    });
    assertEqual(badShape.status, 400);
    assertEqual(badShape.json.error.code, "invalid_request");

    const get = await httpRequest("GET", "/api/settings");
    assertEqual(get.json.settings["isolation.memory"], "globalReadable");
  });

  await check("n.4 重启 gateway 后 setting 仍存在（settings.json 防抖落盘）", async () => {
    const migDir = await mkdtemp(join(tmpdir(), "vera-settings-persist-"));
    const migPort1 = await getFreePort();
    const child1 = spawn(process.execPath, [join(repoRoot, "src/server.js")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(migPort1),
        VERA_DATA_PATH: migDir,
        VERA_MEMORY_VAULT_PATH: join(migDir, "memory"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log1 = "";
    child1.stdout.on("data", (d) => (log1 += d.toString()));
    child1.stderr.on("data", (d) => (log1 += d.toString()));

    try {
      await waitForHealth(migPort1);
      assert(true, `settings persist gateway#1 healthy: ${log1}`);

      const patchResp = await httpRequest(
        "PATCH",
        "/api/settings",
        { settings: { "memory.digestTrigger": "manual", "presentation.bubbleMaxLength": 1200 } },
        migPort1,
      );
      assertEqual(patchResp.status, 200);
      assertEqual(patchResp.json.settings["memory.digestTrigger"], "manual");
      assertEqual(patchResp.json.settings["presentation.bubbleMaxLength"], 1200);

      await killChild(child1);

      const migPort2 = await getFreePort();
      const child2 = spawn(process.execPath, [join(repoRoot, "src/server.js")], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PORT: String(migPort2),
          VERA_DATA_PATH: migDir,
          VERA_MEMORY_VAULT_PATH: join(migDir, "memory"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let log2 = "";
      child2.stdout.on("data", (d) => (log2 += d.toString()));
      child2.stderr.on("data", (d) => (log2 += d.toString()));

      try {
        await waitForHealth(migPort2);
        assert(true, `settings persist gateway#2 healthy: ${log2}`);

        const get = await httpRequest("GET", "/api/settings", undefined, migPort2);
        assertEqual(get.status, 200);
        assertEqual(get.json.settings["memory.digestTrigger"], "manual");
        assertEqual(get.json.settings["presentation.bubbleMaxLength"], 1200);
        assertEqual(get.json.settings["isolation.memory"], "isolated");
      } finally {
        await killChild(child2);
      }
    } finally {
      await rm(migDir, { recursive: true, force: true });
    }
  });
}