// Space CRUD（api-contract.md 二、Space 形状）。

import { newSpaceId } from "../core/id.js";
import { ApiError } from "../core/errors.js";
import { ensureActiveSpaceSession, ensureAgentSession } from "./context-sessions.js";
import { DEFAULT_SPACE_TYPE, SPACE_TYPE_IDS, isSpaceType } from "./space-types.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

// Seat 固定Space中的Account身份；实际执行Agent由Account Session决定。
const RESPONSE_MODES = ["default", "silent", "focused"];

function assertExactObject(value, allowed, { required = [], name = "body", allowEmpty = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("invalid_request", `${name} must be an object`);
  }
  const keys = Object.keys(value);
  if (
    (!allowEmpty && keys.length === 0) ||
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    throw new ApiError("invalid_request", `${name} fields are invalid`);
  }
}

function normalizeSeats(store, seats) {
  if (!Array.isArray(seats)) throw new ApiError("invalid_request", "seats must be an array");
  if (seats.length === 0) throw new ApiError("invalid_request", "seats must contain at least one Account");
  const knownAccountIds = new Set(store.list("accounts").map((account) => account.id));
  const seen = new Set();
  return seats.map((seat) => {
    if (!seat || typeof seat !== "object" || !knownAccountIds.has(seat.accountId)) {
      throw new ApiError("invalid_request", `seat accountId ${seat?.accountId ?? "is required"} is not a known Account`);
    }
    assertExactObject(
      seat,
      ["accountId", "responseMode", "respondTo", "blockAccountIds"],
      { required: ["accountId"], name: "seat" },
    );
    if (seen.has(seat.accountId)) throw new ApiError("invalid_request", `duplicate seat for ${seat.accountId}`);
    seen.add(seat.accountId);
    if (seat.responseMode !== undefined && !RESPONSE_MODES.includes(seat.responseMode)) {
      throw new ApiError("invalid_request", `invalid responseMode for ${seat.accountId}`);
    }
    for (const field of ["respondTo", "blockAccountIds"]) {
      if (seat[field] !== undefined && !Array.isArray(seat[field])) {
        throw new ApiError("invalid_request", `${field} must be an array`);
      }
    }
    const respondTo = seat.respondTo ?? [];
    if (respondTo.some((id) => id !== "user" && !knownAccountIds.has(id))) {
      throw new ApiError("invalid_request", `respondTo contains an unknown Account`);
    }
    const blockAccountIds = seat.blockAccountIds ?? [];
    if (blockAccountIds.some((id) => !knownAccountIds.has(id) || id === seat.accountId)) {
      throw new ApiError("invalid_request", `blockAccountIds contains an invalid Account`);
    }
    const normalized = {
      accountId: seat.accountId,
      responseMode: seat.responseMode ?? "default",
    };
    if (respondTo.length > 0) normalized.respondTo = [...new Set(respondTo)];
    if (blockAccountIds.length > 0) normalized.blockAccountIds = [...new Set(blockAccountIds)];
    return normalized;
  });
}

// notifications 默认（api-contract.md Space 形状 [P4.6]）。
const DEFAULT_NOTIFICATIONS = { mode: "accountMessages", includeActivityErrors: true };
const NOTIFICATION_MODES = ["all", "accountMessages", "off"];

function normalizeNotifications(notifications) {
  if (notifications === undefined) return { ...DEFAULT_NOTIFICATIONS };
  if (!notifications || typeof notifications !== "object" || !NOTIFICATION_MODES.includes(notifications.mode)) {
    throw new ApiError("invalid_request", "notifications.mode must be all, accountMessages, or off");
  }
  assertExactObject(
    notifications,
    ["mode", "includeActivityErrors"],
    { required: ["mode"], name: "notifications" },
  );
  if (notifications.includeActivityErrors !== undefined && typeof notifications.includeActivityErrors !== "boolean") {
    throw new ApiError("invalid_request", "notifications.includeActivityErrors must be boolean");
  }
  return {
    mode: notifications.mode,
    includeActivityErrors: notifications.includeActivityErrors !== false,
  };
}

