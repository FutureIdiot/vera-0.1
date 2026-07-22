// Account chat-model selection. Agent runtime owns the available model set;
// Account stores only one CAS-guarded choice from its owner Agent's last safe
// runtime snapshot.

import { ApiError } from "../core/errors.js";
import { rotateContextGeneration } from "../spaces/context-state.js";
import { projectAccount } from "./accounts.js";

const ACTIVE_RUN_STATUSES = new Set(["pending", "running"]);
const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);

function normalizedModels(value) {
  if (!Array.isArray(value)) return [];
  const models = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) return [];
    const model = item.trim();
    if (model === "default" || seen.has(model)) return [];
    seen.add(model);
    models.push(model);
  }
  return models;
}

export function listAgentModels(agent) {
  const snapshotModels = normalizedModels(
    agent?.runtimeBinding?.runtimeSnapshot?.runtimeCapabilities?.models,
  );
  if (snapshotModels.length) return snapshotModels;
  const fallback = typeof agent?.runtimeProfile?.model === "string"
    ? agent.runtimeProfile.model.trim()
    : "";
  return fallback && fallback !== "default" ? [fallback] : [];
}

export function accountModelOptions(store, account) {
  const owner = account?.ownerAgentId ? store.find("agents", account.ownerAgentId) : null;
  return owner ? listAgentModels(owner) : [];
}

function validateBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("invalid_request", "body must be an object");
  }
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("model") || !keys.includes("ifVersion")) {
    throw new ApiError("invalid_request", "model update body must be exactly { model, ifVersion }");
  }
  if (typeof body.model !== "string" || !body.model || body.model !== body.model.trim()) {
    throw new ApiError("invalid_request", "model must be a non-empty trimmed string");
  }
  if (!Number.isInteger(body.ifVersion) || body.ifVersion < 0) {
    throw new ApiError("invalid_request", "ifVersion must be a non-negative integer");
  }
  return { model: body.model, ifVersion: body.ifVersion };
}

function versionConflict(account) {
  throw new ApiError("conflict", "Account model version does not match", {
    reason: "version_mismatch",
    current: {
      model: account.model ?? null,
      modelVersion: account.modelVersion ?? 0,
    },
  });
}

function assertIdle(store, accountId) {
  if (store.list("runs").some((run) =>
    run.accountId === accountId && ACTIVE_RUN_STATUSES.has(run.status))) {
    throw new ApiError("account_busy", "Account has pending or running work");
  }
  if (store.list("contextCompactionJobs").some((job) =>
    ACTIVE_JOB_STATUSES.has(job.status) && (job.targets ?? []).some((target) =>
      target.accountId === accountId && ACTIVE_JOB_STATUSES.has(target.status)))) {
    throw new ApiError("account_busy", "Account has an active context compaction");
  }
}

export function updateAccountModel(store, accountId, body, { hub = null, now = () => new Date().toISOString() } = {}) {
  const input = validateBody(body);
  const account = store.find("accounts", accountId);
  if (!account) throw new ApiError("not_found", `account ${accountId} does not exist`);
  const currentVersion = Number.isInteger(account.modelVersion) ? account.modelVersion : 0;

  // Completed retries and exact no-ops do not rotate context or publish a
  // duplicate event.
  if (account.model === input.model &&
      (currentVersion === input.ifVersion || currentVersion === input.ifVersion + 1)) {
    return projectAccount(account);
  }
  if (currentVersion !== input.ifVersion) versionConflict(account);

  const owner = account.ownerAgentId ? store.find("agents", account.ownerAgentId) : null;
  const models = owner ? listAgentModels(owner) : [];
  if (!owner || !models.includes(input.model)) {
    throw new ApiError("model_unavailable", "Model is not available from the Account owner Agent", {
      modelOptions: models,
    });
  }
  assertIdle(store, account.id);

  const timestamp = typeof now === "function" ? now() : now;
  const sessions = store.list("agentSessions").filter((session) =>
    session.accountId === account.id && session.status === "active");
  for (const session of sessions) {
    rotateContextGeneration(store, {
      agentSessionId: session.id,
      fromGeneration: session.generation,
      createApiHistory: owner.runtimeProfile?.kind === "api",
      recentTurns: [],
    }, { now: timestamp });
  }

  const updated = store.update("accounts", account.id, {
    model: input.model,
    modelVersion: currentVersion + 1,
    updatedAt: timestamp,
  });
  const projected = projectAccount(updated);
  hub?.publish("account.upserted", { account: projected });
  return projected;
}
