// Daemon-local persistent credentials. This module owns only the
// `agentCredentials` namespace in ~/.vera/secrets.json. AccountSession Tokens
// are deliberately absent from the schema and remain process-memory only.

import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ApiError } from "../core/errors.js";

const AGENT_TOKEN = /^vat_[A-Za-z0-9_-]{43}$/u;
const ACCOUNT_KEY = /^vak_[A-Za-z0-9_-]{43}$/u;

function unavailable() {
  return new ApiError("internal", "daemon credential store is unavailable");
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validateNamespace(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const result = {};
  for (const [agentId, raw] of Object.entries(value)) {
    if (!text(agentId) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw unavailable();
    if (Object.keys(raw).some((key) => !new Set(["agentToken", "accountKeys"]).has(key))) throw unavailable();
    if (typeof raw.agentToken !== "string" || !AGENT_TOKEN.test(raw.agentToken)) throw unavailable();
    if (!raw.accountKeys || typeof raw.accountKeys !== "object" || Array.isArray(raw.accountKeys)) throw unavailable();
    const accountKeys = {};
    for (const [accountId, accountKey] of Object.entries(raw.accountKeys)) {
      if (!text(accountId) || typeof accountKey !== "string" || !ACCOUNT_KEY.test(accountKey)) throw unavailable();
      accountKeys[accountId] = accountKey;
    }
    result[agentId] = { agentToken: raw.agentToken, accountKeys };
  }
  return result;
}

async function readDocument(secretsPath) {
  let info;
  try {
    info = await lstat(secretsPath);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw unavailable();
  }
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600) throw unavailable();
  try {
    const parsed = JSON.parse(await readFile(secretsPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unavailable();
    validateNamespace(parsed.agentCredentials);
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
}

async function writeDocument(secretsPath, document) {
  const parent = dirname(secretsPath);
  const temporaryPath = `${secretsPath}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, secretsPath);
    await chmod(secretsPath, 0o600);
  } catch {
    try { await unlink(temporaryPath); } catch {}
    throw unavailable();
  }
}

export function createDaemonCredentialStore({ secretsPath } = {}) {
  if (!text(secretsPath)) throw new Error("createDaemonCredentialStore requires secretsPath");
  let mutationTail = Promise.resolve();

  function serialized(task) {
    const next = mutationTail.catch(() => {}).then(task);
    mutationTail = next;
    return next;
  }

  return {
    async load({ agentId, accountId }) {
      const safeAgentId = text(agentId);
      const safeAccountId = text(accountId);
      if (!safeAgentId || !safeAccountId) throw unavailable();
      const document = await readDocument(secretsPath);
      const namespace = validateNamespace(document.agentCredentials);
      const credentials = namespace[safeAgentId];
      if (!credentials) return null;
      return {
        agentToken: credentials.agentToken,
        accountKey: credentials.accountKeys[safeAccountId] ?? null,
      };
    },

    async save({ agentId, accountId, agentToken, accountKey = null }) {
      const safeAgentId = text(agentId);
      const safeAccountId = text(accountId);
      if (!safeAgentId || !safeAccountId || typeof agentToken !== "string" || !AGENT_TOKEN.test(agentToken) ||
          (accountKey !== null && (typeof accountKey !== "string" || !ACCOUNT_KEY.test(accountKey)))) {
        throw unavailable();
      }
      return serialized(async () => {
        const document = await readDocument(secretsPath);
        const namespace = validateNamespace(document.agentCredentials);
        const current = namespace[safeAgentId] ?? { agentToken, accountKeys: {} };
        const accountKeys = { ...current.accountKeys };
        if (accountKey === null) delete accountKeys[safeAccountId];
        else accountKeys[safeAccountId] = accountKey;
        const next = {
          ...document,
          agentCredentials: {
            ...namespace,
            [safeAgentId]: { agentToken, accountKeys },
          },
        };
        await writeDocument(secretsPath, next);
        return { saved: true, accountKeyStored: accountKey !== null };
      });
    },
  };
}
