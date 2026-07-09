// g. 会话连续性 + h. 触发词（!!error / !!approve / approval answer/重复 answer）
// + i. 取消在飞 run + j. timeline 分页 + 三种 itemType。
//
// 注意（Phase 4.2 起需要）：编译层把同 Space 历史 user msg 注入声告段。若
// verify-space 之前已发过含 "!!error" 的消息，h-approve 的声告段会带上 "!!error"
// 让 mock 误触发 provider_error。所以 h-approve / i-cancel 用独立 space（无
// 历史 → 声告段为空 → prompt.text 只含 trigger，与 4.1 前行为一致）；j-timeline
// 改用 h-approve 的 space（那里有完整 message+activity+approval 三种 itemType）；
// j-pagination 仍用 verify-space。

export async function run(ctx) {
  const { check, httpRequest, sse, assertEqual, assert, sleep } = ctx;
  const { space } = ctx;

  await check("g. sessionState counter increments across successive messages", async () => {
    const { status, json } = await httpRequest("POST", `/api/spaces/${space.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "second message",
    });
    assertEqual(status, 201);
    const runId = json.runs[0].id;
    const runEnded = await sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === runId, 10000);
    assertEqual(runEnded.data.run.status, "completed");
    const replyIds = runEnded.data.run.replyMessageIds;
    const combined = sse.events
      .filter((e) => e.type === "message.completed" && replyIds.includes(e.data.message.id))
      .map((e) => e.data.message.content)
      .join(" ");
    assert(/回声第 2 次/.test(combined), `expected mock counter at 2 in reply, got: ${combined}`);
  });

  await check("h. '!!error' trigger word ends run failed with error.code", async () => {
    const { status, json } = await httpRequest("POST", `/api/spaces/${space.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "please !!error now",
    });
    assertEqual(status, 201);
    const runId = json.runs[0].id;
    const runEnded = await sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === runId, 10000);
    assertEqual(runEnded.data.run.status, "failed");
    assert(
      runEnded.data.run.error?.code === "provider_error",
      `expected error.code provider_error, got ${JSON.stringify(runEnded.data.run.error)}`,
    );
  });

  // 用独立 space 避免 verify-space 历史 !!error 经声告段污染 h-approve。
  let hApproveSpace;
  await check("h. '!!approve' trigger word raises approval.requested", async () => {
    const sp = await httpRequest("POST", "/api/spaces", {
      name: "h-approve-space",
      seats: [{ agentId: ctx.agent.id, responseMode: "default" }],
    });
    assertEqual(sp.status, 201);
    hApproveSpace = sp.json.space;
    ctx.hApproveSpace = hApproveSpace;

    const { status, json } = await httpRequest("POST", `/api/spaces/${hApproveSpace.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "deploy it !!approve",
    });
    assertEqual(status, 201);
    ctx.approveRunId = json.runs[0].id;
    const requested = await sse.waitFor((e) => e.type === "approval.requested" && e.data.approval.runId === ctx.approveRunId, 10000);
    assertEqual(requested.data.approval.status, "pending");
    assert(Array.isArray(requested.data.approval.options) && requested.data.approval.options.includes("allow"));
    ctx.approvalId = requested.data.approval.id;
  });

  await check("h. POST /api/approvals/:id/answer resolves the approval (allow)", async () => {
    const { status, json } = await httpRequest("POST", `/api/approvals/${ctx.approvalId}/answer`, { answer: "allow" });
    assertEqual(status, 200);
    assertEqual(json.approval.status, "answered");
    assertEqual(json.approval.answer, "allow");
    await sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === ctx.approveRunId, 10000);
  });

  await check("h. repeated answer on the same approval returns 409 conflict", async () => {
    const { status, json } = await httpRequest("POST", `/api/approvals/${ctx.approvalId}/answer`, { answer: "deny" });
    assertEqual(status, 409);
    assertEqual(json.error.code, "conflict");
  });

  await check("i. POST /api/runs/:id/cancel cancels an in-flight run", async () => {
    // 独立 space 避免 i-cancel 被 h-approve 历史"!!approve"污染触发链
    const sp = await httpRequest("POST", "/api/spaces", {
      name: "i-cancel-space",
      seats: [{ agentId: ctx.agent.id, responseMode: "default" }],
    });
    assertEqual(sp.status, 201);
    const cancelSpace = sp.json.space;
    const { status, json } = await httpRequest("POST", `/api/spaces/${cancelSpace.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "long running task for cancel test",
    });
    assertEqual(status, 201);
    const runId = json.runs[0].id;
    await sleep(50);
    const cancelResp = await httpRequest("POST", `/api/runs/${runId}/cancel`, {});
    assertEqual(cancelResp.status, 200);
    const runEnded = await sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === runId, 10000);
    assertEqual(runEnded.data.run.status, "cancelled");
  });

  await check("j. GET timeline includes message/activity/approval itemTypes", async () => {
    // 用 hApproveSpace：那里有完整 message + activity + approval 三种 itemType
    const { status, json } = await httpRequest("GET", `/api/spaces/${ctx.hApproveSpace.id}/timeline?limit=500`);
    assertEqual(status, 200);
    assert(Array.isArray(json.items), "timeline response should have items array");
    const types = new Set(json.items.map((i) => i.itemType));
    assert(types.has("message"), `expected a message itemType, got types: ${[...types]}`);
    assert(types.has("activity"), `expected an activity itemType, got types: ${[...types]}`);
    assert(types.has("approval"), `expected an approval itemType, got types: ${[...types]}`);
  });

  await check("j. GET timeline before/limit pagination does not repeat items", async () => {
    // j-pagination 仍用 verify-space（那里有足够多时间线条目可分页）
    const page1 = await httpRequest("GET", `/api/spaces/${space.id}/timeline?limit=3`);
    assertEqual(page1.status, 200);
    assertEqual(page1.json.items.length, 3, "first page should have exactly `limit` items");
    const cursor = page1.json.items[page1.json.items.length - 1].id;
    const page2 = await httpRequest("GET", `/api/spaces/${space.id}/timeline?before=${cursor}&limit=3`);
    assertEqual(page2.status, 200);
    const page1Ids = new Set(page1.json.items.map((i) => i.id));
    for (const item of page2.json.items) {
      assert(!page1Ids.has(item.id), `page2 item ${item.id} should not repeat page1`);
    }
  });
}