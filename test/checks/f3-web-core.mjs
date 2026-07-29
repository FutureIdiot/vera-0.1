// p. F3 Web核心体验所依赖的 Space mutation SSE 与设置入参边界。

export async function run(ctx) {
  const { check, httpRequest, assertEqual, assert, sse, owningAccount } = ctx;
  let spaceId = null;
  let projectId = null;

  await check("p.0 Project CRUD 严格校验并发布更新事件", async () => {
    const invalid = await httpRequest("POST", "/api/projects", {
      name: "invalid",
      unexpected: true,
    });
    assertEqual(invalid.status, 400);
    assertEqual(invalid.json.error.code, "invalid_request");

    const created = await httpRequest("POST", "/api/projects", { name: "Navigation" });
    assertEqual(created.status, 201);
    projectId = created.json.project.id;
    assert(projectId.startsWith("prj_"), "Project id should have prj_ prefix");
    await sse.waitFor((event) =>
      event.type === "project.updated" &&
      event.data.project.id === projectId &&
      event.data.project.name === "Navigation");

    const fetched = await httpRequest("GET", `/api/projects/${projectId}`);
    assertEqual(fetched.status, 200);
    assertEqual(fetched.json.project.name, "Navigation");

    const updated = await httpRequest("PATCH", `/api/projects/${projectId}`, { name: "Navigation 0.1" });
    assertEqual(updated.status, 200);
    await sse.waitFor((event) =>
      event.type === "project.updated" &&
      event.data.project.id === projectId &&
      event.data.project.name === "Navigation 0.1");
  });

  await check("p.1 Space create/update/archive/restore 均发布 space.updated", async () => {
    const created = await httpRequest("POST", "/api/spaces", {
      name: "f3-live-space",
      seats: [{ accountId: owningAccount.id, responseMode: "focused" }],
      notifications: { mode: "all", includeActivityErrors: false },
      pinned: true,
      spaceType: "garage",
      projectId,
    });
    assertEqual(created.status, 201);
    spaceId = created.json.space.id;
    const createEvent = await sse.waitFor((event) => event.type === "space.updated" && event.data.space.id === spaceId);
    assertEqual(createEvent.data.space.name, "f3-live-space");
    assertEqual(createEvent.data.space.pinned, true);
    assertEqual(createEvent.data.space.spaceType, "garage");
    assertEqual(createEvent.data.space.projectId, projectId);

    const referenced = await httpRequest("DELETE", `/api/projects/${projectId}`);
    assertEqual(referenced.status, 409);
    assertEqual(referenced.json.error.code, "conflict");

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

  await check("p.2 Space settings 拒绝重复/未知 Seat、非法枚举与 Type 修改", async () => {
    const duplicate = await httpRequest("PATCH", `/api/spaces/${spaceId}`, {
      seats: [
        { accountId: owningAccount.id, responseMode: "default" },
        { accountId: owningAccount.id, responseMode: "focused" },
      ],
    });
    assertEqual(duplicate.status, 400);
    assertEqual(duplicate.json.error.code, "invalid_request");

    const unknown = await httpRequest("PATCH", `/api/spaces/${spaceId}`, {
      seats: [{ accountId: "acc_missing", responseMode: "default" }],
    });
    assertEqual(unknown.status, 400);

    const empty = await httpRequest("PATCH", `/api/spaces/${spaceId}`, { seats: [] });
    assertEqual(empty.status, 400);
    assertEqual(empty.json.error.code, "invalid_request");

    const badMode = await httpRequest("PATCH", `/api/spaces/${spaceId}`, {
      seats: [{ accountId: owningAccount.id, responseMode: "sometimes" }],
    });
    assertEqual(badMode.status, 400);

    const badNotifications = await httpRequest("PATCH", `/api/spaces/${spaceId}`, {
      notifications: { mode: "sometimes", includeActivityErrors: true },
    });
    assertEqual(badNotifications.status, 400);

    const immutableSpaceType = await httpRequest("PATCH", `/api/spaces/${spaceId}`, { spaceType: "library" });
    assertEqual(immutableSpaceType.status, 400);
    assertEqual(immutableSpaceType.json.error.code, "invalid_request");
    const badPinned = await httpRequest("PATCH", `/api/spaces/${spaceId}`, { pinned: "yes" });
    assertEqual(badPinned.status, 400);
    const badProject = await httpRequest("PATCH", `/api/spaces/${spaceId}`, { projectId: "prj_missing" });
    assertEqual(badProject.status, 400);
    const unknownField = await httpRequest("PATCH", `/api/spaces/${spaceId}`, { unexpected: true });
    assertEqual(unknownField.status, 400);

    const nullPatch = await httpRequest("PATCH", `/api/spaces/${spaceId}`, null);
    assertEqual(nullPatch.status, 400);
    const badTopic = await httpRequest("PATCH", `/api/spaces/${spaceId}`, { topic: "removed" });
    assertEqual(badTopic.status, 400);
    const nullNotifications = await httpRequest("PATCH", `/api/spaces/${spaceId}`, { notifications: null });
    assertEqual(nullNotifications.status, 400);
  });

  await check("p.3 Space 设置一次 PATCH 后由活跃列表返回权威形状", async () => {
    const response = await httpRequest("PATCH", `/api/spaces/${spaceId}`, {
      seats: [{ accountId: owningAccount.id, responseMode: "focused", respondTo: ["user"] }],
      notifications: { mode: "accountMessages", includeActivityErrors: true },
      pinned: false,
      projectId: null,
    });
    assertEqual(response.status, 200);
    const listed = await httpRequest("GET", "/api/spaces");
    const space = listed.json.spaces.find((candidate) => candidate.id === spaceId);
    assert(space, "updated Space should remain active");
    assert(!Object.hasOwn(space, "topic"), "Space must not expose topic");
    assertEqual(space.seats[0].respondTo[0], "user");
    assertEqual(space.pinned, false);
    assertEqual(space.spaceType, "garage");
    assertEqual(space.projectId, null);
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

    const removedProject = await httpRequest("DELETE", `/api/projects/${projectId}`);
    assertEqual(removedProject.status, 204);
    await sse.waitFor((event) =>
      event.type === "project.deleted" &&
      event.data.projectId === projectId);
  });
}
