// F1 path migration black-box checks: Memory hot reopen and gateway dataPath
// restart discovery through the env/default anchor settings.json.

import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpClient, startGateway } from "./_helpers.mjs";

export async function run(ctx) {
  const { check, httpRequest, assertEqual, assert, dataDir, agent } = ctx;

  await check("p.1 memory vault migrate 保留 agent 子目录并热切换读写", async () => {
    const prefix = `/api/agents/${agent.id}/memory`;
    const created = await httpRequest("POST", prefix, {
      slug: "before-vault-move", type: "decision", description: "before", content: "old-root",
    });
    assertEqual(created.status, 201);
    const target = join(dataDir, "migrated-memory");
    const migrated = await httpRequest("POST", "/api/paths/migrate", { key: "memory.vaultPath", target });
    assertEqual(migrated.status, 200);
    assertEqual(migrated.json.restartRequired, false);
    assertEqual((await httpRequest("GET", `${prefix}/before-vault-move`)).json.memory.content, "old-root");
    const after = await httpRequest("POST", prefix, {
      slug: "after-vault-move", type: "decision", description: "after", content: "new-root",
    });
    assertEqual(after.status, 201);
    const raw = await readFile(join(target, agent.id, "after-vault-move.md"), "utf8");
    assert(raw.includes("new-root"), "post-migrate writes must use target agent directory");
  });

  await check("p.2 gateway dataPath migrate 后从旧 env anchor 重启读取新路径", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-f1-data-path-"));
    const source = join(root, "source");
    const target = join(root, "target");
    const target2 = join(root, "target-2");
    const vault = join(root, "vault");
    await mkdir(source, { recursive: true });
    let first;
    let second;
    let third;
    try {
      first = await startGateway({ repoRoot: ctx.repoRoot, env: { VERA_DATA_PATH: source, VERA_MEMORY_VAULT_PATH: vault } });
      const firstHttp = createHttpClient(first.port);
      const created = await firstHttp("POST", "/api/agents", {
        name: "Data path survivor", kind: "cli", provider: "mock", model: "mock-v1", connection: {},
      });
      assertEqual(created.status, 201);
      const agentId = created.json.agent.id;
      const migrate = await firstHttp("POST", "/api/paths/migrate", { key: "gateway.dataPath", target });
      assertEqual(migrate.status, 200);
      assertEqual(migrate.json.restartRequired, true);
      await first.stop();
      first = null;

      second = await startGateway({ repoRoot: ctx.repoRoot, env: { VERA_DATA_PATH: source, VERA_MEMORY_VAULT_PATH: vault } });
      const secondHttp = createHttpClient(second.port);
      const bootstrap = await secondHttp("GET", "/api/bootstrap");
      assertEqual(bootstrap.status, 200);
      assert(bootstrap.json.agents.some((item) => item.id === agentId), "restart must load copied target store");
      const paths = await secondHttp("GET", "/api/paths");
      assertEqual(paths.json.paths.gateway.dataPath, target);
      const migrateAgain = await secondHttp("POST", "/api/paths/migrate", { key: "gateway.dataPath", target: target2 });
      assertEqual(migrateAgain.status, 200);
      await second.stop();
      second = null;

      third = await startGateway({ repoRoot: ctx.repoRoot, env: { VERA_DATA_PATH: source, VERA_MEMORY_VAULT_PATH: vault } });
      const thirdHttp = createHttpClient(third.port);
      assertEqual((await thirdHttp("GET", "/api/paths")).json.paths.gateway.dataPath, target2);
      await thirdHttp("POST", "/api/agents", {
        name: "Written after second restart", kind: "cli", provider: "mock", model: "mock-v1", connection: {},
      });
      await third.stop();
      third = null;
      const targetAgents = JSON.parse(await readFile(join(target2, "agents.json"), "utf8"));
      assert(targetAgents.some((item) => item.name === "Written after second restart"), "repeated migration must update the env anchor");
      const anchorSettings = JSON.parse(await readFile(join(source, "settings.json"), "utf8"));
      assertEqual(anchorSettings["paths.gateway.dataPath"], target2);
    } finally {
      if (first) await first.stop();
      if (second) await second.stop();
      if (third) await third.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
}
