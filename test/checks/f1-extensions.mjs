// o. F1 扩展：Appearance settings + Space archive/restore + Account 联邦字段 +
//    Agent-states 过滤 + Themes CRUD + Memory 编辑 + Paths + Status。

export async function run(ctx) {
  const { check, httpRequest, assertEqual, assert } = ctx;

  // ---- Appearance settings ----

  await check("o.1 GET /api/settings 含 appearance.* + paths.* 默认值", async () => {
    const { status, json } = await httpRequest("GET", "/api/settings");
    assertEqual(status, 200);
    const s = json.settings;
    assertEqual(s["appearance.theme"], "system");
    assertEqual(s["appearance.themeId"], null);
    assertEqual(s["appearance.fontFamily"], "system");
    assertEqual(s["appearance.fontSize.phone.chat"], 14);
    assertEqual(s["appearance.fontSize.desktop.chat"], 16);
    assertEqual(s["appearance.bubbleRadius.phone"], 16);
    assertEqual(s["appearance.bubbleGap.phone"], 4);
    assertEqual(s["appearance.bubbleGap.desktop"], 10);
    assertEqual(s["appearance.windowMargin.phone.chat"], 12);
    assertEqual(s["appearance.windowMargin.desktop.chat"], 64);
    assertEqual(s["appearance.windowMargin.desktop.management"], 8);
    assert(typeof s["paths.memoryVaultPath"] === "string", "paths.memoryVaultPath should be a string");
    assert(typeof s["paths.gateway.dataPath"] === "string", "paths.gateway.dataPath should be a string");
  });

  await check("o.2 PATCH appearance.theme = dark -> 200；null 恢复默认", async () => {
    const patch = await httpRequest("PATCH", "/api/settings", {
      settings: { "appearance.theme": "dark" },
    });
    assertEqual(patch.status, 200);
    assertEqual(patch.json.settings["appearance.theme"], "dark");

    const restore = await httpRequest("PATCH", "/api/settings", {
      settings: { "appearance.theme": null },
    });
    assertEqual(restore.status, 200);
    assertEqual(restore.json.settings["appearance.theme"], "system");
  });

  await check("o.3 PATCH appearance 无效值 -> 400 invalid_request", async () => {
    const badEnum = await httpRequest("PATCH", "/api/settings", {
      settings: { "appearance.theme": "bogus" },
    });
    assertEqual(badEnum.status, 400);
    assertEqual(badEnum.json.error.code, "invalid_request");

    const zeroFont = await httpRequest("PATCH", "/api/settings", {
      settings: { "appearance.fontSize.phone.chat": 0 },
    });
    assertEqual(zeroFont.status, 400);

    const negGap = await httpRequest("PATCH", "/api/settings", {
      settings: { "appearance.bubbleGap.phone": -1 },
    });
    assertEqual(negGap.status, 400);
  });

  // ---- Space archive/restore ----

  let archiveSpaceId = null;

  await check("o.4 createSpace 带 notifications 默认 + archivedAt null", async () => {
    const { status, json } = await httpRequest("POST", "/api/spaces", { name: "f1-archive-test" });
    assertEqual(status, 201);
    archiveSpaceId = json.space.id;
    assertEqual(json.space.archivedAt, null);
    assertEqual(json.space.notifications.mode, "agentMessages");
    assertEqual(json.space.notifications.includeActivityErrors, true);
  });

  await check("o.5 archive Space -> archivedAt 非空；幂等", async () => {
    const r1 = await httpRequest("POST", `/api/spaces/${archiveSpaceId}/archive`);
    assertEqual(r1.status, 200);
    assert(r1.json.space.archivedAt !== null, "archivedAt should be set");
    const r2 = await httpRequest("POST", `/api/spaces/${archiveSpaceId}/archive`);
    assertEqual(r2.status, 200);
    assertEqual(r2.json.space.archivedAt, r1.json.space.archivedAt);
  });

  await check("o.6 发消息到已归档 Space -> 409 conflict", async () => {
    const { status, json } = await httpRequest("POST", `/api/spaces/${archiveSpaceId}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "should fail",
    });
    assertEqual(status, 409);
    assertEqual(json.error.code, "conflict");
  });

  await check("o.7 ?archived=true 只列已归档", async () => {
    const active = await httpRequest("GET", "/api/spaces");
    const activeArchived = active.json.spaces.filter((s) => s.archivedAt !== null);
    assertEqual(activeArchived.length, 0);

    const archived = await httpRequest("GET", "/api/spaces?archived=true");
    const archivedFound = archived.json.spaces.filter((s) => s.archivedAt !== null);
    assert(archivedFound.length > 0, "should find archived spaces");
    assert(archived.json.spaces.some((s) => s.id === archiveSpaceId), "archive test space should be in archived list");
  });

  await check("o.8 restore Space -> archivedAt null；幂等", async () => {
    const r1 = await httpRequest("POST", `/api/spaces/${archiveSpaceId}/restore`);
    assertEqual(r1.status, 200);
    assertEqual(r1.json.space.archivedAt, null);
    const r2 = await httpRequest("POST", `/api/spaces/${archiveSpaceId}/restore`);
    assertEqual(r2.status, 200);
    assertEqual(r2.json.space.archivedAt, null);
  });

  // ---- Account 联邦字段 ----

  await check("o.9 Account 形状含 presence/lastSeenAt/runtimeCapabilities/authorizedAgentIds", async () => {
    const { status, json } = await httpRequest("GET", "/api/accounts");
    assertEqual(status, 200);
    assert(json.accounts.length > 0, "should have at least one account");
    const a = json.accounts[0];
    assert("presence" in a, "account should have presence");
    assert("lastSeenAt" in a, "account should have lastSeenAt");
    assert("runtimeCapabilities" in a, "account should have runtimeCapabilities");
    assert("authorizedAgentIds" in a, "account should have authorizedAgentIds");
    assertEqual(a.presence, "offline");
    assertEqual(a.runtimeCapabilities, null);
    assert(Array.isArray(a.authorizedAgentIds), "authorizedAgentIds should be an array");
  });

  // ---- Agent-states 过滤 ----

  await check("o.10 GET /api/agent-states?agentId=... 过滤", async () => {
    const all = await httpRequest("GET", "/api/agent-states");
    assertEqual(all.status, 200);
    if (all.json.agentStates.length > 0) {
      const targetId = all.json.agentStates[0].agentId;
      const filtered = await httpRequest("GET", `/api/agent-states?agentId=${targetId}`);
      assertEqual(filtered.status, 200);
      assert(filtered.json.agentStates.every((s) => s.agentId === targetId), "all results should match agentId");
    }
  });

  // ---- Themes ----

  let themeId = null;

  await check("o.11 POST /api/themes/import (vera-json) -> preview + warnings", async () => {
    const themeJson = JSON.stringify({
      schemaVersion: 1,
      kind: "vera-theme",
      name: "F1 Test",
      colors: {
        background: "#1e1e2e", surface: "#313244", text: "#cdd6f4",
        mutedText: "#a6adc8", border: "#45475a", accent: "#89b4fa",
        success: "#a6e3a1", warning: "#f9e2af", error: "#f38ba8",
      },
    });
    const { status, json } = await httpRequest("POST", "/api/themes/import", {
      format: "vera-json",
      content: themeJson,
    });
    assertEqual(status, 200);
    assertEqual(json.preview.name, "F1 Test");
    assert(json.warnings.includes("theme has no terminal palette"), "should warn about missing terminal");
  });

  await check("o.12 POST /api/themes -> 201；GET /api/themes/:id", async () => {
    const create = await httpRequest("POST", "/api/themes", {
      theme: {
        schemaVersion: 1,
        kind: "vera-theme",
        name: "F1 Saved Theme",
        colors: {
          background: "#1e1e2e", surface: "#313244", text: "#cdd6f4",
          mutedText: "#a6adc8", border: "#45475a", accent: "#89b4fa",
          success: "#a6e3a1", warning: "#f9e2af", error: "#f38ba8",
        },
      },
    });
    assertEqual(create.status, 201);
    themeId = create.json.theme.id;
    assert(themeId.startsWith("thm_"), "theme id should start with thm_");

    const get = await httpRequest("GET", `/api/themes/${themeId}`);
    assertEqual(get.status, 200);
    assertEqual(get.json.theme.name, "F1 Saved Theme");
  });

  await check("o.13 GET /api/themes 列表摘要", async () => {
    const { status, json } = await httpRequest("GET", "/api/themes");
    assertEqual(status, 200);
    assert(json.themes.some((t) => t.id === themeId), "saved theme should be in list");
    const item = json.themes.find((t) => t.id === themeId);
    assert(!("colors" in item), "list item should not include colors");
  });

  await check("o.14 PATCH /api/themes/:id 更新 name", async () => {
    const { status, json } = await httpRequest("PATCH", `/api/themes/${themeId}`, { name: "Renamed" });
    assertEqual(status, 200);
    assertEqual(json.theme.name, "Renamed");
  });

  await check("o.15 GET /api/themes/:id/export?format=vera-css", async () => {
    const { status, json } = await httpRequest("GET", `/api/themes/${themeId}/export?format=vera-css`);
    assertEqual(status, 200);
    assert(typeof json === "string", "CSS export should return text");
    assert(json.includes("--vera-color-background"), "CSS should contain color variables");
  });

  await check("o.16 DELETE /api/themes/:id 被引用时 409", async () => {
    await httpRequest("PATCH", "/api/settings", {
      settings: { "appearance.theme": "custom", "appearance.themeId": themeId },
    });
    const del = await httpRequest("DELETE", `/api/themes/${themeId}`);
    assertEqual(del.status, 409);
    assertEqual(del.json.error.code, "conflict");

    // 解除引用后删除成功
    await httpRequest("PATCH", "/api/settings", {
      settings: { "appearance.theme": null, "appearance.themeId": null },
    });
    const del2 = await httpRequest("DELETE", `/api/themes/${themeId}`);
    assertEqual(del2.status, 204);
  });

  // ---- Appearance Profile export ----

  await check("o.17 GET /api/settings/appearance-profile/export", async () => {
    const { status, json } = await httpRequest("GET", "/api/settings/appearance-profile/export");
    assertEqual(status, 200);
    assertEqual(json.kind, "vera-appearance-profile");
    assertEqual(json.schemaVersion, 1);
    assert(!("appearance.theme" in json.appearance), "should not include theme palette keys");
    assert(!("appearance.themeId" in json.appearance), "should not include themeId");
    assert("appearance.fontFamily" in json.appearance, "should include fontFamily");
    assert("appearance.fontSize.phone.chat" in json.appearance, "should include fontSize");
  });

  // ---- Memory 编辑 ----

  await check("o.18 Agent Memory GET/PATCH/DELETE 与作用域隔离", async () => {
    const prefix = `/api/agents/${ctx.agent.id}/memory`;
    const create = await httpRequest("POST", prefix, {
      slug: "f1-test-mem",
      type: "decision",
      description: "test hook",
      content: "original body",
    });
    assertEqual(create.status, 201);

    const get = await httpRequest("GET", `${prefix}/f1-test-mem`);
    assertEqual(get.status, 200);
    assertEqual(get.json.memory.content, "original body");

    const patch = await httpRequest("PATCH", `${prefix}/f1-test-mem`, {
      description: "updated hook",
      status: "archived",
    });
    assertEqual(patch.status, 200);
    assertEqual(patch.json.memory.status, "archived");
    assertEqual(patch.json.memory.description, "updated hook");

    const missingAgent = await httpRequest("GET", "/api/agents/agt_missing/memory");
    assertEqual(missingAgent.status, 404);
    const oldRoute = await httpRequest("GET", "/api/memory/f1-test-mem");
    assertEqual(oldRoute.status, 404);

    const del = await httpRequest("DELETE", `${prefix}/f1-test-mem`);
    assertEqual(del.status, 204);

    const getAfterDelete = await httpRequest("GET", `${prefix}/f1-test-mem`);
    assertEqual(getAfterDelete.status, 404);
  });

  // ---- Paths ----

  await check("o.19 GET /api/paths", async () => {
    const { status, json } = await httpRequest("GET", "/api/paths");
    assertEqual(status, 200);
    assert("vaultPath" in json.paths.memory, "should have vaultPath");
    assert("exists" in json.paths.memory, "should have exists");
    assert("legacyUnscopedCount" in json.paths.memory, "should expose legacy unscoped count");
    assert("dataPath" in json.paths.gateway, "should have dataPath");
  });

  await check("o.20 POST /api/paths/validate 校验路径", async () => {
    const { status, json } = await httpRequest("POST", "/api/paths/validate", {
      key: "memory.vaultPath",
      value: "/tmp/vera-f1-validate-test",
    });
    assertEqual(status, 200);
    assert(typeof json.ok === "boolean", "ok should be boolean");
    assert(Array.isArray(json.errors), "errors should be array");
    assertEqual(json.normalized, "/tmp/vera-f1-validate-test");
  });

  // ---- Status ----

  await check("o.21 GET /api/status", async () => {
    const { status, json } = await httpRequest("GET", "/api/status");
    assertEqual(status, 200);
    const s = json.status;
    assertEqual(s.gateway.version, "0.0.1");
    assertEqual(s.agents.federation, "disabled");
    assert(typeof s.sse.currentSeq === "number", "currentSeq should be number");
    assert(typeof s.sse.connectedClients === "number", "connectedClients should be number");
    assert("collections" in s.store, "should have collections");
    assert("themes" in s.store.collections, "collections should include themes");
    assert(Array.isArray(s.recentErrors), "recentErrors should be array");
  });
}
