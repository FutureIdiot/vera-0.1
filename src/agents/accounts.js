// Account CRUD（api-contract.md 二、Account 形状）。
// Account 是供应商连接 + 项目/会话上下文；Agent 只保留身份。
// F1 补 presence/lastSeenAt/runtimeCapabilities/authorizedAgentIds 字段形状
// （值在联邦 Phase 5.5 前为 offline/null/[owningAgentId]，但字段必须在）。

import { newAccountId } from "../core/id.js";
import { ApiError } from "../core/errors.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

// 旧 Account 记录可能缺联邦字段（F1 前创建的），读取时补默认。
// 不做一次性 store 迁移——updateAccount 会自然把字段写进去，新创建的都有。
function normalizeAccount(account) {
  const normalized = stripInternal(account);
  normalized.presence = account.presence ?? "offline";
  normalized.lastSeenAt = account.lastSeenAt ?? null;
  normalized.runtimeCapabilities = account.runtimeCapabilities ?? null;
  normalized.authorizedAgentIds = account.authorizedAgentIds ?? [account.owningAgentId];
  return normalized;
}

export function accountDisplayName(agent, body = {}) {
  if (body.name) return body.name;
  const provider = body.provider ? ` ${body.provider}` : "";
  return `${agent.name}${provider} account`;
}

export function listAccounts(store, { agentId } = {}) {
  const accounts = store.list("accounts");
  const filtered = agentId ? accounts.filter((account) => account.owningAgentId === agentId) : accounts;
  return filtered.map(normalizeAccount);
}

export function getOwningAccount(store, agentId) {
  const account = store.list("accounts").find((account) => account.owningAgentId === agentId) ?? null;
  return account ? normalizeAccount(account) : null;
}

export function getAccountOrThrow(store, id) {
  const account = store.find("accounts", id);
  if (!account) throw new ApiError("not_found", `account ${id} does not exist`);
  return normalizeAccount(account);
}

export function createAccount(store, agentId, body = {}) {
  const agent = store.find("agents", agentId);
  if (!agent) throw new ApiError("not_found", `agent ${agentId} does not exist`);

  const now = new Date().toISOString();
  const account = {
    id: newAccountId(),
    owningAgentId: agentId,
    name: accountDisplayName(agent, body),
    kind: body.kind ?? null,
    provider: body.provider ?? null,
    connection: body.connection ?? {},
    model: body.model ?? "",
    presence: "offline",
    lastSeenAt: null,
    runtimeCapabilities: null,
    authorizedAgentIds: [agentId],
    createdAt: now,
    updatedAt: now,
  };
  return stripInternal(store.insert("accounts", account));
}

export function updateAccount(store, id, patch) {
  const account = getAccountOrThrow(store, id);
  const next = {};
  for (const key of ["name", "kind", "provider", "connection", "model"]) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  next.updatedAt = new Date().toISOString();
  const updated = store.update("accounts", account.id, next);
  return normalizeAccount(updated);
}

export function deleteAccount(store, id) {
  const account = getAccountOrThrow(store, id);
  const ownerExists = Boolean(store.find("agents", account.owningAgentId));
  const ownerAccounts = store.list("accounts").filter((item) => item.owningAgentId === account.owningAgentId);
  if (ownerExists && ownerAccounts.length === 1) {
    throw new ApiError("conflict", `account ${id} is the only account for agent ${account.owningAgentId}`);
  }
  for (const binding of [...store.list("providerBindings")]) {
    if (binding.accountId === id) store.remove("providerBindings", binding.id);
  }
  store.remove("accounts", id);
}
