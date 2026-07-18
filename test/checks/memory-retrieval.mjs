// M3 gateway black box: owner pin/list, prompt injection, session de-duplication,
// Agent isolation, stain safety, and unchanged SSE event vocabulary.

export async function run(ctx) {
  const { check, httpRequest, assertEqual, assert, sse, createOnlineMockAccount } = ctx;

  await check("r.1 M3 retrieval injects safely once per session and keeps SSE unchanged", async () => {
    const created = await createOnlineMockAccount({ name: "M3 alpha" });
    const agentId = created.agent.id;
    ctx.m3AccountId = created.account.id;
    const memories = [
      ["orchid-alpha", "兰花协议甲：检索必须保持确定性"],
      ["orchid-pinned", "兰花协议乙：游标必须保持稳定"],
      ["orchid-tail", "兰花协议丙：同会话不得重复注入"],
    ];
    for (const [slug, description] of memories) {
      const saved = await httpRequest("POST", `/api/agents/${agentId}/memory`, {
        slug, type: "project_rule", description,
        content: `权威正文 ${description}`, stains: { agt_other1: "#A1B2C3" },
      });
      assertEqual(saved.status, 201);
    }
    const pinned = await httpRequest("PUT", `/api/agents/${agentId}/memory/orchid-pinned/pin`, { pinned: true });
    assertEqual(pinned.status, 200);
    assertEqual(pinned.json.pin.pinned, true);
    assertEqual(Object.keys(pinned.json.pin).sort().join(","), "pinned,pinnedAt,slug");
    const listed = await httpRequest("GET", `/api/agents/${agentId}/memory`);
    assertEqual(listed.json.memories.find((item) => item.slug === "orchid-pinned").pinned, true);

    await httpRequest("PATCH", "/api/settings", { settings: { "memory.injectionBudgetResidentLines": 1 } });
    const accountId = created.account.id;
    const space = await httpRequest("POST", "/api/spaces", { name: "M3 retrieval", seats: [{ accountId }] });
    assertEqual(space.status, 201);
    const beforeSeq = Math.max(0, ...sse.events.map((event) => event.seq ?? 0));
    const sent = await httpRequest("POST", `/api/spaces/${space.json.space.id}/messages`, {
      author: { type: "user", userId: "owner" }, target: { type: "direct", accountIds: [accountId] },
      content: "请回忆兰花协议的检索、游标和同会话规则",
    });
    assertEqual(sent.status, 201);
    const runId = sent.json.runs[0].id;
    await sse.waitFor((event) => event.type === "run.ended" && event.data.run.id === runId);
    const timeline = await httpRequest("GET", `/api/spaces/${space.json.space.id}/timeline?limit=100`);
    const reply = timeline.json.items.filter((item) => item.itemType === "message" && item.runId === runId).map((item) => item.content).join("");
    assert(/Vera 记忆库常驻索引/.test(reply), "new provider session should contain the resident prefix");
    assert(/=== Vera 相关记忆 ===/.test(reply), "matching non-resident nodes should be automatically recalled");
    assert(/orchid-pinned/.test(reply), "pinned Memory should occupy the one-line resident budget");
    assert(!/#A1B2C3|stains/u.test(reply), "stain must not enter prompt or response");
    const runEvents = sse.events.filter((event) => (event.seq ?? 0) > beforeSeq &&
      (event.data?.run?.id === runId || event.data?.runId === runId));
    assert(!runEvents.some((event) => String(event.type).startsWith("memory.")), "M3 retrieval must not add SSE events");

    const sentAgain = await httpRequest("POST", `/api/spaces/${space.json.space.id}/messages`, {
      author: { type: "user", userId: "owner" }, target: { type: "direct", accountIds: [accountId] },
      content: "再次回忆兰花协议的检索、游标和同会话规则",
    });
    const againRunId = sentAgain.json.runs[0].id;
    await sse.waitFor((event) => event.type === "run.ended" && event.data.run.id === againRunId);
    const againTimeline = await httpRequest("GET", `/api/spaces/${space.json.space.id}/timeline?limit=100`);
    const againReply = againTimeline.json.items.filter((item) => item.itemType === "message" && item.runId === againRunId).map((item) => item.content).join("");
    assert(!/=== Vera 相关记忆 ===/.test(againReply), "delivered nodes must not be injected again in one session");
    await httpRequest("PATCH", "/api/settings", { settings: { "memory.injectionBudgetResidentLines": null } });
    ctx.m3AgentId = agentId;
  });

  await check("r.2 one Agent recalls the same Memory from a new Space session", async () => {
    const agentId = ctx.m3AgentId;
    const accountId = ctx.m3AccountId;
    const space = await httpRequest("POST", "/api/spaces", { name: "M3 cross Space", seats: [{ accountId }] });
    const sent = await httpRequest("POST", `/api/spaces/${space.json.space.id}/messages`, {
      author: { type: "user", userId: "owner" }, target: { type: "direct", accountIds: [accountId] }, content: "兰花协议",
    });
    const runId = sent.json.runs[0].id;
    await sse.waitFor((event) => event.type === "run.ended" && event.data.run.id === runId);
    const timeline = await httpRequest("GET", `/api/spaces/${space.json.space.id}/timeline?limit=100`);
    const reply = timeline.json.items.filter((item) => item.itemType === "message" && item.runId === runId).map((item) => item.content).join("");
    assert(/orchid-alpha|orchid-pinned|orchid-tail/.test(reply), "Agent-scoped Memory should be visible in a new Space session");
  });

  await check("r.3 M3 retrieval never crosses Agent scope", async () => {
    const created = await createOnlineMockAccount({ name: "M3 beta" });
    const agentId = created.agent.id;
    const accountId = created.account.id;
    await httpRequest("POST", `/api/agents/${agentId}/memory`, {
      slug: "beta-orchid", type: "project_rule", description: "兰花协议仅属于beta",
      content: "beta authority",
    });
    const space = await httpRequest("POST", "/api/spaces", { name: "M3 beta", seats: [{ accountId }] });
    const sent = await httpRequest("POST", `/api/spaces/${space.json.space.id}/messages`, {
      author: { type: "user", userId: "owner" }, target: { type: "direct", accountIds: [accountId] }, content: "兰花协议",
    });
    const runId = sent.json.runs[0].id;
    await sse.waitFor((event) => event.type === "run.ended" && event.data.run.id === runId);
    const timeline = await httpRequest("GET", `/api/spaces/${space.json.space.id}/timeline?limit=100`);
    const reply = timeline.json.items.filter((item) => item.itemType === "message" && item.runId === runId).map((item) => item.content).join("");
    assert(/beta-orchid/.test(reply));
    assert(!/orchid-alpha|orchid-pinned|orchid-tail/.test(reply), "another Agent's slugs must stay invisible");
  });
}
