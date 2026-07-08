// Space CRUD（api-contract.md 二、Space 形状）。

import { newSpaceId } from "../core/id.js";
import { ApiError } from "../core/errors.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

// seat 形（ground-truth.md 2.2 / 2.3）：{agentId, responseMode, respondTo?, blockAgentIds?}。
// 4.4 起 Seat 不再携带 accountId（账户归属改为登录级联邦或默认 owning account，
// 见 docs/ground-truth.md 2.2 修订 / api-contract Seat 段）。即使传入也丢弃。
// respondTo / blockAgentIds 缺省不强制写入（保持 seat 形干净），有值才写。
function normalizeSeat(seat) {
  const normalized = {
    agentId: seat.agentId,
    responseMode: seat.responseMode ?? "default",
  };
  if (seat.respondTo) normalized.respondTo = seat.respondTo;
  if (seat.blockAgentIds && seat.blockAgentIds.length > 0) normalized.blockAgentIds = seat.blockAgentIds;
  return normalized;
}

export function listSpaces(store) {
  return store.list("spaces").map(stripInternal);
}

export function createSpace(store, body) {
  if (!body?.name) {
    throw new ApiError("invalid_request", "name is required");
  }
  const space = {
    id: newSpaceId(),
    name: body.name,
    topic: body.topic ?? "",
    seats: (body.seats ?? []).map(normalizeSeat),
    createdAt: new Date().toISOString(),
  };
  return stripInternal(store.insert("spaces", space));
}

export function updateSpace(store, id, patch) {
  const space = store.find("spaces", id);
  if (!space) throw new ApiError("not_found", `space ${id} does not exist`);
  const next = {};
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.topic !== undefined) next.topic = patch.topic;
  if (patch.seats !== undefined) next.seats = patch.seats.map(normalizeSeat);
  return stripInternal(store.update("spaces", id, next));
}

// 内部用：拿 raw record（不剥离 _seq），供 domain 内部逻辑（如 messages.js
// 判断 seats）使用；HTTP 层一律用上面几个已剥离的版本。
export function getSpaceOrThrow(store, id) {
  const space = store.find("spaces", id);
  if (!space) throw new ApiError("not_found", `space ${id} does not exist`);
  return space;
}