function normalizePinned(value) {
  if (typeof value !== "boolean") throw new ApiError("invalid_request", "pinned must be a boolean");
  return value;
}

function normalizeSpaceType(value) {
  if (!isSpaceType(value)) {
    throw new ApiError("invalid_request", `spaceType must be one of: ${SPACE_TYPE_IDS.join(", ")}`);
  }
  return value;
}

function normalizeProjectId(store, value) {
  if (value === null) return null;
  if (typeof value !== "string" || !store.find("projects", value)) {
    throw new ApiError("invalid_request", `projectId ${value ?? "must be null or a Project id"} is not a known Project`);
  }
  return value;
}

function seatAccountIds(seats) {
  return seats.map((seat) => seat.accountId).sort();
}

function assertSpaceMembership(store, groupId, seats) {
  if (groupId === null) {
    if (seats.length !== 1) {
      throw new ApiError("invalid_request", "a Direct Space must contain exactly one Account seat");
    }
    return;
  }
  if (typeof groupId !== "string") {
    throw new ApiError("invalid_request", "groupId must be null or a Group id");
  }
  const group = store.find("groups", groupId);
  if (!group) throw new ApiError("invalid_request", `groupId ${groupId} is not a known Group`);
  const actual = seatAccountIds(seats);
  const expected = [...group.accountIds].sort();
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new ApiError("invalid_request", "Space seats must match Group accountIds");
  }
}

// 旧 Space 记录可能缺这些字段，读取时补默认；持久形状另由 store 启动迁移补齐。
function normalizeSpace(space) {
  const normalized = stripInternal(space);
  delete normalized.topic;
  normalized.notifications = normalizeNotifications(space.notifications);
  normalized.archivedAt = space.archivedAt ?? null;
  normalized.pinned = space.pinned ?? false;
  normalized.spaceType = space.spaceType ?? DEFAULT_SPACE_TYPE.id;
  normalized.projectId = space.projectId ?? null;
  normalized.groupId = space.groupId ?? null;
  normalized.updatedAt = space.updatedAt ?? space.createdAt ?? null;
  return normalized;
}

export function listSpaces(store, { archived } = {}) {
  let spaces = store.list("spaces");
  if (archived === true) {
    spaces = spaces.filter((s) => s.archivedAt != null);
  } else if (archived === "all") {
    // 全部，不过滤
  } else {
    // 默认只列活跃（archivedAt == null）
    spaces = spaces.filter((s) => !s.archivedAt);
  }
  return spaces.map(normalizeSpace);
}

