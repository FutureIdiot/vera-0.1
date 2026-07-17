import { ApiError } from "../core/errors.js";
import { createHash } from "node:crypto";

export function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(
    typeof value === "string" ? value : JSON.stringify(value ?? ""),
    "utf8",
  ) / 4);
}

export function effectiveContextLimit(config, runtime) {
  const configured = config.context.defaultLimitTokens;
  const byteLimit = config?.[runtime.provider]?.maxInputBytes;
  return Number.isFinite(byteLimit) && byteLimit > 0
    ? Math.min(configured, Math.floor(byteLimit / 4))
    : configured;
}

export function latestCheckpoint(store, agentSessionId) {
  const raw = store.find("agentSessions", agentSessionId);
  return raw?.checkpoints?.at(-1)?.checkpoint ?? null;
}

export function checkpointTurnText(turn) {
  const input = turn?.input?.content ?? "";
  const replies = (turn?.assistant ?? []).map((item) => item?.content ?? "").filter(Boolean);
  return [
    ...(input ? [`user: ${input}`] : []),
    ...replies.map((reply) => `assistant: ${reply}`),
  ].join("\n");
}

function checkpointSummary(raw, maxChars) {
  if (raw.length <= maxChars) return { text: raw, digest: null };
  const digest = createHash("sha256").update(raw).digest("hex");
  const marker = `[earlier checkpoint compacted; sha256:${digest}]`;
  if (maxChars < marker.length) {
    throw new ApiError("context_capacity", "checkpoint summary cannot fit the configured capacity");
  }
  const suffixLength = Math.max(0, maxChars - marker.length - 1);
  return { text: suffixLength ? `${marker}\n${raw.slice(-suffixLength)}` : marker, digest };
}

export function checkpointForAgent(store, {
  spaceSessionId,
  agentId,
  recentTurnLimit,
  maxChars = Number.POSITIVE_INFINITY,
  sourceSeq = Number.POSITIVE_INFINITY,
  includedRunIds = [],
}) {
  const spaceSession = store.find("spaceSessions", spaceSessionId);
  const space = spaceSession ? store.find("spaces", spaceSession.spaceId) : null;
  const ownerAccount = store.list("accounts").find((account) => account.ownerAgentId === agentId);
  const seat = space?.seats?.find((item) => item.accountId === ownerAccount?.id);
  const blockedAccountIds = new Set(seat?.blockAccountIds ?? []);
  const includedRuns = new Set(includedRunIds);
  const candidates = store.list("messages")
    .filter((item) => item.spaceSessionId === spaceSessionId && item.status === "completed")
    .filter((item) => (item._seq ?? 0) <= sourceSeq || (item.runId && includedRuns.has(item.runId)))
    .filter((item) => item.author?.type !== "account" || !blockedAccountIds.has(item.author.accountId))
    .sort((left, right) => (left._seq ?? 0) - (right._seq ?? 0));
  const messageById = new Map(candidates.map((item) => [item.id, item]));
  const availableTurns = store.list("runs")
    .filter((run) => run.spaceSessionId === spaceSessionId && run.agentId === agentId && run.status === "completed")
    .sort((left, right) => (left._seq ?? 0) - (right._seq ?? 0))
    .map((run) => {
      const input = messageById.get(run.triggerMessageId);
      const assistant = (run.replyMessageIds ?? []).map((id) => messageById.get(id)).filter(Boolean);
      if (!input || assistant.length === 0) return null;
      return {
        runId: run.id,
        input: {
          sourceMessageId: input.id,
          author: input.author,
          target: input.target,
          content: input.content ?? "",
          createdAt: input.createdAt ?? null,
        },
        assistant: assistant.map((item) => ({
          messageId: item.id,
          content: item.content ?? "",
          createdAt: item.createdAt ?? null,
        })),
      };
    })
    .filter(Boolean)
    .slice(-recentTurnLimit);
  const agentSession = store.list("agentSessions").find((item) =>
    item.spaceSessionId === spaceSessionId && item.agentId === agentId && item.status === "active");
  const priorCheckpoint = agentSession?.checkpoints?.at(-1)?.checkpoint ?? null;
  const priorSummary = priorCheckpoint?.summary ?? "";
  const priorSummaryIds = new Set(priorCheckpoint?.sourceMessageIds ?? []);
  const recentTurns = [];
  for (let index = availableTurns.length - 1; index >= 0; index -= 1) {
    const turn = availableTurns[index];
    recentTurns.unshift(turn);
    if (recentTurns.map(checkpointTurnText).filter(Boolean).join("\n\n").length > maxChars) {
      recentTurns.shift();
      break;
    }
  }
  if (availableTurns.length > 0 && recentTurns.length === 0) {
    throw new ApiError("context_capacity", "one complete recent turn exceeds checkpoint capacity");
  }

  let recentMessageIds;
  let older;
  let rawSummary;
  let recentText;
  while (true) {
    recentMessageIds = new Set(recentTurns.flatMap((turn) => [
      turn.input.sourceMessageId,
      ...turn.assistant.map((item) => item.messageId),
    ]));
    older = candidates.filter((item) => !recentMessageIds.has(item.id) && !priorSummaryIds.has(item.id));
    const olderText = older.map((item) => {
      const author = item.author?.type === "account" ? `account:${item.author.accountId}` : "user";
      return `${author}: ${item.content ?? ""}`;
    }).join("\n");
    rawSummary = [priorSummary, olderText].filter(Boolean).join("\n");
    recentText = recentTurns.map(checkpointTurnText).filter(Boolean).join("\n\n");
    const summaryBudget = maxChars - recentText.length;
    const markerLength = "[earlier checkpoint compacted; sha256:]".length + 64;
    if (rawSummary.length <= summaryBudget || summaryBudget >= markerLength) break;
    if (recentTurns.length <= 1) {
      throw new ApiError("context_capacity", "checkpoint cannot preserve summary and a complete recent turn");
    }
    recentTurns.shift();
  }
  const boundedSummary = checkpointSummary(rawSummary, maxChars - recentText.length);
  const sourceMessageIds = [...new Set([
    ...(priorCheckpoint?.sourceMessageIds ?? []),
    ...older.map((item) => item.id),
  ])];
  return {
    schemaVersion: 1,
    summary: boundedSummary.text,
    sourceMessageIds,
    omittedMessageCount: boundedSummary.digest ? older.length : 0,
    omittedDigest: boundedSummary.digest,
    recentTurns,
  };
}

export function boundApiMessages(messages, hardTokenLimit) {
  const bounded = [...messages];
  const cost = () => estimateTokens(bounded);
  // Stable system/checkpoint prefixes stay. History is removed only as complete
  // user/assistant pairs, followed by the current user input.
  const prefixCount = bounded.findIndex((item) => item.role === "user");
  const firstHistory = prefixCount < 0 ? 0 : prefixCount;
  while (cost() > hardTokenLimit && bounded.length - firstHistory > 1) {
    if (bounded[firstHistory]?.role !== "user") break;
    const nextUserOffset = bounded.slice(firstHistory + 1).findIndex((item) => item.role === "user");
    if (nextUserOffset < 0) break;
    const nextUser = firstHistory + 1 + nextUserOffset;
    bounded.splice(firstHistory, nextUser - firstHistory);
  }
  if (cost() > hardTokenLimit) {
    throw new ApiError("context_capacity", "current message exceeds the AgentSession context capacity");
  }
  return bounded;
}
