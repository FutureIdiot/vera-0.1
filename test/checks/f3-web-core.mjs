// p. F3 Web核心体验所依赖的 Space mutation SSE 与设置入参边界。

export async function run(ctx) {
  const { check, httpRequest, assertEqual, assert, sse, agent } = ctx;
  let spaceId = null;

  await check("p.1 Space create/update/archive/restore 均发布 space.updated", async () => {
    const created = await httpRequest("POST", "/api/spaces", {
      name: "f3-live-space",
      seats: [{ agentId: agent.id, responseMode: "focused" }],
      notifications: { mode: "all", includeActivityErrors: false },
    });
    assertEqual(created.status, 201);
    spaceId = created.json.space.id;
    const createEvent = await sse.waitFor((event) => event.type === "space.updated" && event.data.space.id === spaceId);
    assertEqual(createEvent.data.space.name, "f3-live-space");

    const updated = await httpRequest("PATCH", `/api/spaces/${spaceId}`, { name: "f3-renamed" });
    assertEqual(updated.status, 200);
    const updateEvent = await sse.waitFor((event) => event.type === "space.updated" && event.data.space.id === spaceId && event.data.space.name === "f3-renamed");
    assertEqual(updateEvent.data.space.notifications.mode, "all");

    const archived = await httpRequest("POST", `/api/spaces/${spaceId}/archive`);
    assertEqual(archived.status, 200);
    await sse.waitFor((event) => event.type === "space.updated" && event.data.space.id === spaceId && event.data.space.archivedAt !== null);

    const restored = await httpRequest("POST", `/api/spaces/${spaceId}/restore`);
    assertEqual(restored.status, 200);
    await sse.waitFor((event) => event.type === "space.updated" && event.data.space.id === spaceId && event.data.space.archivedAt === null);
  });

  await check("p.2 Space settings 拒绝重复/未知 Seat 与非法枚举", async () => {
    const duplicate = await httpRequest("PATCH", `/api/spaces/${spaceId}`, {
      seats: [
        { agentId: agent.id, responseMode: "default" },
        { agentId: agent.id, responseMode: "focused" },
      ],
    });
    assertEqual(duplicate.status, 400);
    assertEqual(duplicate.json.error.code, "invalid_request");

    const unknown = await httpRequest("PATCH", `/api/spaces/${spaceId}`, {
      seats: [{ agentId: "agt_missing", responseMode: "default" }],
    });
    assertEqual(unknown.status, 400);

    const empty = await httpRequest("PATCH", `/api/spaces/${spaceId}`, { seats: [] });
    assertEqual(empty.status, 400);
    assertEqual(empty.json.error.code, "invalid_request");

    const badMode = await httpRequest("PATCH", `/api/spaces/${spaceId}`, {
      seats: [{ agentId: agent.id, responseMode: "sometimes" }],
    });
    assertEqual(badMode.status, 400);

    const badNotifications = await httpRequest("PATCH", `/api/spaces/${spaceId}`, {
      notifications: { mode: "sometimes", includeActivityErrors: true },
    });
    assertEqual(badNotifications.status, 400);

    const nullPatch = await httpRequest("PATCH", `/api/spaces/${spaceId}`, null);
    assertEqual(nullPatch.status, 400);
    const badTopic = await httpRequest("PATCH", `/api/spaces/${spaceId}`, { topic: { text: "no" } });
    assertEqual(badTopic.status, 400);
    const nullNotifications = await httpRequest("PATCH", `/api/spaces/${spaceId}`, { notifications: null });
    assertEqual(nullNotifications.status, 400);
  });

  await check("p.3 Space 设置一次 PATCH 后由活跃列表返回权威形状", async () => {
    const response = await httpRequest("PATCH", `/api/spaces/${spaceId}`, {
      topic: "F3 settings",
      seats: [{ agentId: agent.id, responseMode: "silent", respondTo: ["user"] }],
      notifications: { mode: "agentMessages", includeActivityErrors: true },
    });
    assertEqual(response.status, 200);
    const listed = await httpRequest("GET", "/api/spaces");
    const space = listed.json.spaces.find((candidate) => candidate.id === spaceId);
    assert(space, "updated Space should remain active");
    assertEqual(space.topic, "F3 settings");
    assertEqual(space.seats[0].respondTo[0], "user");
  });

  await check("p.4 archived Space preview/delete 发布 space.deleted", async () => {
    await httpRequest("POST", `/api/spaces/${spaceId}/archive`);
    await sse.waitFor((event) =>
      event.type === "space.updated" &&
      event.data.space.id === spaceId &&
      event.data.space.archivedAt !== null);
    const preview = await httpRequest("GET", `/api/spaces/${spaceId}/deletion-preview`);
    assertEqual(preview.status, 200);
    assertEqual(preview.json.preview.messageCount, 0);
    assertEqual(preview.json.preview.exclusiveMemoryCount, 0);
    const removed = await httpRequest("DELETE", `/api/spaces/${spaceId}`, {
      deleteExclusiveMemories: false,
    });
    assertEqual(removed.status, 200);
    assertEqual(removed.json.deleted.spaceId, spaceId);
    await sse.waitFor((event) =>
      event.type === "space.deleted" &&
      event.data.spaceId === spaceId);
  });
}
