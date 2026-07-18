// Account identity domain. Runtime/provider data belongs to the owner Agent;
// Account remains the stable Space/Workspace identity boundary.

import { newAccountId } from "../core/id.js";
import { ApiError } from "../core/errors.js";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { projectWorkspace } from "../spaces/workspace-control.js";

function invalid(message) {
  return new ApiError("invalid_request", message);
}

function requireName(value, field = "name") {
  if (typeof value !== "string" || !value.trim()) throw invalid(`${field} is required`);
  return value.trim();
}

function strictNameBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("body must be an object");
  if (Object.keys(body).some((key) => key !== "name")) throw invalid("Account create body only accepts name");
  return requireName(body.name);
}

function issueAccessKey() {
  const accessKey = `vak_${randomBytes(32).toString("base64url")}`;
  const salt = randomBytes(16);
  const cost = 16384;
  const blockSize = 8;
  const parallelization = 1;
  const keyLength = 32;
  const digest = scryptSync(accessKey, salt, keyLength, {
    N: cost,
    r: blockSize,
    p: parallelization,
  });
  return {
    accessKey,
    accessKeyHash: {
      algorithm: "scrypt",
      salt: salt.toString("base64url"),
      digest: digest.toString("base64url"),
      cost,
      blockSize,
      parallelization,
      keyLength,
    },
  };
}

export function projectAccount({
  _seq,
  accessKeyHash,
  loginAudits,
  ...account
}) {
  // Credential material and bounded login history are reserved for their
  // dedicated slices and must never enter a normal Account response.
  const projected = structuredClone(account);
  projected.workspace = projectWorkspace(projected.workspace);
  return projected;
}

export function verifyAccountAccessKey(account, accessKey) {
  if (!account || account.accessKeyState !== "active" ||
      !account.accessKeyHash || typeof accessKey !== "string" || !accessKey) return false;
  const material = account.accessKeyHash;
  if (material.algorithm !== "scrypt" || typeof material.salt !== "string" ||
      typeof material.digest !== "string") return false;
  try {
    const expected = Buffer.from(material.digest, "base64url");
    const actual = scryptSync(accessKey, Buffer.from(material.salt, "base64url"), material.keyLength, {
      N: material.cost,
      r: material.blockSize,
      p: material.parallelization,
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function accountDisplayName(agent, body = {}) {
  return typeof body.name === "string" && body.name.trim()
    ? body.name.trim()
    : `${agent.name} account`;
}

export function listAccounts(store, { agentId, ownerAgentId, activeAgentId } = {}) {
  const ownerFilter = ownerAgentId ?? agentId;
  return store.list("accounts")
    .filter((account) => ownerFilter ? account.ownerAgentId === ownerFilter : true)
    .filter((account) => activeAgentId ? account.activeAgentId === activeAgentId : true)
    .map(projectAccount);
}

export function getOwningAccount(store, agentId) {
  const matches = store.list("accounts").filter((account) => account.ownerAgentId === agentId);
  if (matches.length > 1) throw new ApiError("conflict", `agent ${agentId} owns multiple Accounts`);
  return matches[0] ? projectAccount(matches[0]) : null;
}

export function getAccountOrThrow(store, id) {
  const account = store.find("accounts", id);
  if (!account) throw new ApiError("not_found", `account ${id} does not exist`);
  return projectAccount(account);
}

export function createUnownedAccount(store, body) {
  const name = strictNameBody(body);
  const { accessKey, accessKeyHash } = issueAccessKey();
  const now = new Date().toISOString();
  const account = store.insert("accounts", {
    id: newAccountId(),
    name,
    ownerAgentId: null,
    presence: "offline",
    lastSeenAt: null,
    activeAgentId: null,
    runtimeCapabilities: null,
    accessKeyState: "active",
    accessKeyVersion: 1,
    accessKeyHash,
    workspace: null,
    createdAt: now,
    updatedAt: now,
  });
  return { account: projectAccount(account), accessKey };
}

export function rotateAccountAccessKey(store, id) {
  const account = store.find("accounts", id);
  if (!account) throw new ApiError("not_found", `account ${id} does not exist`);
  const { accessKey, accessKeyHash } = issueAccessKey();
  const updated = store.update("accounts", id, {
    accessKeyState: "active",
    accessKeyVersion: (Number.isInteger(account.accessKeyVersion) ? account.accessKeyVersion : 0) + 1,
    accessKeyHash,
    updatedAt: new Date().toISOString(),
  });
  return { account: projectAccount(updated), accessKey };
}

export function revokeAccountAccessKey(store, id) {
  const account = store.find("accounts", id);
  if (!account) throw new ApiError("not_found", `account ${id} does not exist`);
  const updated = store.update("accounts", id, {
    accessKeyState: "revoked",
    accessKeyVersion: (Number.isInteger(account.accessKeyVersion) ? account.accessKeyVersion : 0) + 1,
    accessKeyHash: null,
    updatedAt: new Date().toISOString(),
  });
  return projectAccount(updated);
}

// Transitional bridge used by POST /api/agents until enroll owns creation.
// It is intentionally strict 1:1 and cannot add a second Account.
export function createAccount(store, agentId, body = {}) {
  const agent = store.find("agents", agentId);
  if (!agent) throw new ApiError("not_found", `agent ${agentId} does not exist`);
  if (store.list("accounts").some((account) => account.ownerAgentId === agentId)) {
    throw new ApiError("conflict", `agent ${agentId} already owns an Account`);
  }
  const now = new Date().toISOString();
  const account = store.insert("accounts", {
    id: newAccountId(),
    name: accountDisplayName(agent, body),
    ownerAgentId: agentId,
    presence: "offline",
    lastSeenAt: null,
    activeAgentId: null,
    runtimeCapabilities: null,
    accessKeyState: "revoked",
    accessKeyVersion: 0,
    workspace: null,
    createdAt: now,
    updatedAt: now,
  });
  return projectAccount(account);
}

export function updateAccount(store, id, patch) {
  const account = store.find("accounts", id);
  if (!account) throw new ApiError("not_found", `account ${id} does not exist`);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw invalid("patch must be an object");
  const keys = Object.keys(patch);
  if (keys.some((key) => key !== "name")) throw invalid("Account PATCH only accepts name");
  if (!keys.includes("name")) throw invalid("name is required");
  const updated = store.update("accounts", id, {
    name: requireName(patch.name),
    updatedAt: new Date().toISOString(),
  });
  return projectAccount(updated);
}

export function deleteAccount(store, id) {
  const account = store.find("accounts", id);
  if (!account) throw new ApiError("not_found", `account ${id} does not exist`);
  if (account.ownerAgentId && store.find("agents", account.ownerAgentId)) {
    throw new ApiError("conflict", `account ${id} is still owned by agent ${account.ownerAgentId}`);
  }
  for (const binding of [...store.list("providerBindings")]) {
    if (binding.accountId === id) store.remove("providerBindings", binding.id);
  }
  store.remove("accounts", id);
}
