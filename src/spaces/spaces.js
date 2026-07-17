// Space CRUD（api-contract.md 二、Space 形状）。

import { newSpaceId } from "../core/id.js";
import { ApiError } from "../core/errors.js";
import { ensureActiveSpaceSession, ensureAgentSession } from "./context-sessions.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

// Seat 固定Space中的Account身份；实际执行Agent由Account Session决定。
const RESPONSE_MODES = ["default", "silent", "focused"];

function normalizeSeats(store, seats) {
  if (!Array.isArray(seats)) throw new ApiError("invalid_request", "seats must be an array");
  if (seats.length === 0) throw new ApiError("invalid_request", "seats must contain at least one Account");
  const knownAccountIds = new Set(store.list("accounts").map((account) => account.id));
  const seen = new Set();
  return seats.map((seat) => {
    if (!seat || typeof seat !== "object" || !knownAccountIds.has(seat.accountId)) {
      throw new ApiError("invalid_request", `seat accountId ${seat?.accountId ?? "is required"} is not a known Account`);
    }
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
  if (notifications.includeActivityErrors !== undefined && typeof notifications.includeActivityErrors !== "boolean") {
    throw new ApiError("invalid_request", "notifications.includeActivityErrors must be boolean");
  }
  return {
    mode: notifications.mode,
    includeActivityErrors: notifications.includeActivityErrors !== false,
  };
}

// 旧 Space 记录可能缺 notifications / archivedAt（F1 前创建的），读取时补默认。
// 不做一次性 store 迁移——updateSpace 会自然把字段写进去，新创建的都有。
function normalizeSpace(space) {
  const normalized = stripInternal(space);
  normalized.notifications = normalizeNotifications(space.notifications);
  normalized.archivedAt = space.archivedAt ?? null;
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
  if (typeof body?.name !== "string" || !body.name.trim()) {
    throw new ApiError("invalid_request", "name is required");
  }
  if (body.topic !== undefined && typeof body.topic !== "string") {
    throw new ApiError("invalid_request", "topic must be a string");
  }
  const space = {
    id: newSpaceId(),
    name: body.name.trim(),
    topic: body.topic ?? "",
    seats: normalizeSeats(store, body.seats),
    notifications: normalizeNotifications(body.notifications),
    archivedAt: null,
    createdAt: new Date().toISOString(),
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
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new ApiError("invalid_request", "patch must be an object");
  }
  const next = {};
  if (patch.name !== undefined) {
    if (typeof patch.name !== "string" || !patch.name.trim()) throw new ApiError("invalid_request", "name must not be empty");
    next.name = patch.name.trim();
  }
  if (patch.topic !== undefined) {
    if (typeof patch.topic !== "string") throw new ApiError("invalid_request", "topic must be a string");
    next.topic = patch.topic;
  }
  if (patch.seats !== undefined) next.seats = normalizeSeats(store, patch.seats);
  if (patch.notifications !== undefined) next.notifications = normalizeNotifications(patch.notifications);
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
  if (space.archivedAt) return normalizeSpace(space); // 幂等
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
  const updated = store.update("spaces", id, { archivedAt: new Date().toISOString() });
  return normalizeSpace(updated);
}

export function restoreSpace(store, id) {
  const space = store.find("spaces", id);
  if (!space) throw new ApiError("not_found", `space ${id} does not exist`);
  if (!space.archivedAt) return normalizeSpace(space); // 幂等
  const updated = store.update("spaces", id, { archivedAt: null });
  return normalizeSpace(updated);
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
