// 发消息（api-contract.md 三、POST /api/spaces/:id/messages）：创建 Message，
// 按每个 seat 的 responseMode 决定哪些 agent 产生 run。

import { newMessageId } from "../core/id.js";
import { ApiError } from "../core/errors.js";
import { getSpaceOrThrow } from "./spaces.js";
import { executeRun } from "./run-controller.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

function isAddressedTo(message, agentId) {
  return message.target.type === "direct" && Array.isArray(message.target.agentIds) && message.target.agentIds.includes(agentId);
}

// responseMode（ground-truth.md 2.3 / api-contract.md Space 一节）：
// - default：广播消息都响应；定向消息只有被点名的 agent 响应
// - focused：只响应 @ 自己（即定向消息里包含自己）
// - silent：只响应指定来源的 @（respondTo 过滤字段是 [P4]，本阶段未实现，
//   先按“只响应定向”处理，等价于 focused，等 respondTo 落地后再细化）
function shouldRespond(seat, message) {
  if (message.target.type === "direct") {
    return isAddressedTo(message, seat.agentId);
  }
  const mode = seat.responseMode ?? "default";
  return mode === "default";
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
    const adapter = resolveAdapter(agent);
    if (!adapter) continue;
    const run = executeRun({ store, hub, config, agent, space, triggerMessage: storedMessage, adapter, agentStates, memory });
    runs.push(run);
  }

  return { message: stripInternal(storedMessage), runs };
}
