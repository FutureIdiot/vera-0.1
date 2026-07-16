// l. Speaker view 编译层（Phase 4.2）：群聊声告段 / Activity 不进 prompt /
// 常驻索引仅首次注入 / 上限截断 hint。mock adapter 把 prompt.text 原样 echo
// 进回复，所以断言走"agent reply content 里能否看到编译层拼出的片段"。

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function run(ctx) {
  const { check, httpRequest, sse, assertEqual, assert, dataDir } = ctx;

  // 模块局部状态：l.1 拿到的 agentB reply content 给 l.2 阳性对照用。
  let agentB;
  let l1Space;
  let l1AgentBReplyContent = null;

  await check("l.1 群聊声告段：被 @ 的 agentB echo reply 含他人署名", async () => {
    const agentBResp = await httpRequest("POST", "/api/agents", {
      name: "VerifyMockB",
      kind: "cli",
      provider: "mock",
      connection: {},
      model: "mock-v1",
    });
    assertEqual(agentBResp.status, 201);
    agentB = agentBResp.json.agent;

    const spaceResp = await httpRequest("POST", "/api/spaces", {
      name: "l1-space",
      seats: [
        { agentId: ctx.agent.id, responseMode: "default" },
        { agentId: agentB.id, responseMode: "default" },
      ],
    });
    assertEqual(spaceResp.status, 201);
    l1Space = spaceResp.json.space;

    const l1UserMsg1Content = "l.1 第一条用户消息 @agent";
    const post1 = await httpRequest("POST", `/api/spaces/${l1Space.id}/messages`, {
      author: { type: "user" },
      target: { type: "direct", agentIds: [ctx.agent.id] },
      content: l1UserMsg1Content,
    });
    assertEqual(post1.status, 201);
    assertEqual(post1.json.runs.length, 1, "only @agent should respond to direct @agent");
    assertEqual(post1.json.runs[0].agentId, ctx.agent.id);

    const runEnded1 = await sse.waitFor(
      (e) => e.type === "run.ended" && e.data.run.id === post1.json.runs[0].id,
      10000,
    );
    assertEqual(runEnded1.data.run.status, "completed");

    const post2 = await httpRequest("POST", `/api/spaces/${l1Space.id}/messages`, {
      author: { type: "user" },
      target: { type: "direct", agentIds: [agentB.id] },
      content: "l.1 第二条 @agentB 触发",
    });
    assertEqual(post2.status, 201);
    assertEqual(post2.json.runs.length, 1, "only @agentB should respond to direct @agentB");
    assertEqual(post2.json.runs[0].agentId, agentB.id);

    const runEnded2 = await sse.waitFor(
      (e) => e.type === "run.ended" && e.data.run.id === post2.json.runs[0].id,
      10000,
    );
    assertEqual(runEnded2.data.run.status, "completed");
    const replyIds2 = runEnded2.data.run.replyMessageIds;
    l1AgentBReplyContent = sse.events
      .filter((e) => e.type === "message.completed" && replyIds2.includes(e.data.message.id))
      .map((e) => e.data.message.content)
      .join(" ");

    assert(
      l1AgentBReplyContent.includes("=== 群内最近发言 ==="),
      `expected group delta header in agentB reply, got: ${l1AgentBReplyContent}`,
    );
    assert(
      l1AgentBReplyContent.includes(`- 用户: ${l1UserMsg1Content}`),
      `expected user signature with msg1 content, got: ${l1AgentBReplyContent}`,
    );
    const sig = `- ${ctx.agent.name}: `;
    const sigIdx = l1AgentBReplyContent.indexOf(sig);
    assert(sigIdx !== -1, `expected agent ${ctx.agent.name} signature line, got: ${l1AgentBReplyContent}`);
    const afterSig = l1AgentBReplyContent.slice(sigIdx + sig.length);
    assert(/回声第 \d+ 次/.test(afterSig), `expected echo counter after agent signature, got: ${afterSig}`);
  });

  await check("l.2 Activity 不进 prompt：agentB echo reply 不含 '5 passed'，timeline 有该 activity", async () => {
    assert(l1AgentBReplyContent, "l.1 must have captured agentB reply content first");
    assert(
      !l1AgentBReplyContent.includes("5 passed"),
      `agentB echo reply must not contain '5 passed' (Activity must not leak into prompt), got: ${l1AgentBReplyContent}`,
    );

    const tl = await httpRequest("GET", `/api/spaces/${l1Space.id}/timeline?limit=500`);
    assertEqual(tl.status, 200);
    const hasActivity = tl.json.items.some(
      (i) => i.itemType === "activity" && (i.detail ?? "").includes("5 passed"),
    );
    assert(hasActivity, `timeline should contain an activity with '5 passed' detail (positive control)`);
  });

  await check("l.3 常驻索引块仅首次注入", async () => {
    const vaultPath = join(dataDir, "memory");
    const decisionFile = `---
type: decision
description: 测试常驻索引注入
status: active
stains: {}
createdAt: 2026-07-08T00:00:00.000Z
updatedAt: 2026-07-08T00:00:00.000Z
---

测试正文
`;
    const agentCResp = await httpRequest("POST", "/api/agents", {
      name: "VerifyMockC",
      kind: "cli",
      provider: "mock",
      connection: {},
      model: "mock-v1",
    });
    assertEqual(agentCResp.status, 201);
    const agentC = agentCResp.json.agent;
    const agentVaultPath = join(vaultPath, agentC.id);
    await mkdir(agentVaultPath, { recursive: true });
    await writeFile(join(agentVaultPath, "decision-test.md"), decisionFile, "utf8");

    const spaceResp = await httpRequest("POST", "/api/spaces", {
      name: "l3-space",
      seats: [{ agentId: agentC.id, responseMode: "default" }],
    });
    assertEqual(spaceResp.status, 201);
    const l3Space = spaceResp.json.space;

    const post1 = await httpRequest("POST", `/api/spaces/${l3Space.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "l.3 第一条 broadcast",
    });
    assertEqual(post1.status, 201);
    const runEnded1 = await sse.waitFor(
      (e) => e.type === "run.ended" && e.data.run.id === post1.json.runs[0].id,
      10000,
    );
    assertEqual(runEnded1.data.run.status, "completed");
    const reply1 = sse.events
      .filter((e) => e.type === "message.completed" && runEnded1.data.run.replyMessageIds.includes(e.data.message.id))
      .map((e) => e.data.message.content)
      .join(" ");
    assert(/Vera 记忆库常驻索引/.test(reply1), `first reply should contain resident index header, got: ${reply1}`);
    assert(/\[\[decision-test\]\]/.test(reply1), `first reply should contain [[decision-test]], got: ${reply1}`);

    const post2 = await httpRequest("POST", `/api/spaces/${l3Space.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "l.3 第二条 broadcast",
    });
    assertEqual(post2.status, 201);
    const runEnded2 = await sse.waitFor(
      (e) => e.type === "run.ended" && e.data.run.id === post2.json.runs[0].id,
      10000,
    );
    assertEqual(runEnded2.data.run.status, "completed");
    const reply2 = sse.events
      .filter((e) => e.type === "message.completed" && runEnded2.data.run.replyMessageIds.includes(e.data.message.id))
      .map((e) => e.data.message.content)
      .join(" ");
    assert(
      !/Vera 记忆库常驻索引/.test(reply2),
      `second reply should NOT contain resident index header (generation already has a provider binding), got: ${reply2}`,
    );
  });

  await check("l.4 上限截断 hint 出现", async () => {
    const newAgentResp = await httpRequest("POST", "/api/agents", {
      name: "VerifyMockD",
      kind: "cli",
      provider: "mock",
      connection: {},
      model: "mock-v1",
    });
    assertEqual(newAgentResp.status, 201);
    const newAgent = newAgentResp.json.agent;

    const spaceResp = await httpRequest("POST", "/api/spaces", {
      name: "l4-space",
      seats: [
        { agentId: ctx.agent.id, responseMode: "default" },
        { agentId: newAgent.id, responseMode: "focused" },
      ],
    });
    assertEqual(spaceResp.status, 201);
    const l4Space = spaceResp.json.space;

    const broadcastRunIds = [];
    for (let i = 0; i < 5; i += 1) {
      const post = await httpRequest("POST", `/api/spaces/${l4Space.id}/messages`, {
        author: { type: "user" },
        target: { type: "broadcast" },
        content: `l.4 broadcast 消息编号 ${i} ${"x".repeat(40)}`,
      });
      assertEqual(post.status, 201);
      assertEqual(post.json.runs.length, 1, "only default-mode agent should respond to broadcast");
      broadcastRunIds.push(post.json.runs[0].id);
    }
    await Promise.all(
      broadcastRunIds.map((rid) => sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === rid, 15000)),
    );

    for (let i = 0; i < 25; i += 1) {
      const post = await httpRequest("POST", `/api/spaces/${l4Space.id}/messages`, {
        author: { type: "user" },
        target: { type: "direct", agentIds: ["agt_nonexistent"] },
        content: `l.4 direct 消息编号 ${i}`,
      });
      assertEqual(post.status, 201);
      assertEqual(post.json.runs.length, 0, "direct @ nonexistent agent should not trigger run");
    }

    const triggerPost = await httpRequest("POST", `/api/spaces/${l4Space.id}/messages`, {
      author: { type: "user" },
      target: { type: "direct", agentIds: [newAgent.id] },
      content: "l.4 触发 newAgent",
    });
    assertEqual(triggerPost.status, 201);
    assertEqual(triggerPost.json.runs.length, 1);

    const runEnded = await sse.waitFor(
      (e) => e.type === "run.ended" && e.data.run.id === triggerPost.json.runs[0].id,
      10000,
    );
    assertEqual(runEnded.data.run.status, "completed");
    const newAgentReply = sse.events
      .filter((e) => e.type === "message.completed" && runEnded.data.run.replyMessageIds.includes(e.data.message.id))
      .map((e) => e.data.message.content)
      .join(" ");
    assert(
      newAgentReply.includes("可用 fetch_detail 主动调阅"),
      `expected truncation hint in newAgent reply, got: ${newAgentReply}`,
    );
  });
}
