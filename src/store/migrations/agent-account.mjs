// 分文件内部的 v0 → v1 数据形状迁移：agent 连接字段拆到 account + session-states
// 键重映射（Phase 4.1）+ seat.accountId 剥离（Phase 4.4 反迁移）。
//
// 历史叠层：
//   - 4.1：旧 agent 记录内嵌 {kind, provider, connection, model}，没 account
//     概念。本迁移把连接字段从 agent 剥到自动派生的 owning account，session-
//     states 键从 (agentId:spaceId) 重映射到 (accountId:spaceId)，并 backfill
//     seat.accountId（4.4 又撤掉这条 backfill）。
//   - 4.4：Seat 去 accountId（账户归属改登录级联邦或默认 owning account，
//     见 ground-truth 2.2 修订）。本迁移同步剥掉 4.1 backfill 到 seats 上的
//     accountId 字段一次性清理；session-states 键不动。
//
// 三件事共享 `accountIdForAgent` 的派生映射（4.1 派生 owning account id +
// 4.1 重映射 session-states 键都要用同一映射），所以放在一个函数里不分拆。

import { copyFile } from "node:fs/promises";

function hasLegacyAgentConnection(agent) {
  return ["kind", "provider", "connection", "model"].some((key) => Object.prototype.hasOwnProperty.call(agent, key));
}

function stripAgentConnection(agent) {
  const { kind, provider, connection, model, ...identity } = agent;
  return identity;
}

function deriveOwningAccountId(agentId) {
  const suffix = String(agentId || "").startsWith("agt_") ? String(agentId).slice(4) : String(agentId || "unknown");
  return `acc_${suffix.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

// 判定是否需要跑：任一 agent 有遗留连接字段、或任一 agent 没派生 owning
// account、或任一 seat 残留 accountId、或任一 session-states 键以 agt_ 起头。
// 检测早返以避免每次启动都落盘。
export function needsMigration({ data }) {
  // Phase 5.5 renamed the ownership field and moved runtime data back to the
  // Agent. A crash may flush those collection files before the new migration
  // version reaches meta.json. In that replay window this legacy detector must
  // stand down, otherwise it would mistake every migrated Agent for an orphan
  // and derive duplicate Accounts.
  const hasFederationShape = data.accounts.some((account) =>
    Object.prototype.hasOwnProperty.call(account, "ownerAgentId")) ||
    data.agents.some((agent) => Object.prototype.hasOwnProperty.call(agent, "runtimeProfile"));
  if (hasFederationShape || (data.federationAccountMigrationVersion ?? 0) >= 1) return false;
  const needsAgentStrip = data.agents.some(hasLegacyAgentConnection);
  const owningAccountByAgent = new Map(data.accounts.map((account) => [account.owningAgentId, account]));
  const agentsNeedingAccount = data.agents.filter((agent) => !owningAccountByAgent.has(agent.id));
  const seatsNeedAccountIdStripped = data.spaces.some((space) =>
    (space.seats ?? []).some((seat) => Object.prototype.hasOwnProperty.call(seat, "accountId")),
  );
  const sessionKeysNeedRemap = Object.keys(data.sessionStates).some((key) => {
    const [first] = key.split(":");
    return first?.startsWith("agt_");
  });
  return needsAgentStrip || agentsNeedingAccount.length > 0 || seatsNeedAccountIdStripped || sessionKeysNeedRemap;
}

// 备份现有分文件为 .legacy（回滚锚点，迁移幂等，崩溃回灌重启会重跑）。
// `fileFor(key)` 返回该集合对应的磁盘路径。
export async function backupSplitFilesAsLegacy({ fileFor, keys }) {
  for (const key of keys) {
    const path = fileFor(key);
    try {
      await copyFile(path, `${path}.legacy`);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
  }
}

// 执行迁移。副作用直接改 data；调用方负责 flush 后续 store 加载完成。
// `flush` 是 store 那侧的 flush 函数。
// `markDirty(keys[])` 记脏触发落盘。
export async function migrateAgentAccountsAndSeats({ data, flush, markDirty }) {
  const accountIdByAgent = new Map();
  for (const account of data.accounts) {
    if (!accountIdByAgent.has(account.owningAgentId)) accountIdByAgent.set(account.owningAgentId, account.id);
  }

  const usedAccountIds = new Set(data.accounts.map((account) => account.id));
  function accountIdForAgent(agentId) {
    if (accountIdByAgent.has(agentId)) return accountIdByAgent.get(agentId);
    let id = deriveOwningAccountId(agentId);
    let n = 2;
    while (usedAccountIds.has(id)) {
      id = `${deriveOwningAccountId(agentId)}_${n}`;
      n += 1;
    }
    usedAccountIds.add(id);
    accountIdByAgent.set(agentId, id);
    return id;
  }

  // 4.1: 为每个没有 owning account 的 agent 派生一条
  const now = new Date().toISOString();
  for (const agent of data.agents) {
    if (accountIdByAgent.has(agent.id)) continue;
    data.accounts.push({
      id: accountIdForAgent(agent.id),
      owningAgentId: agent.id,
      name: `${agent.name ?? agent.id}${agent.provider ? ` ${agent.provider}` : ""} account`,
      kind: agent.kind ?? null,
      provider: agent.provider ?? null,
      connection: agent.connection ?? {},
      model: agent.model ?? "",
      createdAt: agent.createdAt ?? now,
      updatedAt: agent.updatedAt ?? agent.createdAt ?? now,
    });
  }

  // 4.1: agent 收口——剥掉连接字段
  data.agents = data.agents.map(stripAgentConnection);

  // 4.4 反迁移：剥掉 seats 上的 accountId 字段（4.1 backfill 的旧值一次性清理）。
  // accountId === undefined 在 JSON 序列化时会被丢掉，seats 里不再有该字段。
  // session-states 键不动——仍按 (accountId, spaceId)，accountId 默认来自
  // deriveOwningAccountId(seat.agentId)。
  data.spaces = data.spaces.map((space) => ({
    ...space,
    seats: (space.seats ?? []).map(({ accountId, ...seatRest }) => ({
      ...seatRest,
      accountId: undefined,
    })),
  }));

  // 4.1: session-states 键从 (agentId:spaceId) 重映射到 (accountId:spaceId)
  const remappedSessionStates = {};
  for (const [key, value] of Object.entries(data.sessionStates)) {
    const [first, ...rest] = key.split(":");
    const spaceId = rest.join(":");
    if (first?.startsWith("agt_") && spaceId) {
      remappedSessionStates[`${accountIdForAgent(first)}:${spaceId}`] = value;
    } else {
      remappedSessionStates[key] = value;
    }
  }
  data.sessionStates = remappedSessionStates;

  markDirty(["agents", "accounts", "spaces", "sessionStates"]);
  await flush();
}
