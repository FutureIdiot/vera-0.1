// 发消息（api-contract.md 三、POST /api/spaces/:id/messages）：创建 Message，
// 按每个 seat 的 responseMode 决定哪些 agent 产生 run。

import { newActivityId, newMessageId } from "../core/id.js";
import { ApiError } from "../core/errors.js";
import { getAccountOrThrow } from "../agents/accounts.js";
import { getSpaceOrThrow } from "./spaces.js";
import { ensureActiveSpaceSession, ensureAgentSession } from "./context-sessions.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

// responseMode（ground-truth.md 2.3 / api-contract.md Space 一节）：
// - default：广播消息都响应；定向消息只有被点名的 Account 响应
// - focused：只响应 @ 自己（即定向消息里包含自己），广播一律忽略
// - silent：只响应指定来源的 @（respondTo 过滤）；广播也看 respondTo——来源在
//   名单内才响应；respondTo 缺省（null）时等价"只响应定向 @"，与 Phase 2-3 现状
//   一致。silent+respondTo=["user"] 即只接收用户的广播 + 所有人定向 @。
//
// 定向 @ 一律穿透 silent/focused/blockAccountIds（用户最终决策权）：
// `target.type==="direct" && target.accountIds.includes(seat.accountId)` 即响应，
// 不看 respondTo/blockAccountIds/responseMode。
//
// 来源判定：message.author.type === "user" 视为 "user"；Account消息则按
// author.accountId 是否在 respondTo 名单内判定。
function isAddressedTo(message, accountId) {
  return message.target.type === "direct" && Array.isArray(message.target.accountIds) && message.target.accountIds.includes(accountId);
}

function isAllowedByRespondTo(seat, message) {
  const respondTo = seat.respondTo ?? null;
  if (!respondTo || respondTo.length === 0) return false; // silent 缺省 = 只响应定向 @
  if (message.author?.type === "user") return respondTo.includes("user");
  if (message.author?.type === "account") return respondTo.includes(message.author.accountId);
  return false;
}

function shouldRespond(seat, message) {
  // 定向 @ 一律穿透——用户最终决策权
  if (message.target.type === "direct") {
    return isAddressedTo(message, seat.accountId);
  }
  // 广播
  const mode = seat.responseMode ?? "default";
  if (mode === "default") return true;
  if (mode === "focused") return false;
  if (mode === "silent") return isAllowedByRespondTo(seat, message);
  return false;
}

function publishOfflineActivity({ store, hub, space, spaceSession, account }) {
  const timestamp = new Date().toISOString();
  const activity = store.insert("activities", {
    id: newActivityId(),
    spaceId: space.id,
    spaceSessionId: spaceSession.id,
    runId: null,
    accountId: account.id,
    agentId: null,
    phase: "error",
    label: "agent-offline",
    detail: `${account.name} Account当前离线，已跳过此条`,
    toolStatus: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  hub.publish("activity.created", { activity: stripInternal(activity) });
  return activity;
}

export function postMessage({
  store, hub, daemonScheduler, memoryDigestScheduler, files, spaceId, body,
}) {
  const space = getSpaceOrThrow(store, spaceId);
  const content = typeof body?.content === "string" ? body.content : "";
  const fileIds = files.assertMessageFileIds(spaceId, body?.fileIds ?? []);
  if (!body?.author || (!content.trim() && fileIds.length === 0)) {
    throw new ApiError("invalid_request", "author and non-empty content or fileIds are required");
  }
  const controlCommand = content.trim();
  if (controlCommand === "/new" || controlCommand === "/compact") {
    throw new ApiError(
      "control_command_required",
      `${controlCommand} is a context control command and must use its dedicated endpoint`,
    );
  }

  const spaceSession = ensureActiveSpaceSession(store, spaceId);

  const target = body.target ?? { type: "broadcast" };
  const message = {
    id: newMessageId(),
    spaceId,
    spaceSessionId: spaceSession.id,
    author: body.author,
    target,
    content,
    fileIds,
    runId: null,
    status: "completed",
    createdAt: new Date().toISOString(),
  };
  const storedMessage = store.insert("messages", message);
  hub.publish("message.created", { message: files.projectMessage(stripInternal(storedMessage), spaceId) });
  memoryDigestScheduler?.onMessageCommitted(storedMessage);

  const runs = [];
  for (const seat of space.seats) {
    if (body.author?.type === "account" && body.author.accountId === seat.accountId) continue; // 不自问自答
    if (!shouldRespond(seat, message)) continue;
    const account = getAccountOrThrow(store, seat.accountId);
    const addressed = isAddressedTo(message, account.id);
    const activeAgent = account.activeAgentId ? store.find("agents", account.activeAgentId) : null;
    const isOnlineOwner = account.presence === "online" && activeAgent &&
      activeAgent.id === account.ownerAgentId;
    if (!isOnlineOwner) {
      if (addressed) publishOfflineActivity({ store, hub, space, spaceSession, account });
      continue;
    }
    const agent = activeAgent;
    const agentSession = ensureAgentSession(store, {
      spaceSessionId: spaceSession.id,
      accountId: account.id,
      agentId: agent.id,
    });
    if (!daemonScheduler?.scheduleMainRun) {
      throw new ApiError("adapter_unavailable", "daemon Run scheduler is unavailable");
    }
    const run = daemonScheduler.scheduleMainRun({
      agent, account, space, spaceSession, agentSession, triggerMessage: storedMessage,
    });
    runs.push(run);
  }

  return { message: stripInternal(storedMessage), runs };
}
