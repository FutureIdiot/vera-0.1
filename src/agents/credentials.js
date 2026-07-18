// Process-facing credential helpers. The gateway token file stores only
// irreversible fingerprints; plaintext exists only in the enroll response.

import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { ApiError } from "../core/errors.js";

function tokenStoreError() {
  return new ApiError("internal", "agent token store is unavailable");
}

function digestToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function agentTokenFingerprint(token) {
  return `sha256:${digestToken(token)}`;
}

function equalSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerToken(headers, name = "authorization") {
  const raw = headers?.[name.toLowerCase()] ?? headers?.[name] ?? "";
  const match = /^Bearer\s+([^\s]+)$/u.exec(String(raw));
  return match?.[1] ?? null;
}

export function headerValue(headers, name) {
  return headers?.[name.toLowerCase()] ?? headers?.[name] ?? null;
}

export function createAgentCredentialStore({ tokensPath }) {
  if (!tokensPath) throw new Error("createAgentCredentialStore requires tokensPath");

  async function readTokens() {
    let raw;
    try {
      raw = await readFile(tokensPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw tokenStoreError();
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
      for (const [id, fingerprint] of Object.entries(parsed)) {
        if (typeof id !== "string" || !id || typeof fingerprint !== "string" ||
            !/^sha256:[0-9a-f]{64}$/u.test(fingerprint)) throw new Error("shape");
      }
      return parsed;
    } catch {
      throw tokenStoreError();
    }
  }

  async function writeTokens(tokens) {
    try {
      await mkdir(dirname(tokensPath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${tokensPath}.tmp-${randomBytes(8).toString("hex")}`;
      await writeFile(temporaryPath, `${JSON.stringify(tokens, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, tokensPath);
      await chmod(tokensPath, 0o600);
    } catch {
      throw tokenStoreError();
    }
  }

  return {
    async issue(agentId) {
      const tokens = await readTokens();
      const token = `vat_${randomBytes(32).toString("base64url")}`;
      const fingerprint = agentTokenFingerprint(token);
      tokens[agentId] = fingerprint;
      await writeTokens(tokens);
      return { token, fingerprint };
    },

    async revoke(agentId) {
      const tokens = await readTokens();
      if (!(agentId in tokens)) return;
      delete tokens[agentId];
      await writeTokens(tokens);
    },

    async verify(token) {
      const tokens = await readTokens();
      const fingerprint = agentTokenFingerprint(token);
      for (const [agentId, expected] of Object.entries(tokens)) {
        if (equalSecret(fingerprint, expected)) {
          return { agentId, fingerprint };
        }
      }
      return null;
    },
  };
}
