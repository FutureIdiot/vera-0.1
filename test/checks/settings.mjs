// n. 系统配置（Phase 4.5）：GET/PATCH /api/settings + 字段白名单校验 + 重启持久化。

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  await check("n.2 isolation.memory 固定 isolated，旧值不可再写入", async () => {
    for (const legacyValue of ["globalReadable", "perSpace"]) {
      const rejected = await httpRequest("PATCH", "/api/settings", {
        settings: { "isolation.memory": legacyValue },
      });
      assertEqual(rejected.status, 400);
      assertEqual(rejected.json.error.code, "invalid_request");
    }

    const patch = await httpRequest("PATCH", "/api/settings", { settings: { "isolation.memory": "isolated" } });
    assertEqual(patch.status, 200);
    assertEqual(patch.json.settings["isolation.memory"], "isolated");

    const get = await httpRequest("GET", "/api/settings");
    assertEqual(get.status, 200);
    assertEqual(get.json.settings["isolation.memory"], "isolated");
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
    assertEqual(get.json.settings["isolation.memory"], "isolated");
  });

  await check("n.4 旧 isolation.memory override 迁移为固定 isolated，重启幂等", async () => {
    const migDir = await mkdtemp(join(tmpdir(), "vera-settings-persist-"));
    const settingsPath = join(migDir, "settings.json");
    await writeFile(settingsPath, JSON.stringify({
      "isolation.memory": "globalReadable",
      "memory.digestTrigger": "realtime",
    }, null, 2), "utf8");
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

      const migrated = await httpRequest("GET", "/api/settings", undefined, migPort1);
      assertEqual(migrated.status, 200);
      assertEqual(migrated.json.settings["isolation.memory"], "isolated");
      assertEqual(migrated.json.settings["memory.digestTrigger"], "realtime");

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
      const afterFirstStart = JSON.parse(await readFile(settingsPath, "utf8"));
      assert(!Object.prototype.hasOwnProperty.call(afterFirstStart, "isolation.memory"), "legacy memory isolation override should be removed");
      assertEqual(afterFirstStart["memory.digestTrigger"], "manual");

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
      const afterSecondStart = JSON.parse(await readFile(settingsPath, "utf8"));
      assert(!Object.prototype.hasOwnProperty.call(afterSecondStart, "isolation.memory"), "restart must not recreate memory isolation override");
      assertEqual(afterSecondStart["memory.digestTrigger"], "manual");
    } finally {
      await rm(migDir, { recursive: true, force: true });
    }
  });
}
