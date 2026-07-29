const STATUS_LABELS = Object.freeze({
  idle: "idle",
  thinking: "thinking",
  typing: "typing",
  planning: "planning",
  searching: "searching",
  reading: "reading",
  coding: "coding",
  testing: "testing",
  reviewing: "reviewing",
  on_task: "working",
  waiting: "waiting",
  needs_you: "needs you",
  compacting: "compacting",
  delegating: "delegating",
  dreaming: "dreaming",
  away: "away",
});

function stateTime(state) {
  const timestamp = Date.parse(state?.lastActiveAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function agentStatusLabel(status) {
  return STATUS_LABELS[status] ?? "idle";
}

export function resolvePrivateAccountStatus({
  account,
  spaceId,
  agentStates = [],
} = {}) {
  if (account?.presence !== "online") return "offline";
  const candidates = agentStates
    .filter((state) => state.accountId === account.id && state.spaceId === spaceId)
    .sort((left, right) => stateTime(right) - stateTime(left));
  const activeState = account.activeAgentId
    ? candidates.find((state) => state.agentId === account.activeAgentId)
    : null;
  return agentStatusLabel((activeState ?? candidates[0])?.status ?? "idle");
}
