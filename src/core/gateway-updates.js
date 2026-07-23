import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { ApiError } from "./errors.js";

const ACTIVE_STATES = new Set(["checking", "queued", "updating"]);
const STATES = new Set([
  "idle",
  "checking",
  "up_to_date",
  "available",
  "queued",
  "updating",
  "succeeded",
  "failed",
  "rolled_back",
]);
const COMMIT = /^[0-9a-f]{40}$/u;
const REQUEST_ID = /^upd_[0-9a-f]{32}$/u;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const MAX_JSON_BYTES = 64 * 1024;

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function nullableIso(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 40 || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function safeVersion(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 80 && !/[\r\n]/u.test(value)
    ? value
    : null;
}

function safeRelease(value) {
  if (!value || value.schemaVersion !== 1 || typeof value !== "object" || Array.isArray(value)) return null;
  const commit = COMMIT.test(value.commit) ? value.commit : null;
  const version = safeVersion(value.version);
  const deployedAt = nullableIso(value.deployedAt);
  if (!commit && !version && !deployedAt) return null;
  return { commit, version, deployedAt };
}

function safeError(value) {
  if (value === null || value === undefined) return null;
  if (!exactKeys(value, ["code", "message"])) return null;
  if (!SAFE_CODE.test(value.code)) return null;
  if (typeof value.message !== "string" || value.message.length === 0 || value.message.length > 160 || /[\r\n]/u.test(value.message)) return null;
  return { code: value.code, message: value.message };
}

function safeTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !COMMIT.test(value.commit)) return null;
  return { commit: value.commit, version: safeVersion(value.version) };
}

function safeStatus(value) {
  if (!value || value.schemaVersion !== 1 || !STATES.has(value.state)) return null;
  const requestId = value.requestId === null || value.requestId === undefined
    ? null
    : REQUEST_ID.test(value.requestId) ? value.requestId : null;
  if (value.requestId && !requestId) return null;
  const error = safeError(value.error);
  if (value.error && !error) return null;
  return {
    state: value.state,
    requestId,
    target: safeTarget(value.target),
    checkedAt: nullableIso(value.checkedAt),
    startedAt: nullableIso(value.startedAt),
    finishedAt: nullableIso(value.finishedAt),
    error,
  };
}

function safeRequest(value) {
  if (!value || value.schemaVersion !== 1 || !REQUEST_ID.test(value.requestId)) return null;
  if (value.action === "check") {
    if (!exactKeys(value, ["action", "requestId", "requestedAt", "schemaVersion"])) return null;
    return nullableIso(value.requestedAt) ? value : null;
  }
  if (value.action === "apply") {
    if (!exactKeys(value, ["action", "checkedRequestId", "requestId", "requestedAt", "schemaVersion", "targetCommit"])) return null;
    return COMMIT.test(value.targetCommit) && REQUEST_ID.test(value.checkedRequestId) && nullableIso(value.requestedAt)
      ? value
      : null;
  }
  return null;
}

