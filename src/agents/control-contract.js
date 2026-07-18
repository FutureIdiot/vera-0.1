// Strict Vera Control Service inputs and safe response projections.

import { ApiError } from "../core/errors.js";
import { projectWorkspace, parseWorkspace } from "../spaces/workspace-control.js";
import { projectAgent } from "./agents.js";
import { projectAccount } from "./accounts.js";
import { normalizeRuntimeProfile } from "../store/migrations/federation-account.mjs";

export function invalid(message) {
  throw new ApiError("invalid_request", message);
}

export function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) invalid(`${field} is required`);
  return value.trim();
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${field} must be an object`);
  return value;
}

function strictKeys(value, allowed, field) {
  object(value, field);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid(`${field} contains unsupported fields`);
}

function runtimeSnapshot(runtime) {
  strictKeys(runtime, new Set(["hostId", "kind", "provider", "model", "revision", "runtimeCapabilities"]), "runtime");
  const capabilities = runtime.runtimeCapabilities === undefined
    ? null
    : object(runtime.runtimeCapabilities, "runtime.runtimeCapabilities");
  const safeCapabilities = capabilities === null ? null : {
    ...(Array.isArray(capabilities.tools) ? {
      tools: capabilities.tools.map((tool) => {
        const item = object(tool, "runtime.runtimeCapabilities.tools[]");
        return {
          name: requiredText(item.name, "runtime capability name"),
          ...(item.source === undefined ? {} : { source: requiredText(item.source, "runtime capability source") }),
          ...(item.scope === undefined ? {} : { scope: requiredText(item.scope, "runtime capability scope") }),
        };
      }),
    } : {}),
    ...(Array.isArray(capabilities.extensions) ? {
      extensions: capabilities.extensions.map((extension) => requiredText(extension, "runtime extension")),
    } : {}),
  };
  const snapshot = {
    hostId: requiredText(runtime.hostId, "runtime.hostId"),
    kind: requiredText(runtime.kind, "runtime.kind"),
    provider: requiredText(runtime.provider, "runtime.provider"),
    model: requiredText(runtime.model, "runtime.model"),
    revision: requiredText(runtime.revision, "runtime.revision"),
    runtimeCapabilities: safeCapabilities,
  };
  if (snapshot.model === "default") invalid("runtime.model must be the effective model");
  return snapshot;
}

export function validateLoginBody(body) {
  strictKeys(body, new Set(["accountId", "daemonBootId", "runtime", "workspace", "memoryProvider"]), "body");
  return {
    accountId: requiredText(body.accountId, "accountId"),
    daemonBootId: requiredText(body.daemonBootId, "daemonBootId"),
    runtime: runtimeSnapshot(object(body.runtime, "runtime")),
    workspace: parseWorkspace(body.workspace),
  };
}

export function validateEnrollBody(body) {
  strictKeys(body, new Set(["accountId", "agent", "runtimeProfile"]), "body");
  strictKeys(body.agent, new Set(["name"]), "agent");
  let runtimeProfile;
  try {
    runtimeProfile = normalizeRuntimeProfile(body.runtimeProfile);
  } catch (error) {
    invalid(error.message.replace(/^Phase 5\.5 federation Account migration blocked: /u, ""));
  }
  return {
    accountId: requiredText(body.accountId, "accountId"),
    name: requiredText(body.agent?.name, "agent.name"),
    runtimeProfile,
  };
}

export function validateRegisterBody(body) {
  strictKeys(body, new Set(["accountId", "daemonBootId", "runtimeRevision", "workspace"]), "body");
  return {
    accountId: requiredText(body.accountId, "accountId"),
    daemonBootId: requiredText(body.daemonBootId, "daemonBootId"),
    runtimeRevision: requiredText(body.runtimeRevision, "runtimeRevision"),
    workspace: parseWorkspace(body.workspace, { allowLastValidatedAt: false }),
  };
}

export function validateAuthorizeBody(body) {
  strictKeys(body, new Set(["accountId", "runId", "workspaceHostId", "runtimeRevision"]), "body");
  return {
    accountId: requiredText(body.accountId, "accountId"),
    runId: requiredText(body.runId, "runId"),
    workspaceHostId: requiredText(body.workspaceHostId, "workspaceHostId"),
    runtimeRevision: requiredText(body.runtimeRevision, "runtimeRevision"),
  };
}

export function validateRuntime(agent, runtime) {
  const profile = agent.runtimeProfile;
  if (!profile || profile.kind !== runtime.kind || profile.provider !== runtime.provider || profile.model !== runtime.model) {
    throw new ApiError("workspace_unavailable", "Agent runtime does not match its registered profile");
  }
}

function safeSeats(store, accountId) {
  const seats = [];
  for (const space of store.list("spaces")) {
    for (const seat of space.seats ?? []) {
      if (seat.accountId !== accountId) continue;
      seats.push({
        spaceId: space.id,
        accountId,
        responseMode: seat.responseMode ?? "default",
        ...(seat.respondTo ? { respondTo: structuredClone(seat.respondTo) } : {}),
        ...(seat.blockAccountIds ? { blockAccountIds: structuredClone(seat.blockAccountIds) } : {}),
      });
    }
  }
  return seats;
}

function safeProviderBindings(store, accountId, agentId) {
  function safeState(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (/(secret|token|password|credential|(^|_)key$|(^|_)path$)/iu.test(key)) continue;
      if (item && typeof item === "object" && !Array.isArray(item)) result[key] = safeState(item);
      else if (!Array.isArray(item)) result[key] = item;
    }
    return result;
  }
  return store.list("providerBindings")
    .filter((binding) => binding.accountId === accountId)
    .map(({ _seq, providerState, ...binding }) => ({
      ...binding,
      agentId,
      providerState: safeState(providerState),
    }));
}

export function accountResponse(store, account, agent, config, session = null) {
  return {
    agent: projectAgent(agent),
    account: projectAccount(account),
    accountSession: {
      id: session?.record?.id ?? session?.id ?? null,
      ...(session?.token ? { token: session.token } : {}),
      gatewayBootId: session?.record?.gatewayBootId ?? session?.gatewayBootId ?? config.gatewayBootId,
    },
    delegated: false,
    seats: safeSeats(store, account.id),
    providerBindings: safeProviderBindings(store, account.id, agent.id),
    workspace: projectWorkspace(account.workspace),
    heartbeatIntervalMs: config.agentDaemon.heartbeatIntervalMs,
  };
}
