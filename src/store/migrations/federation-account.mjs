// Phase 5.5 one-time identity migration.
//
// The migration is deliberately split into a pure planning pass and a commit
// pass. Planning clones every affected collection and validates the complete
// Account/Agent graph before the live store is touched. Ambiguous legacy data
// therefore fails without partially rewriting one collection while leaving
// another on the old identity model.

import { createHash } from "node:crypto";

export const FEDERATION_ACCOUNT_MIGRATION_VERSION = 1;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function fail(message) {
  throw new Error(`Phase 5.5 federation Account migration blocked: ${message}`);
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`);
  return value.trim();
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
  return structuredClone(value);
}

export function normalizeRuntimeProfile(input, field = "runtimeProfile") {
  const profile = requireObject(input, field);
  const keys = Object.keys(profile).sort();
  const expected = ["kind", "model", "provider", "schemaVersion"];
  if (!same(keys, expected)) fail(`${field} must contain only schemaVersion/kind/provider/model`);
  if (profile.schemaVersion !== 1) fail(`${field}.schemaVersion must be 1`);
  return {
    schemaVersion: 1,
    kind: requireText(profile.kind, `${field}.kind`),
    provider: requireText(profile.provider, `${field}.provider`),
    model: requireText(profile.model, `${field}.model`),
  };
}

export function deriveRuntimeRevision(runtimeProfile, runtimeBinding = { connection: {} }) {
  const profile = normalizeRuntimeProfile(runtimeProfile);
  const binding = requireObject(runtimeBinding, "runtimeBinding");
  const digest = createHash("sha256")
    .update(JSON.stringify(stable({ profile, binding })))
    .digest("hex");
  return `sha256:${digest}`;
}

function ownerIdForAccount(account) {
  const hasOwner = hasOwn(account, "ownerAgentId");
  const hasOwning = hasOwn(account, "owningAgentId");
  if (hasOwner && hasOwning && account.ownerAgentId !== account.owningAgentId) {
    fail(`Account ${account.id} has conflicting ownerAgentId and owningAgentId`);
  }
  return hasOwner ? account.ownerAgentId : account.owningAgentId;
}

function runtimeForAgent(agent, account) {
  const hasLegacyRuntime = ["kind", "provider", "model", "connection"].some((key) => hasOwn(account, key));
  if (account.ownerAgentId == null && hasLegacyRuntime) {
    fail(`unbound Account ${account.id} still carries legacy runtime fields`);
  }

  const legacyProfile = hasLegacyRuntime ? normalizeRuntimeProfile({
    schemaVersion: 1,
    kind: account.kind,
    provider: account.provider,
    model: account.model,
  }, `Account ${account.id} legacy runtime`) : null;
  const existingProfile = agent.runtimeProfile
    ? normalizeRuntimeProfile(agent.runtimeProfile, `Agent ${agent.id}.runtimeProfile`)
    : null;
  if (legacyProfile && existingProfile && !same(legacyProfile, existingProfile)) {
    fail(`Agent ${agent.id} runtimeProfile conflicts with Account ${account.id} runtime fields`);
  }
  const runtimeProfile = existingProfile ?? legacyProfile;
  if (!runtimeProfile) fail(`Agent ${agent.id} has no portable runtime profile`);

  const legacyBinding = hasOwn(account, "connection")
    ? { connection: requireObject(account.connection ?? {}, `Account ${account.id}.connection`) }
    : null;
  const existingBinding = agent.runtimeBinding
    ? requireObject(agent.runtimeBinding, `Agent ${agent.id}.runtimeBinding`)
    : null;
  if (legacyBinding && existingBinding && !same(legacyBinding, existingBinding)) {
    fail(`Agent ${agent.id} runtimeBinding conflicts with Account ${account.id} connection`);
  }
  const runtimeBinding = existingBinding ?? legacyBinding ?? { connection: {} };
  return {
    runtimeProfile,
    runtimeBinding,
    runtimeRevision: deriveRuntimeRevision(runtimeProfile, runtimeBinding),
  };
}

function mapIdentityId(value, { agentToAccount, accountIds }, field, { allowUser = false } = {}) {
  if (allowUser && value === "user") return value;
  if (accountIds.has(value)) return value;
  const accountId = agentToAccount.get(value);
  if (!accountId) fail(`${field} references unknown Agent/Account ${value}`);
  return accountId;
}

function mapIdentityList(values, context, field, options) {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) fail(`${field} must be an array`);
  return [...new Set(values.map((value) => mapIdentityId(value, context, field, options)))];
}

function buildPlan(data) {
  const working = {
    agents: structuredClone(data.agents ?? []),
    accounts: structuredClone(data.accounts ?? []),
    spaces: structuredClone(data.spaces ?? []),
    agentSessions: structuredClone(data.agentSessions ?? []),
    runs: structuredClone(data.runs ?? []),
    messages: structuredClone(data.messages ?? []),
    providerBindings: structuredClone(data.providerBindings ?? []),
  };
  const agentsById = new Map();
  for (const agent of working.agents) {
    requireText(agent?.id, "Agent.id");
    if (agentsById.has(agent.id)) fail(`duplicate Agent id ${agent.id}`);
    agentsById.set(agent.id, agent);
  }

  const accountsById = new Map();
  const accountByAgent = new Map();
  for (const account of working.accounts) {
    requireText(account?.id, "Account.id");
    if (accountsById.has(account.id)) fail(`duplicate Account id ${account.id}`);
    const ownerAgentId = ownerIdForAccount(account);
    if (ownerAgentId != null) {
      requireText(ownerAgentId, `Account ${account.id}.ownerAgentId`);
      if (!agentsById.has(ownerAgentId)) fail(`Account ${account.id} references missing owner Agent ${ownerAgentId}`);
      if (accountByAgent.has(ownerAgentId)) {
        fail(`Agent ${ownerAgentId} owns multiple Accounts (${accountByAgent.get(ownerAgentId).id}, ${account.id})`);
      }
      accountByAgent.set(ownerAgentId, account);
    }
    account.ownerAgentId = ownerAgentId ?? null;
    accountsById.set(account.id, account);
  }
  for (const agent of working.agents) {
    if (!accountByAgent.has(agent.id)) fail(`Agent ${agent.id} does not own exactly one Account`);
  }

  for (const agent of working.agents) {
    Object.assign(agent, runtimeForAgent(agent, accountByAgent.get(agent.id)));
    const allowed = new Set([
      "id", "name", "runtimeProfile", "runtimeBinding", "runtimeRevision", "createdAt", "updatedAt", "_seq",
    ]);
    for (const key of Object.keys(agent)) {
      if (!allowed.has(key)) delete agent[key];
    }
  }

  for (const account of working.accounts) {
    const clean = {
      id: account.id,
      name: account.name,
      ownerAgentId: account.ownerAgentId,
      presence: "offline",
      lastSeenAt: account.lastSeenAt ?? null,
      activeAgentId: null,
      runtimeCapabilities: null,
      accessKeyState: "revoked",
      accessKeyVersion: 0,
      workspace: account.workspace ?? null,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      ...(hasOwn(account, "_seq") ? { _seq: account._seq } : {}),
    };
    Object.keys(account).forEach((key) => delete account[key]);
    Object.assign(account, clean);
  }

  const agentToAccount = new Map([...accountByAgent].map(([agentId, account]) => [agentId, account.id]));
  const identityContext = { agentToAccount, accountIds: new Set(accountsById.keys()) };
  for (const space of working.spaces) {
    if (!Array.isArray(space.seats)) fail(`Space ${space.id} seats must be an array`);
    const seen = new Set();
    space.seats = space.seats.map((seat, index) => {
      const field = `Space ${space.id} seat ${index}`;
      const fromAgent = seat.agentId == null ? null : agentToAccount.get(seat.agentId);
      if (seat.agentId != null && !fromAgent) fail(`${field} references unknown Agent ${seat.agentId}`);
      if (seat.accountId != null && !accountsById.has(seat.accountId)) fail(`${field} references unknown Account ${seat.accountId}`);
      if (fromAgent && seat.accountId != null && fromAgent !== seat.accountId) fail(`${field} has conflicting agentId/accountId`);
      const accountId = seat.accountId ?? fromAgent;
      if (!accountId) fail(`${field} has no Account`);
      if (seen.has(accountId)) fail(`Space ${space.id} has duplicate seat for Account ${accountId}`);
      seen.add(accountId);
      const next = { accountId, responseMode: seat.responseMode ?? "default" };
      const respondTo = mapIdentityList(seat.respondTo, identityContext, `${field}.respondTo`, { allowUser: true });
      const blocks = mapIdentityList(
        seat.blockAccountIds ?? seat.blockAgentIds,
        identityContext,
        `${field}.blockAccountIds`,
      );
      if (respondTo?.length) next.respondTo = respondTo;
      if (blocks?.length) next.blockAccountIds = blocks;
      return next;
    });
    const notifications = space.notifications ?? { mode: "accountMessages", includeActivityErrors: true };
    space.notifications = {
      mode: notifications.mode === "agentMessages" ? "accountMessages" : notifications.mode,
      includeActivityErrors: notifications.includeActivityErrors !== false,
    };
  }

  const sessionById = new Map();
  const sessionKeys = new Set();
  for (const session of working.agentSessions) {
    const accountId = agentToAccount.get(session.agentId);
    if (!accountId) fail(`AgentSession ${session.id} references Agent without an owner Account`);
    if (session.accountId != null && session.accountId !== accountId) {
      fail(`AgentSession ${session.id} accountId does not match its Agent owner Account`);
    }
    session.accountId = accountId;
    const key = `${session.spaceSessionId}:${accountId}:${session.agentId}`;
    if (sessionKeys.has(key)) fail(`duplicate AgentSession identity ${key}`);
    sessionKeys.add(key);
    sessionById.set(session.id, session);
  }
  for (const binding of working.providerBindings) {
    const session = sessionById.get(binding.agentSessionId);
    if (session && binding.accountId != null && binding.accountId !== session.accountId) {
      fail(`ProviderBinding ${binding.id} accountId does not match AgentSession ${session.id}`);
    }
  }

  const runtimeByAgent = new Map(working.agents.map((agent) => [agent.id, agent]));
  for (const run of working.runs) {
    const agent = runtimeByAgent.get(run.agentId);
    if (!agent) fail(`Run ${run.id} references unknown Agent ${run.agentId}`);
    const accountId = agentToAccount.get(run.agentId);
    if (run.accountId != null && run.accountId !== accountId) fail(`Run ${run.id} accountId does not match Agent owner Account`);
    run.accountId = accountId;
    run.runtimeRevision = agent.runtimeRevision;
    run.effectiveModel = typeof run.effectiveModel === "string" && run.effectiveModel.trim()
      ? run.effectiveModel.trim()
      : agent.runtimeProfile.model;
    run.delegated = false;
  }

  for (const message of working.messages) {
    if (message.author?.type === "agent") {
      const agent = runtimeByAgent.get(message.author.agentId);
      if (!agent) fail(`Message ${message.id} references unknown Agent ${message.author.agentId}`);
      const account = accountByAgent.get(agent.id);
      message.author = { type: "account", accountId: account.id };
      message.accountNameSnapshot ??= account.name;
      message.executingAgentId ??= agent.id;
      message.effectiveModel ??= agent.runtimeProfile.model;
      message.delegated = false;
    } else if (message.author?.type === "account") {
      const account = accountsById.get(message.author.accountId);
      if (!account) fail(`Message ${message.id} references unknown Account ${message.author.accountId}`);
      const agent = account.ownerAgentId ? runtimeByAgent.get(account.ownerAgentId) : null;
      message.accountNameSnapshot ??= account.name;
      message.executingAgentId ??= agent?.id ?? null;
      message.effectiveModel ??= agent?.runtimeProfile.model ?? null;
      message.delegated = false;
    }
    if (message.target?.type === "direct" && Array.isArray(message.target.agentIds)) {
      message.target = {
        ...message.target,
        accountIds: mapIdentityList(message.target.agentIds, identityContext, `Message ${message.id}.target.agentIds`),
      };
      delete message.target.agentIds;
    }
  }

  return working;
}

export function needsFederationAccountMigration({ data }) {
  return (data.federationAccountMigrationVersion ?? 0) < FEDERATION_ACCOUNT_MIGRATION_VERSION;
}

export function preflightFederationAccountMigration({ data }) {
  if (!needsFederationAccountMigration({ data })) return null;
  return buildPlan(data);
}

export async function migrateFederationAccounts({ data, markDirty, flush, plan = null }) {
  if (!needsFederationAccountMigration({ data })) return false;
  const next = plan ?? buildPlan(data);
  const changed = [];
  for (const key of ["agents", "accounts", "spaces", "agentSessions", "runs", "messages", "providerBindings"]) {
    if (!same(data[key] ?? [], next[key])) changed.push(key);
    data[key] = next[key];
  }
  data.federationAccountMigrationVersion = FEDERATION_ACCOUNT_MIGRATION_VERSION;
  markDirty([...changed, "meta"]);
  await flush();
  return true;
}
