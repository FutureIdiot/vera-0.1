// a. /api/health 与 /api/bootstrap：建立第一条 SSE 连接，放进 ctx.sse 供后续
// 各 check 段复用。

export async function run(ctx) {
  const { check, httpRequest, assertEqual, assert, connectSse } = ctx;

  await check("a. GET /api/health returns { app, ok } shape", async () => {
    const { status, json } = await httpRequest("GET", "/api/health");
    assertEqual(status, 200);
    assertEqual(json.app, "vera");
    assertEqual(json.ok, true);
  });

  await check("a. GET /api/bootstrap returns agents/accounts/spaces/agentStates/seq shape", async () => {
    const { status, json } = await httpRequest("GET", "/api/bootstrap");
    assertEqual(status, 200);
    assert(Array.isArray(json.agents), "agents should be an array");
    assert(Array.isArray(json.accounts), "accounts should be an array (4.1)");
    assert(Array.isArray(json.spaces), "spaces should be an array");
    assert(Array.isArray(json.agentStates), "agentStates should be an array");
    assert(typeof json.seq === "number", "seq should be a number");
    ctx.bootstrap = json;
  });

  // 从 bootstrap 时刻的 seq 开始订阅，后续所有实时事件都会被这条持久连接捕获。
  // ctx.connectSse 自动把 handle 注册进 openSseHandles 以便 cleanup。
  ctx.sse = await connectSse({ port: ctx.port, since: ctx.bootstrap?.seq ?? 0 });
}