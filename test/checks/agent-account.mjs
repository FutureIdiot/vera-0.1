// b. Agent/Account 拆分（Phase 4.1）：CRUD + 自有/额外 account + 删除约束。
// 原 verify.mjs 在 e. 后还插了一条 "b. DELETE /api/agents/:id" 检查（依赖 agent
// 已有消息历史），把它也归在本模块——但要在主流程里按依赖序执行（见 verify.mjs
// main() 那个 export const runsAfterTriggerCheckList 的注释）。

export async function run(ctx) {
  const { check, httpRequest, assertEqual, assert } = ctx;

  await check("b. POST /api/agents returns { agent, account } 并把连接字段从 agent 剥到 account", async () => {
    const { status, json } = await httpRequest("POST", "/api/agents", {
      name: "VerifyMock",
      kind: "cli",
      provider: "mock",
      connection: {},
      model: "mock-v1",
    });
    assertEqual(status, 201);
    assert(json.agent?.id?.startsWith("agt_"), "agent id should have agt_ prefix");
    assert(
      !("kind" in json.agent) && !("provider" in json.agent) && !("connection" in json.agent) && !("model" in json.agent),
      "agent must not carry kind/provider/connection/model (4.1)",
    );
    assertEqual(json.agent.name, "VerifyMock");
    assert(json.account?.id?.startsWith("acc_"), "account id should have acc_ prefix");
    assertEqual(json.account.owningAgentId, json.agent.id);
    assertEqual(json.account.kind, "cli");
    assertEqual(json.account.provider, "mock");
    assertEqual(json.account.model, "mock-v1");
    ctx.agent = json.agent;
    ctx.owningAccount = json.account;
  });

  await check("b. PATCH /api/agents/:id 只改 name，连接字段不走此接口", async () => {
    const { status, json } = await httpRequest("PATCH", `/api/agents/${ctx.agent.id}`, {
      name: "VerifyMock2",
      model: "ignored",
    });
    assertEqual(status, 200);
    assertEqual(json.agent.name, "VerifyMock2");
    assert(
      !("model" in json.agent) && !("provider" in json.agent),
      "PATCH /api/agents must not surface connection fields",
    );
    ctx.agent = json.agent;
  });

  await check("b. GET /api/accounts lists the auto-derived owning account", async () => {
    const { status, json } = await httpRequest("GET", "/api/accounts");
    assertEqual(status, 200);
    assert(Array.isArray(json.accounts));
    assert(json.accounts.some((a) => a.id === ctx.owningAccount.id), "owning account should be in the list");
  });

  await check("b. GET /api/accounts?agentId=... 按拥有者过滤", async () => {
    const { status, json } = await httpRequest("GET", `/api/accounts?agentId=${ctx.agent.id}`);
    assertEqual(status, 200);
    assertEqual(json.accounts.length, 1);
    assertEqual(json.accounts[0].owningAgentId, ctx.agent.id);
  });

  await check("b. PATCH /api/accounts/:id 改 model（换模型改 account 不改 agent 身份）", async () => {
    const { status, json } = await httpRequest("PATCH", `/api/accounts/${ctx.owningAccount.id}`, { model: "mock-v2" });
    assertEqual(status, 200);
    assertEqual(json.account.model, "mock-v2");
    assertEqual(json.account.id, ctx.owningAccount.id);
    ctx.owningAccount = json.account;
  });

  let secondAccount;
  await check("b. POST /api/agents/:id/accounts 为同一 agent 增加第二条 account", async () => {
    const { status, json } = await httpRequest("POST", `/api/agents/${ctx.agent.id}/accounts`, {
      name: "VerifyMock 第二账户",
      kind: "cli",
      provider: "mock",
      connection: {},
      model: "",
    });
    assertEqual(status, 201);
    assert(json.account?.id?.startsWith("acc_"));
    assert(json.account.id !== ctx.owningAccount.id, "second account must be a different id");
    assertEqual(json.account.owningAgentId, ctx.agent.id);
    secondAccount = json.account;
  });

  await check("b. DELETE /api/accounts/:id 不可删唯一 owning account（409），删多余 account 成功（204）", async () => {
    const delSecond = await httpRequest("DELETE", `/api/accounts/${secondAccount.id}`);
    assertEqual(delSecond.status, 204);
    const sole = await httpRequest("DELETE", `/api/accounts/${ctx.owningAccount.id}`);
    assertEqual(sole.status, 409);
    assertEqual(sole.json.error.code, "conflict");
  });

  await check("b. 多 Agent 同 Space 的 AgentSession/provider binding 各自隔离", async () => {
    // 4.4 起 Seat 不再携带 accountId（账户归属改登录级 / 默认 owning account）。
    // 两个 Agent 各自拥有 `(spaceSessionId, agentId)` AgentSession，generation 1
    // 的 provider binding 都从空开始，因此各 counter 都从 1 开始。
    const agent2Resp = await httpRequest("POST", "/api/agents", {
      name: "VerifyMock2b",
      kind: "cli",
      provider: "mock",
      connection: {},
      model: "mock-spare",
    });
    assertEqual(agent2Resp.status, 201);
    const agent2 = agent2Resp.json.agent;

    const spaceResp = await httpRequest("POST", "/api/spaces", {
      name: "driving-space",
      seats: [
        { agentId: ctx.agent.id, responseMode: "default" },
        { agentId: agent2.id, responseMode: "default" },
      ],
    });
    assertEqual(spaceResp.status, 201);
    // Seat 不再带 accountId（4.4 反迁移）
    assert(!("accountId" in spaceResp.json.space.seats[0]), "seat must not carry accountId (4.4)");
    assert(!("accountId" in spaceResp.json.space.seats[1]), "seat must not carry accountId (4.4)");
    const driveSpace = spaceResp.json.space;

    const post = await httpRequest("POST", `/api/spaces/${driveSpace.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "driving continuity check",
    });
    assertEqual(post.status, 201);
    assertEqual(post.json.runs.length, 2, "two seats both default mode -> two runs");

    const runIds = post.json.runs.map((r) => r.id);
    const waitOne = (rid) => ctx.sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === rid, 10000);
    const [end1, end2] = await Promise.all(runIds.map(waitOne));
    assertEqual(end1.data.run.status, "completed");
    assertEqual(end2.data.run.status, "completed");

    // 两 reply 都是 "回声第 1 次"——provider binding 按 AgentSession 隔离。
    const allReplies = ctx.sse.events
      .filter(
        (e) =>
          e.type === "message.completed" &&
          [end1, end2].some((en) => en.data.run.replyMessageIds.includes(e.data.message.id)),
      )
      .map((e) => e.data.message.content)
      .join(" ");
    assert(
      /回声第 1 次/.test(allReplies) && !/回声第 2 次/.test(allReplies),
      `expected both runs' counters isolated at 1 (per-AgentSession binding), got: ${allReplies}`,
    );
  });
}

// 在 e. SSE 流程跑过后再执行：依赖 agent 已有消息历史以触发 409 拒绝删除。
export async function runDeleteAgentAfterHistory(ctx) {
  const { check, httpRequest, assertEqual } = ctx;
  await check("b. DELETE /api/agents/:id rejected once agent has message history (409)", async () => {
    const { status, json } = await httpRequest("DELETE", `/api/agents/${ctx.agent.id}`);
    assertEqual(status, 409);
    assertEqual(json.error.code, "conflict");
  });
}
