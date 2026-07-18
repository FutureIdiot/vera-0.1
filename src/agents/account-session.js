// Account Session Tokens are opaque, gateway-process-only credentials.

import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "../core/errors.js";
import { newAccountSessionId } from "../core/id.js";

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function reauthenticate() {
  throw new ApiError("account_reauthentication_required", "Account Session requires reauthentication");
}

export function createAccountSessionService({ gatewayBootId = null } = {}) {
  const bootId = gatewayBootId || `gwboot_${randomBytes(24).toString("base64url")}`;
  const sessions = new Map();
  const accountToToken = new Map();
  const agentToToken = new Map();

  function revokeTokenHash(tokenHash) {
    const record = sessions.get(tokenHash);
    if (!record) return false;
    sessions.delete(tokenHash);
    if (accountToToken.get(record.accountId) === tokenHash) accountToToken.delete(record.accountId);
    if (agentToToken.get(record.agentId) === tokenHash) agentToToken.delete(record.agentId);
    return true;
  }

  function revokeAccount(accountId) {
    const tokenHash = accountToToken.get(accountId);
    return tokenHash ? revokeTokenHash(tokenHash) : false;
  }

  function getAccountSession(accountId) {
    const tokenHash = accountToToken.get(accountId);
    return tokenHash ? sessions.get(tokenHash) ?? null : null;
  }

  function getAgentSession(agentId) {
    const tokenHash = agentToToken.get(agentId);
    return tokenHash ? sessions.get(tokenHash) ?? null : null;
  }

  function issue({ agentId, accountId, agentTokenFingerprint, accessKeyVersion, daemonBootId, runtimeHostId, runtimeRevision }) {
    revokeAccount(accountId);
    const oldAgent = getAgentSession(agentId);
    if (oldAgent) revokeTokenHash(oldAgent.tokenHash);
    const token = `vas_${randomBytes(32).toString("base64url")}`;
    const tokenHash = hashToken(token);
    const record = {
      id: newAccountSessionId(),
      tokenHash,
      agentId,
      accountId,
      agentTokenFingerprint,
      accessKeyVersion,
      daemonBootId,
      gatewayBootId: bootId,
      runtimeHostId,
      runtimeRevision,
      createdAt: new Date().toISOString(),
    };
    sessions.set(tokenHash, record);
    accountToToken.set(accountId, tokenHash);
    agentToToken.set(agentId, tokenHash);
    return { token, record };
  }

  function authenticate({ token, agentId, accountId, agentTokenFingerprint, accessKeyVersion, daemonBootId }) {
    if (typeof token !== "string" || !token) reauthenticate();
    const record = sessions.get(hashToken(token));
    if (!record || record.agentId !== agentId || record.accountId !== accountId ||
        record.agentTokenFingerprint !== agentTokenFingerprint ||
        record.accessKeyVersion !== accessKeyVersion ||
        (daemonBootId !== undefined && record.daemonBootId !== daemonBootId) || record.gatewayBootId !== bootId) {
      reauthenticate();
    }
    return record;
  }

  function updateRuntime(record, { runtimeHostId, runtimeRevision }) {
    record.runtimeHostId = runtimeHostId;
    record.runtimeRevision = runtimeRevision;
    return record;
  }

  function revokeForKeyVersion(accountId, accessKeyVersion) {
    const record = getAccountSession(accountId);
    if (record && record.accessKeyVersion !== accessKeyVersion) revokeTokenHash(record.tokenHash);
  }

  return {
    bootId,
    issue,
    authenticate,
    updateRuntime,
    getAccountSession,
    getAgentSession,
    revokeAccount,
    revokeForKeyVersion,
    invalidateAccountSessions: revokeAccount,
  };
}
