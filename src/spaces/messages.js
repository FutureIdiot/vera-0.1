// 发消息（api-contract.md 三、POST /api/spaces/:id/messages）：创建 Message，
// 按每个 seat 的 responseMode 决定哪些 agent 产生 run。

import { newMessageId } from "../core/id.js";
import { ApiError } from "../core/errors.js";
import { getOwningAccount } from "../agents/accounts.js";
import { getSpaceOrThrow } from "./spaces.js";
import { executeRun } from "./run-controller.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

// responseMode（ground-truth.md 2.3 / api-contract.md Space 一节）：
// - default：广播消息都响应；定向消息只有被点名的 agent 响应
// - focused：只响应 @ 自己（即定向消息里包含自己），广播一律忽略
// - silent：只响应指定来源的 @（respondTo 过滤）；广播也看 respondTo——来源在
//   名单内才响应；respondTo 缺省（null）时等价"只响应定向 @"，与 Phase 2-3 现状
//   一致。silent+respondTo=["user"] 即只接收用户的广播 + 所有人定向 @。
//
// 定向 @ 一律穿透 silent/focused/blockAgentIds（用户最终决策权，ground truth
// 2.3）：`target.type==="direct" && target.agentIds.includes(seat.agentId)` 即
// 响应，不看 respondTo/blockAgentIds/responseMode。
//
// 来源判定：message.author.type === "user" 视为 "user"；author.type === "agent"
// 且 author.agentId 在 respondTo 名单内才放行；否则不放行。
function isAddressedTo(message, agentId) {
  return message.target.type === "direct" && Array.isArray(message.target.agentIds) && message.target.agentIds.includes(agentId);
}

function isAllowedByRespondTo(seat, message) {
  const respondTo = seat.respondTo ?? null;
  if (!respondTo || respondTo.length === 0) return false; // silent 缺省 = 只响应定向 @
  if (message.author?.type === "user") return respondTo.includes("user");
  if (message.author?.type === "agent") return respondTo.includes(message.author.agentId);
  return false;
}

function shouldRespond(seat, message) {
  // 定向 @ 一律穿透——用户最终决策权
  if (message.target.type === "direct") {
    return isAddressedTo(message, seat.agentId);
  }
  // 广播
  const mode = seat.responseMode ?? "default";
  if (mode === "default") return true;
  if (mode === "focused") return false;
  if (mode === "silent") return isAllowedByRespondTo(seat, message);
  return false;
}

export function postMessage({ store, hub, config, resolveAdapter, agentStates, memory, spaceId, body }) {
  const space = getSpaceOrThrow(store, spaceId);
  if (!body?.author || !body?.content) {
    throw new ApiError("invalid_request", "author and content are required");
  }

  const target = body.target ?? { type: "broadcast" };
  const message = {
    id: newMessageId(),
    spaceId,
    author: body.author,
    target,
    content: body.content,
    runId: null,
    status: "completed",
    createdAt: new Date().toISOString(),
  };
  const storedMessage = store.insert("messages", message);
  hub.publish("message.created", { message: stripInternal(storedMessage) });

  const runs = [];
  for (const seat of space.seats) {
    if (body.author?.type === "agent" && body.author.agentId === seat.agentId) continue; // 不自问自答
    if (!shouldRespond(seat, message)) continue;
    const agent = store.find("agents", seat.agentId);
    if (!agent) continue;

    // 解析 account：4.4 起 Seat 不再携带 accountId（账户归属改登录级或默认 owning
    // account，见 ground-truth 2.2 修订）。统一走 getOwningAccount。
    const account = getOwningAccount(store, seat.agentId);
    if (!account) continue;

    const adapter = resolveAdapter(account);
    if (!adapter) continue;
    const run = executeRun({ store, hub, config, agent, account, space, triggerMessage: storedMessage, adapter, agentStates, memory });
    runs.push(run);
  }

  return { message: stripInternal(storedMessage), runs };
}
