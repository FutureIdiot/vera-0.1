import { createHash } from "node:crypto";
import { ApiError } from "../core/errors.js";

function invalid(message) {
  return new ApiError("invalid_request", message);
}

export function countUnicodeCodePoints(value) {
  return [...String(value ?? "")].length;
}

function isVisibleToAgent(message, agentId, accountId, blockedAccountIds) {
  if (message.author?.type === "account" && message.executingAgentId === agentId) return true;
  const directlyAddressed = message.target?.type === "direct" && message.target.accountIds?.includes(accountId);
  if (directlyAddressed) return true;
  if (message.target?.type !== "broadcast") return false;
  return !(message.author?.type === "account" && blockedAccountIds.has(message.author.accountId));
}

function orderedCompletedMessages(store, spaceId, spaceSessionId, agentId) {
  const space = store.find("spaces", spaceId);
  if (!space) throw new ApiError("not_found", `Space ${spaceId} does not exist`);
  const account = store.list("accounts").find((candidate) => candidate.ownerAgentId === agentId);
  const seat = space.seats?.find((candidate) => candidate.accountId === account?.id);
  if (!seat) throw invalid(`agent ${agentId} is not seated in Space ${spaceId}`);
  const blocked = new Set(seat.blockAccountIds ?? []);
  return store.list("messages")
    .filter((message) => message.spaceId === spaceId && message.spaceSessionId === spaceSessionId &&
      message.status === "completed" && isVisibleToAgent(message, agentId, account.id, blocked))
    .sort((left, right) => (left._seq ?? 0) - (right._seq ?? 0));
}

export function resolveDigestRange({ store, agentId, spaceId, spaceSessionId, fromMessageId, toMessageId }) {
  if (!store || typeof store.list !== "function") throw new Error("resolveDigestRange requires store");
  if (typeof agentId !== "string" || !agentId) throw invalid("agentId is required");
  if (typeof spaceId !== "string" || !spaceId) throw invalid("spaceId is required");
  if (typeof spaceSessionId !== "string" || !spaceSessionId) throw invalid("spaceSessionId is required");
  if (typeof fromMessageId !== "string" || !fromMessageId) throw invalid("fromMessageId is required");
  if (typeof toMessageId !== "string" || !toMessageId) throw invalid("toMessageId is required");

  const all = store.list("messages");
  const from = all.find((message) => message.id === fromMessageId);
  const to = all.find((message) => message.id === toMessageId);
  if (!from || !to) throw new ApiError("not_found", "digest range Message does not exist");
  if (from.spaceId !== spaceId || to.spaceId !== spaceId) throw invalid("digest range must belong to the bound Space");
  if (!from.spaceSessionId || !to.spaceSessionId) throw invalid("digest range Messages must carry spaceSessionId");
  if (from.spaceSessionId !== spaceSessionId || to.spaceSessionId !== spaceSessionId) {
    throw invalid("digest range must belong to the bound SpaceSession");
  }
  const visible = orderedCompletedMessages(store, spaceId, spaceSessionId, agentId);
  if (!visible.some((message) => message.id === from.id) || !visible.some((message) => message.id === to.id)) {
    throw invalid("digest range boundaries must be completed Messages visible to the Agent");
  }
  if ((from._seq ?? 0) > (to._seq ?? 0)) throw invalid("fromMessageId must not follow toMessageId");

  const messages = visible
    .filter((message) => (message._seq ?? 0) >= (from._seq ?? 0) && (message._seq ?? 0) <= (to._seq ?? 0));
  if (messages.length === 0) throw invalid("digest range contains no completed Messages");
  return {
    messages,
    range: {
      fromMessageId: messages[0].id,
      toMessageId: messages.at(-1).id,
      fromSeq: messages[0]._seq,
      toSeq: messages.at(-1)._seq,
      messageCount: messages.length,
      charCount: messages.reduce((total, message) => total + countUnicodeCodePoints(message.content), 0),
    },
  };
}

export function resolveIncrementalDigestRange({ store, jobs = [], agentId, spaceId, spaceSessionId, toMessageId }) {
  if (typeof spaceSessionId !== "string" || !spaceSessionId) throw invalid("spaceSessionId is required");
  const completed = orderedCompletedMessages(store, spaceId, spaceSessionId, agentId);
  if (completed.length === 0) return null;
  const to = toMessageId ? completed.find((message) => message.id === toMessageId) : completed.at(-1);
  if (!to) throw invalid("incremental toMessageId must be a completed Message in the bound Space");

  const succeededWatermarks = jobs
    .filter((job) => job.agentId === agentId && job.spaceSessionId === spaceSessionId &&
      job.mode === "incremental" && job.status === "succeeded")
    .map((job) => job.range?.toSeq ?? store.find("messages", job.range?.toMessageId)?._seq)
    .filter(Number.isFinite);
  const watermark = succeededWatermarks.length > 0 ? Math.max(...succeededWatermarks) : -Infinity;
  const window = completed.filter((message) => (message._seq ?? 0) > watermark && (message._seq ?? 0) <= (to._seq ?? 0));
  if (window.length === 0) return null;
  return resolveDigestRange({
    store,
    agentId,
    spaceId,
    spaceSessionId,
    fromMessageId: window[0].id,
    toMessageId: window.at(-1).id,
  });
}

export function chunkDigestMessages(messages, { maxChars = 8000 } = {}) {
  if (!Number.isInteger(maxChars) || maxChars <= 0) throw invalid("digest chunk maxChars must be a positive integer");
  const chunks = [];
  let current = [];
  let charCount = 0;
  const push = () => {
    if (current.length === 0) return;
    chunks.push({
      id: `dch_${createHash("sha256").update(current.map((message) => message.id).join("|")).digest("hex").slice(0, 16)}`,
      fromMessageId: current[0].id,
      toMessageId: current.at(-1).id,
      messageCount: current.length,
      charCount,
      messages: current.map(({ id, author, target, content, createdAt }) => ({ messageId: id, author, target, content, createdAt })),
    });
    current = [];
    charCount = 0;
  };
  for (const message of messages) {
    const size = countUnicodeCodePoints(message.content);
    if (current.length > 0 && charCount + size > maxChars) push();
    current.push(message);
    charCount += size;
    if (charCount >= maxChars) push();
  }
  push();
  return chunks;
}
