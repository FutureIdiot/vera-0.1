import { getSpaceType } from "../../../src/spaces/space-types.js";

export function directoryKey(space) {
  if (space.groupId) return `group:${space.groupId}`;
  return `account:${space.seats?.[0]?.accountId ?? "none"}`;
}

export function activityTime(space) {
  return Date.parse(space.updatedAt ?? space.createdAt ?? "") || 0;
}

export function directoryProjection(accounts, groups, spaces) {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const entries = accounts.map((account) => ({
    key: `account:${account.id}`,
    kind: "direct",
    id: account.id,
    label: account.name,
    accountIds: [account.id],
    accounts: [account],
  }));
  for (const group of groups) {
    entries.push({
      key: `group:${group.id}`,
      kind: "group",
      id: group.id,
      label: group.name,
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
        getSpaceType(space.spaceType).label,
        project.name,
      ].join(" ").toLocaleLowerCase();
      return !q || haystack.includes(q);
    })
    .sort((left, right) => activityTime(right) - activityTime(left) || left.name.localeCompare(right.name));
}

export function sortProjectGroups(groups) {
  return [...groups].sort((left, right) => (
    Number(left.id === null) - Number(right.id === null)
    || activityTime(right.items[0]) - activityTime(left.items[0])
  ));
}

export function resolveSpaceCreationTarget(accounts, groups, selectedKey) {
  const entry = directoryProjection(accounts, groups, []).find((candidate) => candidate.key === selectedKey);
  return {
    groupId: entry?.kind === "group" ? entry.id : null,
    seats: (entry?.accountIds ?? []).map((accountId) => ({ accountId, responseMode: "default" })),
  };
}
