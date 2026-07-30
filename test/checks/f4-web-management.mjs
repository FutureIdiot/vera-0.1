// q. F4 management-facing contracts whose correctness depends on live runtime
// consumers rather than CRUD responses alone.

export async function run(ctx) {
  const {
    check,
    httpRequest,
    assertEqual,
    assert,
    sse,
    createOnlineMockAccount,
    setVeraMemoryEnabled,
  } = ctx;

  await check("q.1 bootstrap Account shape exposes honest presence capability state", async () => {
    const response = await httpRequest("GET", "/api/bootstrap");
    assertEqual(response.status, 200);
    for (const account of response.json.accounts) {
      assert(["online", "offline"].includes(account.presence), "presence must be an honest contract value");
      assert(typeof account.ownerAgentId === "string", "ownerAgentId should be present");
      if (account.presence === "online") assertEqual(account.activeAgentId, account.ownerAgentId);
      else assertEqual(account.activeAgentId, null);
    }
  });

  await check("q.2 provider paragraphs remain in one Message", async () => {
    const created = await createOnlineMockAccount({ name: "F4 provider message" });
    const accountId = created.account.id;
    const space = await httpRequest("POST", "/api/spaces", { name: "F4 provider message", seats: [{ accountId }] });
    assertEqual(space.status, 201);
    const sent = await httpRequest("POST", `/api/spaces/${space.json.space.id}/messages`, {
      author: { type: "user", userId: "owner" },
      target: { type: "direct", accountIds: [accountId] },
      content: "provider-message-boundary",
    });
    assertEqual(sent.status, 201);
    const runId = sent.json.runs[0].id;
    await sse.waitFor((event) => event.type === "run.ended" && event.data.run.id === runId);
    const timeline = await httpRequest("GET", `/api/spaces/${space.json.space.id}/timeline?limit=100`);
    const replies = timeline.json.items.filter((item) => item.itemType === "message" && item.runId === runId);
    assertEqual(replies.length, 1);
    assert(replies[0].content.includes("\n\n"), "mock provider paragraphs should remain in one Message");
  });

  await check("q.3 resident-index budget hot-updates before a new external session", async () => {
    const created = await createOnlineMockAccount({ name: "F4 memory budget" });
    const agentId = created.agent.id;
    await setVeraMemoryEnabled({ request: httpRequest, agentId, enabled: true });
    await httpRequest("POST", `/api/agents/${agentId}/memory`, { slug: "first-memory", type: "decision", description: "first hook", content: "first" });
    await httpRequest("POST", `/api/agents/${agentId}/memory`, { slug: "second-memory", type: "decision", description: "second hook", content: "second" });
    const setting = await httpRequest("PATCH", "/api/settings", { settings: { "memory.injectionBudgetResidentLines": 1 } });
    assertEqual(setting.status, 200);
    const accountId = created.account.id;
    const space = await httpRequest("POST", "/api/spaces", { name: "F4 memory budget", seats: [{ accountId }] });
    const sent = await httpRequest("POST", `/api/spaces/${space.json.space.id}/messages`, {
      author: { type: "user", userId: "owner" },
      target: { type: "direct", accountIds: [accountId] },
      content: "budget-check",
    });
    const runId = sent.json.runs[0].id;
    await sse.waitFor((event) => event.type === "run.ended" && event.data.run.id === runId);
    const timeline = await httpRequest("GET", `/api/spaces/${space.json.space.id}/timeline?limit=100`);
    const reply = timeline.json.items.filter((item) => item.itemType === "message" && item.runId === runId).map((item) => item.content).join("");
    const matches = ["first-memory", "second-memory"].filter((slug) => reply.includes(slug));
    assertEqual(matches.length, 1, "live resident-index budget should expose exactly one slug");
    await httpRequest("PATCH", "/api/settings", { settings: { "memory.injectionBudgetResidentLines": null } });
  });
}
