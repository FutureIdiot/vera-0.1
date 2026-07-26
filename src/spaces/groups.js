// Group CRUD。Group 是群目录与成员集合的唯一事实来源。

import { newGroupId } from "../core/id.js";
import { ApiError } from "../core/errors.js";
import { ensureActiveSpaceSession, ensureAgentSession } from "./context-sessions.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

function assertExactObject(value, allowed, { required = [], name = "body", allowEmpty = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("invalid_request", `${name} must be an object`);
  }
  const keys = Object.keys(value);
  if (
    (!allowEmpty && keys.length === 0)
    || keys.some((key) => !allowed.includes(key))
    || required.some((key) => !keys.includes(key))
  ) {
    throw new ApiError("invalid_request", `${name} fields are invalid`);
  }
}

function normalizeName(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("invalid_request", "name must be a non-empty string");
  }
  return value.trim();
}

function normalizeTopic(value) {
  if (typeof value !== "string") throw new ApiError("invalid_request", "topic must be a string");
  return value.trim();
}

function normalizeAccountIds(store, value) {
  if (!Array.isArray(value)) throw new ApiError("invalid_request", "accountIds must be an array");
  const accountIds = [...new Set(value)];
  if (accountIds.length < 2 || accountIds.length !== value.length) {
    throw new ApiError("invalid_request", "accountIds must contain at least two unique Accounts");
  }
  const known = new Set(store.list("accounts").map((account) => account.id));
  if (accountIds.some((accountId) => typeof accountId !== "string" || !known.has(accountId))) {
    throw new ApiError("invalid_request", "accountIds contains an unknown Account");
  }
  return accountIds;
}

function cleanSeat(seat, memberIds) {
  const respondTo = (seat.respondTo ?? []).filter((id) => id === "user" || memberIds.has(id));
  const blockAccountIds = (seat.blockAccountIds ?? []).filter((id) => memberIds.has(id) && id !== seat.accountId);
  return {
    accountId: seat.accountId,
    responseMode: seat.responseMode ?? "default",
    ...(respondTo.length ? { respondTo } : {}),
    ...(blockAccountIds.length ? { blockAccountIds } : {}),
  };
}

function syncGroupSpaces(store, groupId, accountIds, updatedAt) {
  const memberIds = new Set(accountIds);
  const spaces = [];
  for (const space of store.list("spaces").filter((candidate) => candidate.groupId === groupId)) {
    const existing = new Map(space.seats.map((seat) => [seat.accountId, seat]));
    const seats = accountIds.map((accountId) => cleanSeat(
      existing.get(accountId) ?? { accountId, responseMode: "default" },
      memberIds,
    ));
    const updated = store.update("spaces", space.id, { seats, updatedAt });
    const spaceSession = ensureActiveSpaceSession(store, space.id);
    for (const seat of seats) {
      const account = store.find("accounts", seat.accountId);
      if (account?.ownerAgentId) {
        ensureAgentSession(store, {
          spaceSessionId: spaceSession.id,
          accountId: account.id,
          agentId: account.ownerAgentId,
        });
      }
    }
    spaces.push(stripInternal(updated));
  }
  return spaces;
}

export function listGroups(store) {
  return store.list("groups")
    .map(stripInternal)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function getGroupOrThrow(store, id) {
  const group = store.find("groups", id);
  if (!group) throw new ApiError("not_found", `group ${id} does not exist`);
  return stripInternal(group);
}

export function createGroup(store, body) {
  assertExactObject(body, ["name", "topic", "accountIds"], { required: ["name", "accountIds"] });
  const now = new Date().toISOString();
  return stripInternal(store.insert("groups", {
    id: newGroupId(),
    name: normalizeName(body.name),
    topic: normalizeTopic(body.topic ?? ""),
    accountIds: normalizeAccountIds(store, body.accountIds),
    createdAt: now,
    updatedAt: now,
  }));
}

export function updateGroup(store, id, patch) {
  const group = store.find("groups", id);
  if (!group) throw new ApiError("not_found", `group ${id} does not exist`);
  assertExactObject(patch, ["name", "topic", "accountIds"], { name: "patch", allowEmpty: false });
  const next = {};
  if (patch.name !== undefined) next.name = normalizeName(patch.name);
  if (patch.topic !== undefined) next.topic = normalizeTopic(patch.topic);
  if (patch.accountIds !== undefined) next.accountIds = normalizeAccountIds(store, patch.accountIds);
  const membershipChanged = next.accountIds
    && (
      next.accountIds.length !== group.accountIds.length
      || next.accountIds.some((accountId) => !group.accountIds.includes(accountId))
    );
  if (membershipChanged) {
    const spaceIds = new Set(
      store.list("spaces").filter((space) => space.groupId === id).map((space) => space.id),
    );
    const activeRun = store.list("runs").find(
      (run) => spaceIds.has(run.spaceId) && ["pending", "running"].includes(run.status),
    );
    const activeCompaction = store.list("contextCompactionJobs").find(
      (job) => spaceIds.has(job.spaceId) && ["queued", "running"].includes(job.status),
    );
    if (activeRun || activeCompaction) {
      throw new ApiError("conflict", `group ${id} has active Space work`);
    }
  }
  const updatedAt = new Date().toISOString();
  next.updatedAt = updatedAt;
  const updated = store.update("groups", id, next);
  const spaces = next.accountIds ? syncGroupSpaces(store, id, next.accountIds, updatedAt) : [];
  return { group: stripInternal(updated), spaces };
}

export function deleteGroup(store, id) {
  if (!store.find("groups", id)) throw new ApiError("not_found", `group ${id} does not exist`);
  const referencing = store.list("spaces").find((space) => space.groupId === id);
  if (referencing) {
    throw new ApiError("conflict", `group ${id} is referenced by space ${referencing.id}`);
  }
  store.remove("groups", id);
}
