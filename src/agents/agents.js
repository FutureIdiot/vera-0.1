// Agent 注册 CRUD（api-contract.md 二、Agent 形状）。
// Agent 只保留身份；连接类字段落到 Account。

import { newAgentId } from "../core/id.js";
import { ApiError } from "../core/errors.js";
import { createAccount } from "./accounts.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

export function listAgents(store) {
  return store.list("agents").map(stripInternal);
}

export function createAgent(store, body) {
  if (!body?.name) {
    throw new ApiError("invalid_request", "name is required");
  }
  const now = new Date().toISOString();
  const agent = {
    id: newAgentId(),
    name: body.name,
    createdAt: now,
    updatedAt: now,
  };
  const storedAgent = stripInternal(store.insert("agents", agent));
  const account = createAccount(store, storedAgent.id, body);
  return { agent: storedAgent, account };
}

export function updateAgent(store, id, patch) {
  const agent = store.find("agents", id);
  if (!agent) throw new ApiError("not_found", `agent ${id} does not exist`);
  const next = {};
  if (patch.name !== undefined) next.name = patch.name;
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
  for (const account of store.list("accounts").filter((item) => item.owningAgentId === id)) {
    store.clearSessionStatesForAccount(account.id);
    store.remove("accounts", account.id);
  }
  store.remove("agents", id);
}
