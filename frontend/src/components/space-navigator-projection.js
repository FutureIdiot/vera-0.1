import { getSpaceType } from "../../../src/spaces/space-types.js";

export function directoryKey(space) {
  if (space.groupId) return `group:${space.groupId}`;
  return `account:${space.seats?.[0]?.accountId ?? "none"}`;
}

export function activityTime(space) {
  return Date.parse(space.updatedAt ?? space.createdAt ?? "") || 0;
}

export function formatSpaceActivity(space) {
  const elapsed = Math.max(0, Date.now() - activityTime(space));
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}时`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}天` : `${Math.floor(days / 30)}月`;
}

export function directoryProjection(accounts, groups, spaces) {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const entries = accounts.map((account) => ({
    key: `account:${account.id}`,
    kind: "direct",
    id: account.id,
    label: account.name,
    topic: "",
    accountIds: [account.id],
    accounts: [account],
  }));
  for (const group of groups) {
    entries.push({
      key: `group:${group.id}`,
      kind: "group",
      id: group.id,
      label: group.name,
      topic: group.topic,
      accountIds: group.accountIds,
      accounts: group.accountIds.map((id) => byId.get(id)).filter(Boolean),
      group,
    });
  }
  return entries.sort((left, right) => {
    const latest = (entry) => Math.max(
      0,
      ...spaces.filter((space) => directoryKey(space) === entry.key).map(activityTime),
    );
    return latest(right) - latest(left) || left.label.localeCompare(right.label);
  });
}

export function projectMeta(projects, projectId) {
  return projects.find((project) => project.id === projectId) ?? { id: "", name: "No project" };
}

export function filterAndSortSpaces(spaces, projects, query) {
  const q = query.trim().toLocaleLowerCase();
  return spaces
    .filter((space) => {
      const project = projectMeta(projects, space.projectId);
      const haystack = [
        space.name,
        space.topic,
        getSpaceType(space.spaceType).label,
        project.name,
      ].join(" ").toLocaleLowerCase();
      return !q || haystack.includes(q);
    })
    .sort((left, right) => activityTime(right) - activityTime(left) || left.name.localeCompare(right.name));
}

export function resolveSpaceCreationTarget(accounts, groups, selectedKey) {
  const entry = directoryProjection(accounts, groups, []).find((candidate) => candidate.key === selectedKey);
  return {
    groupId: entry?.kind === "group" ? entry.id : null,
    seats: (entry?.accountIds ?? []).map((accountId) => ({ accountId, responseMode: "default" })),
  };
}
