// 发消息（api-contract.md 三、POST /api/spaces/:id/messages）：创建 Message，
// 按每个 seat 的 responseMode 决定哪些 agent 产生 run。

import { newActivityId, newMessageId } from "../core/id.js";
import { ApiError } from "../core/errors.js";
import { getAccountOrThrow } from "../agents/accounts.js";
import { getSpaceOrThrow, touchSpaceUpdatedAt } from "./spaces.js";
import { ensureActiveSpaceSession, ensureAgentSession } from "./context-sessions.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

// responseMode（ground-truth.md 2.3 / api-contract.md Space 一节）：
// - default：所有未屏蔽广播触发，明确 @ 始终触发
// - focused：只有 respondTo 来源的未屏蔽广播触发，明确 @ 始终触发
// - mentioned：广播不触发，只有明确 @ 触发
//
// 定向 @ 一律穿透 focused/mentioned/blockAccountIds（用户最终决策权）：
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
  if (!respondTo || respondTo.length === 0) return false;
  if (message.author?.type === "user") return respondTo.includes("user");
  if (message.author?.type === "account") return respondTo.includes(message.author.accountId);
  return false;
}

export function shouldRespond(seat, message) {
  // 定向 @ 一律穿透——用户最终决策权
  if (message.target.type === "direct") {
    return isAddressedTo(message, seat.accountId);
  }
  // 广播
  if (message.author?.type === "account" && seat.blockAccountIds?.includes(message.author.accountId)) {
    return false;
  }
  const mode = seat.responseMode ?? "default";
  if (mode === "default") return true;
  if (mode === "focused") return isAllowedByRespondTo(seat, message);
  if (mode === "mentioned") return false;
  return false;
}

function publishOfflineActivity({ store, hub, space, spaceSession, account, observation }) {
  const timestamp = new Date().toISOString();
  const activity = store.insert("activities", {
    id: newActivityId(),
    spaceId: space.id,
    spaceSessionId: spaceSession.id,
    runId: null,
    accountId: account.id,
    agentId: null,
    phase: "error",
    kind: "error",
    label: "agent-offline",
    summary: `${account.name} 当前离线，已跳过`,
    detail: `${account.name} Account当前离线，已跳过此条`,
    toolStatus: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  hub.publish("activity.created", {
    activity: observation?.projectActivity(stripInternal(activity)) ?? stripInternal(activity),
  });
  return activity;
}

export function postMessage({
  store, hub, daemonScheduler, memoryDigestScheduler, extensionHooks, files, observation, runBackground, runMessages, spaceId, body,
}) {
  const space = getSpaceOrThrow(store, spaceId);
  const content = typeof body?.content === "string" ? body.content : "";
  const fileIds = files.assertMessageFileIds(spaceId, body?.fileIds ?? []);
  if (!body?.author || (!content.trim() && fileIds.length === 0)) {
    throw new ApiError("invalid_request", "author and non-empty content or fileIds are required");
  }
  const controlCommand = content.trim();
  if (["/new", "/compact", "/resume", "/forge"].includes(controlCommand)) {
    throw new ApiError(
      "control_command_required",
      `${controlCommand} is a context control command and must use its dedicated endpoint`,
    );
  }

  const spaceSession = ensureActiveSpaceSession(store, spaceId);

  const target = body.target ?? { type: "broadcast" };
  const authorRun = body.author?.type === "account"
    ? store.list("runs").find((run) =>
      run.accountId === body.author.accountId &&
      run.spaceId === spaceId &&
      run.spaceSessionId === spaceSession.id &&
      run.outputPolicy === "space" &&
      ["pending", "running"].includes(run.status))
    : null;
  const message = {
    id: newMessageId(),
    spaceId,
    spaceSessionId: spaceSession.id,
    author: body.author,
    target,
    content,
    fileIds,
    runId: authorRun?.id ?? null,
    status: "completed",
    createdAt: new Date().toISOString(),
  };
  const storedMessage = store.insert("messages", message);
  const updatedSpace = touchSpaceUpdatedAt(store, spaceId, storedMessage.createdAt);
  hub.publish("message.created", { message: files.projectMessage(stripInternal(storedMessage), spaceId) });
  hub.publish("space.updated", { space: updatedSpace });
  extensionHooks?.onMessageCommitted?.({ message: storedMessage, space });
  memoryDigestScheduler?.onMessageCommitted(storedMessage);

  if (body.author?.type === "account") {
    if (!authorRun) {
      publishOfflineActivity({
        store,
        hub,
        space,
        spaceSession,
        account: getAccountOrThrow(store, body.author.accountId),
        observation,
      });
      return { message: stripInternal(storedMessage), runs: [] };
    }
    const delegated = runMessages?.routeAccountMessage?.(storedMessage) ?? [];
    return {
      message: stripInternal(storedMessage),
      runs: delegated.map((item) => item.run).filter(Boolean),
    };
  }

  const runs = [];
  for (const seat of space.seats) {
    if (!shouldRespond(seat, message)) continue;
    const account = getAccountOrThrow(store, seat.accountId);
    const addressed = isAddressedTo(message, account.id);
    const activeAgent = account.activeAgentId ? store.find("agents", account.activeAgentId) : null;
    const isOnlineOwner = account.presence === "online" && activeAgent &&
      activeAgent.id === account.ownerAgentId;
    if (!isOnlineOwner) {
      if (addressed) publishOfflineActivity({ store, hub, space, spaceSession, account, observation });
      continue;
    }
    const agent = activeAgent;
    const agentSession = ensureAgentSession(store, {
      spaceSessionId: spaceSession.id,
      accountId: account.id,
      agentId: agent.id,
    });
    if (!daemonScheduler?.scheduleRootRun) {
      throw new ApiError("adapter_unavailable", "daemon Run scheduler is unavailable");
    }
    const blockingBackground = runBackground?.blockingFor?.(space.id, account.id) ?? null;
    if (blockingBackground && !addressed) continue;
    const run = daemonScheduler.scheduleRootRun({
      agent,
      account,
      space,
      spaceSession,
      agentSession,
      triggerMessage: storedMessage,
      deferredByRunId: blockingBackground?.runId ?? null,
    });
    if (blockingBackground) runBackground.deferRoot(space.id, account.id, run.id);
    runs.push(run);
  }

  return { message: stripInternal(storedMessage), runs };
}
