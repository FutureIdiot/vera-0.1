// m. 响应规则收口：Account Seat / silent / respondTo / focused /
// blockAccountIds 声告段过滤 + 直向 @ 穿透。

export async function run(ctx) {
  const { check, httpRequest, sse, assertEqual, assert, createOnlineMockAccount } = ctx;

  await check("m.1 silent 默认（respondTo=null）：广播不响应、定向 @ 响应", async () => {
    const onlineS1 = await createOnlineMockAccount({ name: "VerifyMockS1" });
    const agentS1 = onlineS1.agent;
    const accountS1 = onlineS1.account;
    const spaceResp = await httpRequest("POST", "/api/spaces", {
      name: "m1-space",
      seats: [{ accountId: accountS1.id, responseMode: "silent" }],
    });
    assertEqual(spaceResp.status, 201);
    const m1Space = spaceResp.json.space;
    assert(
      !("agentId" in m1Space.seats[0]),
      "m.1 seat should carry Account identity only",
    );

    const bc = await httpRequest("POST", `/api/spaces/${m1Space.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "m.1 broadcast",
    });
    assertEqual(bc.status, 201);
    assertEqual(bc.json.runs.length, 0, "silent 默认不应响应 broadcast");

    const dc = await httpRequest("POST", `/api/spaces/${m1Space.id}/messages`, {
      author: { type: "user" },
      target: { type: "direct", accountIds: [accountS1.id] },
      content: "m.1 direct @",
    });
    assertEqual(dc.status, 201);
    assertEqual(dc.json.runs.length, 1, "silent 默认应响应 direct @");
    assertEqual(dc.json.runs[0].agentId, agentS1.id);
    await sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === dc.json.runs[0].id, 10000);
  });

  await check("m.2 silent + respondTo=['user']：user 广播响应、agent 广播不响应、direct @ 响应", async () => {
    const onlineS2 = await createOnlineMockAccount({ name: "VerifyMockS2" });
    const agentS2 = onlineS2.agent;
    const accountS2 = onlineS2.account;
    const onlineS2b = await createOnlineMockAccount({ name: "VerifyMockS2b" });
    const agentS2b = onlineS2b.agent;
    const accountS2b = onlineS2b.account;
    const spaceResp = await httpRequest("POST", "/api/spaces", {
      name: "m2-space",
      seats: [
        { accountId: accountS2.id, responseMode: "silent", respondTo: ["user"] },
        { accountId: accountS2b.id, responseMode: "focused" },
      ],
    });
    assertEqual(spaceResp.status, 201);
    const m2Space = spaceResp.json.space;
    assertEqual(m2Space.seats[0].respondTo[0], "user", "respondTo should persist on seat");

    const bc1 = await httpRequest("POST", `/api/spaces/${m2Space.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "m.2 user broadcast",
    });
    assertEqual(bc1.status, 201);
    assertEqual(bc1.json.runs.length, 1, "silent+respondTo=['user'] 应响应 user broadcast");
    assertEqual(bc1.json.runs[0].agentId, agentS2.id);
    await sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === bc1.json.runs[0].id, 10000);

    const bc2 = await httpRequest("POST", `/api/spaces/${m2Space.id}/messages`, {
      author: { type: "account", accountId: accountS2b.id },
      target: { type: "broadcast" },
      content: "m.2 agent broadcast",
    });
    assertEqual(bc2.status, 201);
    assertEqual(bc2.json.runs.length, 0, "silent+respondTo=['user'] 不应响应 agent broadcast");

    const dc = await httpRequest("POST", `/api/spaces/${m2Space.id}/messages`, {
      author: { type: "user" },
      target: { type: "direct", accountIds: [accountS2.id] },
      content: "m.2 direct @",
    });
    assertEqual(dc.status, 201);
    assertEqual(dc.json.runs.length, 1, "silent+respondTo=['user'] 应响应 direct @");
    assertEqual(dc.json.runs[0].agentId, agentS2.id);
    await sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === dc.json.runs[0].id, 10000);
  });

  await check("m.3 focused：广播不响应、定向 @ 响应", async () => {
    const onlineF3 = await createOnlineMockAccount({ name: "VerifyMockF3" });
    const agentF3 = onlineF3.agent;
    const accountF3 = onlineF3.account;
    const spaceResp = await httpRequest("POST", "/api/spaces", {
      name: "m3-space",
      seats: [{ accountId: accountF3.id, responseMode: "focused" }],
    });
    assertEqual(spaceResp.status, 201);
    const m3Space = spaceResp.json.space;

    const bc = await httpRequest("POST", `/api/spaces/${m3Space.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "m.3 broadcast",
    });
    assertEqual(bc.status, 201);
    assertEqual(bc.json.runs.length, 0, "focused 不应响应 broadcast");

    const dc = await httpRequest("POST", `/api/spaces/${m3Space.id}/messages`, {
      author: { type: "user" },
      target: { type: "direct", accountIds: [accountF3.id] },
      content: "m.3 direct @",
    });
    assertEqual(dc.status, 201);
    assertEqual(dc.json.runs.length, 1, "focused 应响应 direct @");
    assertEqual(dc.json.runs[0].agentId, agentF3.id);
    await sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === dc.json.runs[0].id, 10000);
  });

  await check("m.4 blockAccountIds：声告段过滤 + 不影响 shouldRespond + direct @ 穿透", async () => {
    const onlineX = await createOnlineMockAccount({ name: "VerifyMockX" });
    const agentX = onlineX.agent;
    const accountX = onlineX.account;
    const onlineY = await createOnlineMockAccount({ name: "VerifyMockY" });
    const agentY = onlineY.agent;
    const accountY = onlineY.account;
    const spaceResp = await httpRequest("POST", "/api/spaces", {
      name: "m4-space",
      seats: [
        { accountId: accountX.id, responseMode: "default" },
        { accountId: accountY.id, responseMode: "default", blockAccountIds: [accountX.id] },
      ],
    });
    assertEqual(spaceResp.status, 201);
    const m4Space = spaceResp.json.space;
    assertEqual(m4Space.seats[1].blockAccountIds[0], accountX.id, "blockAccountIds should persist on seat");

    const post1 = await httpRequest("POST", `/api/spaces/${m4Space.id}/messages`, {
      author: { type: "user" },
      target: { type: "direct", accountIds: [accountX.id] },
      content: "m.4 msg1 @X",
    });
    assertEqual(post1.status, 201);
    assertEqual(post1.json.runs.length, 1);
    assertEqual(post1.json.runs[0].agentId, agentX.id);
    const end1 = await sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === post1.json.runs[0].id, 10000);
    assertEqual(end1.data.run.status, "completed");

    const tl = await httpRequest("GET", `/api/spaces/${m4Space.id}/timeline?limit=50`);
    assertEqual(tl.status, 200);
    const hasXReply = tl.json.items.some(
      (i) => i.itemType === "message" && i.author?.type === "account" && i.author?.accountId === accountX.id,
    );
    assert(hasXReply, "timeline should contain X's reply bubble (positive control)");

    const post2 = await httpRequest("POST", `/api/spaces/${m4Space.id}/messages`, {
      author: { type: "user" },
      target: { type: "direct", accountIds: [accountY.id] },
      content: "m.4 msg2 @Y",
    });
    assertEqual(post2.status, 201);
    assertEqual(post2.json.runs.length, 1, "direct @Y should create run (blockAccountIds does not block shouldRespond)");
    assertEqual(post2.json.runs[0].agentId, agentY.id);
    const end2 = await sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === post2.json.runs[0].id, 10000);
    assertEqual(end2.data.run.status, "completed");
    const yReply = sse.events
      .filter((e) => e.type === "message.completed" && end2.data.run.replyMessageIds.includes(e.data.message.id))
      .map((e) => e.data.message.content)
      .join(" ");
    assert(
      !yReply.includes(`- ${accountX.name}: `),
      `Y's reply should not contain X's signature (blockAccountIds filters announcement), got: ${yReply}`,
    );
    assert(
      yReply.includes("- 用户: "),
      `Y's reply should contain user signature (user bubbles not blocked), got: ${yReply}`,
    );

    const post3 = await httpRequest("POST", `/api/spaces/${m4Space.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "m.4 msg3 broadcast",
    });
    assertEqual(post3.status, 201);
    assertEqual(
      post3.json.runs.length,
      2,
      "broadcast should trigger both X and Y (blockAccountIds does not affect shouldRespond)",
    );
    await Promise.all(
      post3.json.runs.map((r) => sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === r.id, 10000)),
    );
  });
}
