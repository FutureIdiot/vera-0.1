// Agent identity and portable runtime profile.

import { newAgentId } from "../core/id.js";
import { ApiError } from "../core/errors.js";
import { createAccount } from "./accounts.js";
import {
  deriveRuntimeRevision,
  normalizeRuntimeProfile,
} from "../store/migrations/federation-account.mjs";

function invalid(message) {
  return new ApiError("invalid_request", message);
}

function requireName(value) {
  if (typeof value !== "string" || !value.trim()) throw invalid("name is required");
  return value.trim();
}

export function projectAgent({
  _seq,
  runtimeBinding,
  ...agent
}) {
  // runtimeBinding contains the temporary local connection bridge. It is
  // persisted until daemon execution replaces it, but never enters public
  // Agent projections or portable runtimeProfile exports.
  return structuredClone(agent);
}

export function listAgents(store) {
  return store.list("agents").map(projectAgent);
}

// Transitional POST /api/agents bridge. Its request remains the existing
// kind/provider/model/connection shape until enroll replaces the route, while
// the persisted/public result is already the Phase 5.5 Agent shape.
export function createAgent(store, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("body must be an object");
  const allowed = new Set(["name", "kind", "provider", "model", "connection"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw invalid("Agent create body contains unsupported fields");
  let runtimeProfile;
  try {
    runtimeProfile = normalizeRuntimeProfile({
      schemaVersion: 1,
      kind: body.kind,
      provider: body.provider,
      model: body.model,
    });
  } catch (error) {
    throw invalid(error.message.replace(/^Phase 5\.5 federation Account migration blocked: /u, ""));
  }
  const connection = body.connection ?? {};
  if (!connection || typeof connection !== "object" || Array.isArray(connection)) throw invalid("connection must be an object");
  const runtimeBinding = { connection: structuredClone(connection) };
  const now = new Date().toISOString();
  const agent = store.insert("agents", {
    id: newAgentId(),
    name: requireName(body.name),
    runtimeProfile,
    runtimeBinding,
    runtimeRevision: deriveRuntimeRevision(runtimeProfile, runtimeBinding),
    createdAt: now,
    updatedAt: now,
  });
  const account = createAccount(store, agent.id, body);
  return { agent: projectAgent(agent), account };
}

export function updateAgent(store, id, patch) {
  const agent = store.find("agents", id);
  if (!agent) throw new ApiError("not_found", `agent ${id} does not exist`);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw invalid("patch must be an object");
  const keys = Object.keys(patch);
  if (keys.some((key) => key !== "name")) throw invalid("Agent PATCH only accepts name");
  if (!keys.includes("name")) throw invalid("name is required");
  return projectAgent(store.update("agents", id, {
    name: requireName(patch.name),
    updatedAt: new Date().toISOString(),
  }));
}

export function deleteAgent(store, id) {
  const agent = store.find("agents", id);
  if (!agent) throw new ApiError("not_found", `agent ${id} does not exist`);
  const hasHistory = store.list("messages").some((message) => message.executingAgentId === id);
  if (hasHistory) throw new ApiError("conflict", `agent ${id} has message history and cannot be deleted`);
  const ownerAccount = store.list("accounts").find((account) => account.ownerAgentId === id);
  if (ownerAccount) throw new ApiError("conflict", `agent ${id} still owns account ${ownerAccount.id}`);
  const agentSessionIds = new Set(
    store.list("agentSessions").filter((session) => session.agentId === id).map((session) => session.id),
  );
  for (const binding of [...store.list("providerBindings")]) {
    if (agentSessionIds.has(binding.agentSessionId)) store.remove("providerBindings", binding.id);
  }
  for (const history of [...store.list("apiHistories")]) {
    if (agentSessionIds.has(history.agentSessionId)) store.remove("apiHistories", history.id);
  }
  for (const session of [...store.list("agentSessions")]) {
    if (session.agentId === id) store.remove("agentSessions", session.id);
  }
  store.remove("agents", id);
}
