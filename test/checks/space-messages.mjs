// c. Space 创建 + d. POST messages → runs。

export async function run(ctx) {
  const { check, httpRequest, assertEqual, assert } = ctx;

  await check("c.0 POST /api/spaces rejects missing or empty seats", async () => {
    const missing = await httpRequest("POST", "/api/spaces", { name: "missing-seats" });
    assertEqual(missing.status, 400);
    assertEqual(missing.json.error.code, "invalid_request");

    const empty = await httpRequest("POST", "/api/spaces", { name: "empty-seats", seats: [] });
    assertEqual(empty.status, 400);
    assertEqual(empty.json.error.code, "invalid_request");
  });

  await check("c. POST /api/spaces creates space with agent seated", async () => {
    const { status, json } = await httpRequest("POST", "/api/spaces", {
      name: "verify-space",
      topic: "verify.mjs 黑盒验收",
      seats: [{ agentId: ctx.agent.id, responseMode: "default" }],
    });
    assertEqual(status, 201);
    assert(json.space?.id?.startsWith("spc_"), "space id should have spc_ prefix");
    assertEqual(json.space.seats.length, 1);
    assertEqual(json.space.seats[0].agentId, ctx.agent.id);
    assertEqual(json.space.seats[0].responseMode, "default");
    ctx.space = json.space;
  });

  await check("d. POST /api/spaces/:id/messages returns 201 with message + runs", async () => {
    const { status, json } = await httpRequest("POST", `/api/spaces/${ctx.space.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "hello agent",
    });
    assertEqual(status, 201);
    assert(json.message?.id?.startsWith("msg_"), "message id should have msg_ prefix");
    assert(Array.isArray(json.runs) && json.runs.length === 1, "expected exactly one run for the seated agent");
    assert(json.runs[0].id.startsWith("run_"), "run id should have run_ prefix");
    ctx.firstRunId = json.runs[0].id;
  });
}
