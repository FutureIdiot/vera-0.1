// Forge source projection. Only completed, user-visible Message bodies cross
// this boundary; timeline process records and provider state are never read.

import { ApiError } from "../core/errors.js";

function addressedTo(message, accountId) {
  return message.target?.type !== "direct" ||
    (Array.isArray(message.target.accountIds) && message.target.accountIds.includes(accountId));
}

function visibleToTarget(message, seat) {
  if (message.author?.type === "user") return addressedTo(message, seat.accountId);
  if (message.author?.type !== "account") return false;
  if (message.author.accountId === seat.accountId) return true;
  if ((seat.blockAccountIds ?? []).includes(message.author.accountId)) return false;
  return addressedTo(message, seat.accountId);
}

function sourceAuthor(store, message) {
  if (message.author?.type === "user") return { type: "user", name: "User" };
  const account = store.find("accounts", message.author?.accountId);
  return {
    type: "account",
    accountId: message.author?.accountId,
    name: message.accountNameSnapshot ?? account?.name ?? "Account",
  };
}

export function forgeSourceForTarget(store, {
  space,
  spaceSessionId,
  sourceSeq,
  accountId,
  maxChars,
} = {}) {
  const seat = (space?.seats ?? []).find((candidate) => candidate.accountId === accountId);
  if (!seat) throw new ApiError("forbidden", `account ${accountId} is not seated in space ${space?.id}`);
  const messages = store.list("messages")
    .filter((message) =>
      message.spaceSessionId === spaceSessionId &&
      message.status === "completed" &&
      (message._seq ?? 0) <= sourceSeq &&
      visibleToTarget(message, seat))
    .sort((left, right) => (left._seq ?? 0) - (right._seq ?? 0))
    .map((message) => ({
      messageId: message.id,
      author: sourceAuthor(store, message),
      target: structuredClone(message.target ?? { type: "broadcast" }),
      content: typeof message.content === "string" ? message.content : "",
      fileIds: Array.isArray(message.fileIds) ? [...message.fileIds] : [],
      createdAt: message.createdAt ?? null,
    }));
  const charCount = messages.reduce((total, message) =>
    total + message.content.length + message.fileIds.join("").length + 96, 0);
  if (charCount > maxChars) {
    throw new ApiError("context_capacity", "Forge source exceeds the configured capacity");
  }
  return {
    messages,
    sourceMessageIds: messages.map((message) => message.messageId),
    charCount,
  };
}

export function completedMessageHighWater(store, spaceSessionId) {
  return store.list("messages")
    .filter((message) => message.spaceSessionId === spaceSessionId && message.status === "completed")
    .reduce((highest, message) => Math.max(highest, Number(message._seq) || 0), 0);
}