export function createSpace(store, body) {
  assertExactObject(
    body,
    ["name", "seats", "groupId", "notifications", "pinned", "spaceType", "projectId"],
    { required: ["name", "seats"] },
  );
  if (typeof body?.name !== "string" || !body.name.trim()) {
    throw new ApiError("invalid_request", "name is required");
  }
  const seats = normalizeSeats(store, body.seats);
  const groupId = body.groupId ?? null;
  assertSpaceMembership(store, groupId, seats);
  const timestamp = new Date().toISOString();
  const space = {
    id: newSpaceId(),
    name: body.name.trim(),
    seats,
    groupId,
    notifications: normalizeNotifications(body.notifications),
    pinned: normalizePinned(body.pinned ?? false),
    spaceType: normalizeSpaceType(body.spaceType ?? DEFAULT_SPACE_TYPE.id),
    projectId: normalizeProjectId(store, body.projectId ?? null),
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const stored = store.insert("spaces", space);
  const spaceSession = ensureActiveSpaceSession(store, stored.id);
  for (const seat of stored.seats) {
    const account = store.find("accounts", seat.accountId);
    if (account?.ownerAgentId) ensureAgentSession(store, {
      spaceSessionId: spaceSession.id, accountId: account.id, agentId: account.ownerAgentId,
    });
  }
  return normalizeSpace(store.find("spaces", stored.id));
}

export function updateSpace(store, id, patch) {
  const space = store.find("spaces", id);
  if (!space) throw new ApiError("not_found", `space ${id} does not exist`);
  assertExactObject(
    patch,
    ["name", "seats", "notifications", "pinned", "projectId"],
    { name: "patch", allowEmpty: false },
  );
  const next = {};
  if (patch.name !== undefined) {
    if (typeof patch.name !== "string" || !patch.name.trim()) throw new ApiError("invalid_request", "name must not be empty");
    next.name = patch.name.trim();
  }
  if (patch.seats !== undefined) {
    next.seats = normalizeSeats(store, patch.seats);
    assertSpaceMembership(store, space.groupId ?? null, next.seats);
  }
  if (patch.notifications !== undefined) next.notifications = normalizeNotifications(patch.notifications);
  if (patch.pinned !== undefined) next.pinned = normalizePinned(patch.pinned);
  if (patch.projectId !== undefined) next.projectId = normalizeProjectId(store, patch.projectId);
  next.updatedAt = new Date().toISOString();
  const updated = store.update("spaces", id, next);
  if (next.seats) {
    const spaceSession = ensureActiveSpaceSession(store, id);
    for (const seat of next.seats) {
      const account = store.find("accounts", seat.accountId);
      if (account?.ownerAgentId) ensureAgentSession(store, {
        spaceSessionId: spaceSession.id, accountId: account.id, agentId: account.ownerAgentId,
      });
    }
  }
  return normalizeSpace(updated);
}

export function archiveSpace(store, id) {
  const space = store.find("spaces", id);
  if (!space) throw new ApiError("not_found", `space ${id} does not exist`);
  if (space.archivedAt) return normalizeSpace(space);
  // 有未结束 Run 时拒绝（api-contract.md 263）
  const runningRuns = store.list("runs").filter((r) =>
    r.spaceId === id && ["pending", "running"].includes(r.status));
  if (runningRuns.length > 0) {
    throw new ApiError("conflict", `space ${id} has ${runningRuns.length} running run(s), cancel or wait before archiving`);
  }
  const activeCompactions = store.list("contextCompactionJobs").filter((job) =>
    job.spaceId === id && ["queued", "running"].includes(job.status));
  if (activeCompactions.length > 0) {
    throw new ApiError("conflict", `space ${id} has an active context compaction`);
  }
  const timestamp = new Date().toISOString();
  const updated = store.update("spaces", id, { archivedAt: timestamp, updatedAt: timestamp });
  return normalizeSpace(updated);
}

export function restoreSpace(store, id) {
  const space = store.find("spaces", id);
  if (!space) throw new ApiError("not_found", `space ${id} does not exist`);
  if (!space.archivedAt) return normalizeSpace(space);
  const updated = store.update("spaces", id, {
    archivedAt: null,
    updatedAt: new Date().toISOString(),
  });
  return normalizeSpace(updated);
}

export function touchSpaceUpdatedAt(store, id, updatedAt = new Date().toISOString()) {
  const space = store.find("spaces", id);
  if (!space) throw new ApiError("not_found", `space ${id} does not exist`);
  return normalizeSpace(store.update("spaces", id, { updatedAt }));
}

export function isArchived(store, id) {
  const space = store.find("spaces", id);
  if (!space) throw new ApiError("not_found", `space ${id} does not exist`);
  return space.archivedAt != null;
}

// 内部用：拿 raw record（不剥离 _seq），供 domain 内部逻辑（如 messages.js
// 判断 seats）使用；HTTP 层一律用上面几个已剥离的版本。
export function getSpaceOrThrow(store, id) {
  const space = store.find("spaces", id);
  if (!space) throw new ApiError("not_found", `space ${id} does not exist`);
  return space;
}
