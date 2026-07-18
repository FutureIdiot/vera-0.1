// Idempotent Account Workspace binding normalization.
//
// This runs independently from the one-time Account identity migration because
// already-migrated stores may have acquired Workspace bindings afterwards. The
// complete plan is built before callers mutate live store data, so duplicate
// physical bindings fail without a partial rewrite.

import { isAbsolute, resolve } from "node:path";

function fail(message) {
  throw new Error(`Phase 5.5 Workspace migration blocked: ${message}`);
}

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`);
  return value.trim();
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function planWorkspaceBindings(accounts = []) {
  const next = structuredClone(accounts);
  const bindings = new Map();

  for (const account of next) {
    const accountId = text(account?.id, "Account.id");
    if (account.workspace == null) continue;
    if (!account.workspace || typeof account.workspace !== "object" || Array.isArray(account.workspace)) {
      fail(`Account ${accountId}.workspace must be an object or null`);
    }

    const hostId = text(account.workspace.hostId, `Account ${accountId}.workspace.hostId`);
    const rawPath = text(account.workspace.path, `Account ${accountId}.workspace.path`);
    if (!isAbsolute(rawPath)) fail(`Account ${accountId}.workspace.path must be absolute`);
    const path = resolve(rawPath);
    const key = JSON.stringify([hostId, path]);
    const existingAccountId = bindings.get(key);
    if (existingAccountId && existingAccountId !== accountId) {
      fail(`Accounts ${existingAccountId} and ${accountId} bind the same host/path`);
    }
    bindings.set(key, accountId);
    account.workspace = {
      ...account.workspace,
      accountId,
      hostId,
      path,
    };
  }

  return { accounts: next, changed: !same(accounts, next) };
}
