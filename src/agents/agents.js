// Agent 注册 CRUD（api-contract.md 二、Agent 形状）。

import { newAgentId } from "../core/id.js";
import { ApiError } from "../core/errors.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

export function listAgents(store) {
  return store.list("agents").map(stripInternal);
}

export function createAgent(store, body) {
  if (!body?.name || !body?.kind) {
    throw new ApiError("invalid_request", "name and kind are required");
  }
  const now = new Date().toISOString();
  const agent = {
    id: newAgentId(),
    name: body.name,
    kind: body.kind,
    provider: body.provider ?? null,
    connection: body.connection ?? {},
    model: body.model ?? null,
    createdAt: now,
    updatedAt: now,
  };
  return stripInternal(store.insert("agents", agent));
}

export function updateAgent(store, id, patch) {
  const agent = store.find("agents", id);
  if (!agent) throw new ApiError("not_found", `agent ${id} does not exist`);
  const next = {};
  for (const key of ["name", "kind", "provider", "connection", "model"]) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  next.updatedAt = new Date().toISOString();
  return stripInternal(store.update("agents", id, next));
}

// DELETE 对有历史消息的 agent 返回 409（api-contract.md Agent 表格）。
export function deleteAgent(store, id) {
  const agent = store.find("agents", id);
  if (!agent) throw new ApiError("not_found", `agent ${id} does not exist`);
  const hasHistory = store
    .list("messages")
    .some((message) => message.author?.type === "agent" && message.author.agentId === id);
  if (hasHistory) {
    throw new ApiError("conflict", `agent ${id} has message history and cannot be deleted`);
  }
  store.remove("agents", id);
}