async function readOptionalJson(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error("unsafe update control file");
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

function unavailable() {
  return new ApiError("update_unavailable", "Gateway update control is unavailable");
}

export function createGatewayUpdateControl({ config, now = () => new Date(), randomUUIDFn = randomUUID } = {}) {
  if (!config) throw new TypeError("gateway update control requires config");
  const supported = typeof config.controlPath === "string" && config.controlPath.length > 0;
  const requestDirectory = supported ? join(config.controlPath, "requests") : null;
  const requestPath = supported ? join(requestDirectory, "request.json") : null;
  const statusPath = supported ? join(config.controlPath, "status", "status.json") : null;

  async function readCurrent() {
    try {
      return safeRelease(await readOptionalJson(config.releaseMetadataPath));
    } catch {
      return null;
    }
  }

  async function readUpdaterStatus() {
    if (!supported) return null;
    try {
      const raw = await readOptionalJson(statusPath);
      if (raw === null) return null;
      const status = safeStatus(raw);
      if (!status) throw new Error("unsafe updater status");
      return status;
    } catch {
      throw unavailable();
    }
  }

  async function readPendingRequest() {
    if (!supported) return null;
    try {
      const raw = await readOptionalJson(requestPath);
      if (raw === null) return null;
      const request = safeRequest(raw);
      if (!request) throw new Error("unsafe update request");
      return request;
    } catch {
      throw unavailable();
    }
  }

  async function getStatus() {
    const current = await readCurrent();
    if (!supported) {
      return { supported: false, state: "disabled", current, target: null, requestId: null, checkedAt: null, startedAt: null, finishedAt: null, error: null };
    }
    const [status, pending] = await Promise.all([readUpdaterStatus(), readPendingRequest()]);
    if (pending) {
      return {
        supported: true,
        state: pending.action === "check" ? "checking" : "queued",
        current,
        target: pending.action === "apply" ? { commit: pending.targetCommit, version: status?.target?.version ?? null } : null,
        requestId: pending.requestId,
        checkedAt: status?.checkedAt ?? null,
        startedAt: null,
        finishedAt: null,
        error: null,
      };
    }
    return {
      supported: true,
      state: status?.state ?? "idle",
      current,
      target: status?.target ?? null,
      requestId: status?.requestId ?? null,
      checkedAt: status?.checkedAt ?? null,
      startedAt: status?.startedAt ?? null,
      finishedAt: status?.finishedAt ?? null,
      error: status?.error ?? null,
    };
  }

  async function writeRequest(request) {
    if (!supported) throw unavailable();
    try {
      const directory = await lstat(requestDirectory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("unsafe request directory");
      if (await readPendingRequest()) throw new ApiError("update_busy", "A Gateway update operation is already queued");
      const tempPath = join(requestDirectory, `.request-${request.requestId}.tmp`);
      const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(request)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(tempPath, requestPath);
      } finally {
        await unlink(tempPath).catch(() => {});
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.code === "EEXIST") throw new ApiError("update_busy", "A Gateway update operation is already queued");
      throw unavailable();
    }
  }

  function nextRequestId() {
    return `upd_${randomUUIDFn().replaceAll("-", "")}`;
  }

  async function queueCheck() {
    if (!supported) throw unavailable();
    const status = await getStatus();
    if (ACTIVE_STATES.has(status.state)) throw new ApiError("update_busy", "A Gateway update operation is active");
    const requestId = nextRequestId();
    await writeRequest({ schemaVersion: 1, requestId, action: "check", requestedAt: now().toISOString() });
    return { ...status, state: "checking", target: null, requestId, startedAt: null, finishedAt: null, error: null };
  }

  async function queueApply({ targetCommit, ifRequestId }) {
    if (!supported) throw unavailable();
    if (!COMMIT.test(targetCommit ?? "") || !REQUEST_ID.test(ifRequestId ?? "")) {
      throw new ApiError("invalid_request", "targetCommit and ifRequestId are invalid");
    }
    const [status, current] = await Promise.all([readUpdaterStatus(), readCurrent()]);
    if (!status || status.state !== "available" || status.requestId !== ifRequestId || status.target?.commit !== targetCommit) {
      throw new ApiError("update_conflict", "The checked Gateway update is stale");
    }
    if (await readPendingRequest()) throw new ApiError("update_busy", "A Gateway update operation is already queued");
    const requestId = nextRequestId();
    await writeRequest({
      schemaVersion: 1,
      requestId,
      action: "apply",
      targetCommit,
      checkedRequestId: ifRequestId,
      requestedAt: now().toISOString(),
    });
    return {
      supported: true,
      state: "queued",
      current,
      target: status.target,
      requestId,
      checkedAt: status.checkedAt,
      startedAt: null,
      finishedAt: null,
      error: null,
    };
  }

  return { getStatus, queueCheck, queueApply };
}
