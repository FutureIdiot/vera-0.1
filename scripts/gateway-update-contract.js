import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const COMMIT = /^[0-9a-f]{40}$/u;
export const REQUEST_ID = /^upd_[0-9a-f]{32}$/u;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const SAFE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}\.service$/u;

export class UpdateFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) throw new UpdateFailure("configuration_invalid", "Updater configuration is invalid");
  return value;
}

function absolute(env, name) {
  const value = required(env, name);
  if (!isAbsolute(value)) throw new UpdateFailure("configuration_invalid", "Updater configuration is invalid");
  return resolve(value);
}

export function isPathWithin(parent, child) {
  const relation = relative(resolve(parent), resolve(child));
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

export function parseUpdateConfig(env) {
  const updateRoot = absolute(env, "VERA_UPDATE_ROOT");
  const releaseRoot = absolute(env, "VERA_RELEASE_ROOT");
  const dataPath = absolute(env, "VERA_UPDATE_DATA_PATH");
  const repository = required(env, "VERA_UPDATE_REPOSITORY");
  const branch = required(env, "VERA_UPDATE_BRANCH");
  const service = required(env, "VERA_UPDATE_SERVICE");
  const healthUrl = required(env, "VERA_UPDATE_HEALTH_URL");
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u.test(repository)) {
    throw new UpdateFailure("configuration_invalid", "Updater repository is invalid");
  }
  if (!SAFE_BRANCH.test(branch) || branch.includes("..") || branch.startsWith("-") || !SAFE_SERVICE.test(service)) {
    throw new UpdateFailure("configuration_invalid", "Updater target is invalid");
  }
  let health;
  try { health = new URL(healthUrl); } catch { throw new UpdateFailure("configuration_invalid", "Updater health URL is invalid"); }
  if (health.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(health.hostname) || health.username || health.password) {
    throw new UpdateFailure("configuration_invalid", "Updater health URL is invalid");
  }
  if (
    isPathWithin(releaseRoot, dataPath) || isPathWithin(dataPath, releaseRoot) ||
    isPathWithin(updateRoot, dataPath) || isPathWithin(dataPath, updateRoot)
  ) throw new UpdateFailure("configuration_invalid", "Updater paths overlap");
  return {
    updateRoot,
    releaseRoot,
    dataPath,
    repository,
    branch,
    service,
    healthUrl: health.toString(),
    repositoryPath: join(updateRoot, "repository"),
    requestPath: join(updateRoot, "requests", "request.json"),
    statusDirectory: join(updateRoot, "status"),
    statusPath: join(updateRoot, "status", "status.json"),
    backupRoot: join(updateRoot, "backups"),
    currentPath: join(releaseRoot, "current"),
    releasesPath: join(releaseRoot, "releases"),
  };
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parseUpdateRequest(value) {
  if (!value || value.schemaVersion !== 1 || !REQUEST_ID.test(value.requestId) || Number.isNaN(Date.parse(value.requestedAt))) {
    throw new UpdateFailure("request_invalid", "Update request is invalid");
  }
  if (value.action === "check" && exactKeys(value, ["action", "requestId", "requestedAt", "schemaVersion"])) return value;
  if (
    value.action === "apply" &&
    exactKeys(value, ["action", "checkedRequestId", "requestId", "requestedAt", "schemaVersion", "targetCommit"]) &&
    REQUEST_ID.test(value.checkedRequestId) &&
    COMMIT.test(value.targetCommit)
  ) return value;
  throw new UpdateFailure("request_invalid", "Update request is invalid");
}

export function safeUpdateError(error) {
  const code = /^[a-z][a-z0-9_]{0,63}$/u.test(error?.code ?? "") ? error.code : "update_failed";
  const messages = {
    configuration_invalid: "Updater configuration is invalid",
    request_invalid: "Update request is invalid",
    remote_unavailable: "The update source is unavailable",
    target_changed: "The checked update is no longer current",
    release_failed: "The new release could not be prepared",
    backup_failed: "Gateway data could not be backed up",
    service_failed: "Gateway did not become healthy",
    rollback_failed: "Gateway rollback needs administrator attention",
  };
  return { code, message: messages[code] ?? "Gateway update failed" };
}
