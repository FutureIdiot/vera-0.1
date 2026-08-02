import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  COMMIT,
  REQUEST_ID,
  isPathWithin,
  parseUpdateConfig,
  parseUpdateRequest,
  safeUpdateError,
  UpdateFailure,
} from "./gateway-update-contract.js";

const MAX_REQUEST_BYTES = 16 * 1024;
const ROLLBACK_METADATA_KEYS = ["backupPath", "candidateCommit", "createdAt", "previousRelease", "schemaVersion", "source"];
const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function readRequest(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_REQUEST_BYTES) throw new UpdateFailure("request_invalid", "Update request is invalid");
    return parseUpdateRequest(JSON.parse(await handle.readFile("utf8")));
  } catch (error) {
    if (error instanceof UpdateFailure) throw error;
    throw new UpdateFailure("request_invalid", "Update request is invalid");
  } finally {
    await handle?.close();
  }
}

async function readJsonFile(path, { maxBytes, errorCode = "rollback_invalid" }) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || (stat.mode & 0o077) !== 0) {
      throw new UpdateFailure(errorCode, "Updater state is invalid");
    }
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof UpdateFailure) throw error;
    throw new UpdateFailure(errorCode, "Updater state is invalid");
  } finally {
    await handle?.close();
  }
}

async function writeStatus(config, value) {
  await mkdir(config.statusDirectory, { recursive: true, mode: 0o2750 });
  const path = join(config.statusDirectory, `.status-${process.pid}-${Date.now()}.tmp`);
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, ...value })}\n`, { mode: 0o640, flag: "wx" });
  await chmod(path, 0o640);
  await rename(path, config.statusPath);
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 1024 * 1024) child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 1024 * 1024) child.kill("SIGKILL"); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 || options.allowFailure) resolvePromise({ code, stdout, stderr });
      else reject(new Error(`${command} exited ${code}`));
    });
  });
}

async function ensurePublicRepository(config, exec) {
  const gitPath = join(config.repositoryPath, ".git");
  let exists = false;
  try { exists = (await lstat(gitPath)).isDirectory(); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (!exists) {
    await mkdir(config.updateRoot, { recursive: true, mode: 0o750 });
    await exec("git", ["clone", "--filter=blob:none", "--no-checkout", "--origin", "origin", config.repository, config.repositoryPath]);
  } else {
    const remote = await exec("git", ["-C", config.repositoryPath, "remote", "get-url", "origin"]);
    if (remote.stdout.trim() !== config.repository) throw new UpdateFailure("configuration_invalid", "Updater repository is invalid");
  }
  try {
    await exec("git", ["-C", config.repositoryPath, "fetch", "--prune", "--no-tags", "origin", config.branch]);
    const result = await exec("git", ["-C", config.repositoryPath, "rev-parse", `refs/remotes/origin/${config.branch}^{commit}`]);
    const commit = result.stdout.trim();
    if (!COMMIT.test(commit)) throw new Error("invalid commit");
    return commit;
  } catch (error) {
    if (error instanceof UpdateFailure) throw error;
    throw new UpdateFailure("remote_unavailable", "The update source is unavailable");
  }
}

async function ensureCandidateRepository(config, commit, exec) {
  if (!config.candidateRepository) throw new UpdateFailure("configuration_invalid", "Updater configuration is invalid");
  const ref = `refs/heads/candidates/${commit}`;
  try {
    const gitPath = join(config.repositoryPath, ".git");
    let exists = false;
    try { exists = (await lstat(gitPath)).isDirectory(); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (!exists) {
      await mkdir(config.updateRoot, { recursive: true, mode: 0o750 });
      await exec("git", ["init", config.repositoryPath]);
      await exec("git", ["-C", config.repositoryPath, "remote", "add", "origin", config.repository]);
    } else {
      const remote = await exec("git", ["-C", config.repositoryPath, "remote", "get-url", "origin"]);
      if (remote.stdout.trim() !== config.repository) throw new UpdateFailure("configuration_invalid", "Updater repository is invalid");
    }
    const result = await exec("git", ["-C", config.repositoryPath, "fetch", "--no-tags", "--force", config.candidateRepository, ref]);
    if (result.code !== 0) throw new Error("candidate fetch failed");
    const parsed = await exec("git", ["-C", config.repositoryPath, "rev-parse", "FETCH_HEAD^{commit}"]);
    if (parsed.stdout.trim() !== commit || !COMMIT.test(parsed.stdout.trim())) throw new UpdateFailure("target_changed", "The checked update is no longer current");
    return commit;
  } catch (error) {
    if (error instanceof UpdateFailure) throw error;
    throw new UpdateFailure("remote_unavailable", "The update source is unavailable");
  }
}

async function releaseMarker(path) {
  try {
    const value = JSON.parse(await readFile(join(path, ".vera-release.json"), "utf8"));
    return value?.schemaVersion === 1 && COMMIT.test(value.commit)
      ? { ...value, source: value.source === "candidate" ? "candidate" : "public" }
      : null;
  } catch { return null; }
}

async function targetVersion(config, commit, exec) {
  try {
    const result = await exec("git", ["-C", config.repositoryPath, "show", `${commit}:package.json`]);
    const version = JSON.parse(result.stdout).version;
    return typeof version === "string" && version.length <= 80 ? version : null;
  } catch { return null; }
}

async function normalizeReleasePermissions(path) {
  await chmod(path, 0o755);
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) {
      await normalizeReleasePermissions(childPath);
    } else if (entry.isFile()) {
      const file = await lstat(childPath);
      await chmod(childPath, file.mode & 0o111 ? 0o755 : 0o644);
    } else if (!entry.isSymbolicLink()) {
      throw new UpdateFailure("release_failed", "The new release could not be prepared");
    }
  }
}

async function prepareRelease(config, commit, version, source, exec, now) {
  const releasePath = join(config.releasesPath, commit);
  const existing = await releaseMarker(releasePath);
  if (existing?.commit === commit && existing.source === source) return releasePath;
  if (existing?.commit === commit) throw new UpdateFailure("release_failed", "The new release could not be prepared");
  const stagingPath = join(config.releasesPath, `.staging-${commit}-${process.pid}`);
  const archivePath = join(config.releasesPath, `.archive-${commit}-${process.pid}.tar`);
  await mkdir(config.releasesPath, { recursive: true, mode: 0o755 });
  try {
    await exec("git", ["-C", config.repositoryPath, "archive", "--format=tar", `--output=${archivePath}`, commit]);
    await mkdir(stagingPath, { mode: 0o755 });
    await exec("tar", ["-xf", archivePath, "-C", stagingPath]);
    await exec("npm", ["ci"], { cwd: stagingPath, env: { ...process.env, NODE_ENV: "development", NPM_CONFIG_CACHE: join(config.updateRoot, "npm-cache") } });
    await exec("npm", ["test"], { cwd: stagingPath, env: { ...process.env, NODE_ENV: "test", NPM_CONFIG_CACHE: join(config.updateRoot, "npm-cache") } });
    await exec("npm", ["run", "build:web"], { cwd: stagingPath, env: { ...process.env, NODE_ENV: "production", NPM_CONFIG_CACHE: join(config.updateRoot, "npm-cache") } });
    await exec("node", ["--check", join(stagingPath, "src", "server.js")]);
    const markerPath = join(stagingPath, ".vera-release.json");
    await writeFile(markerPath, `${JSON.stringify({ schemaVersion: 1, commit, version, source, deployedAt: now().toISOString() })}\n`, { mode: 0o644, flag: "wx" });
    await normalizeReleasePermissions(stagingPath);
    await rename(stagingPath, releasePath);
    return releasePath;
  } catch {
    throw new UpdateFailure("release_failed", "The new release could not be prepared");
  } finally {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    await unlink(archivePath).catch(() => {});
  }
}

async function healthy(url, { fetchImpl, sleep, attempts = 30 }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
      const value = response.ok ? await response.json() : null;
      if (value?.app === "vera" && value?.ok === true) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

async function currentTarget(config) {
  const stat = await lstat(config.currentPath);
  if (!stat.isSymbolicLink()) throw new UpdateFailure("configuration_invalid", "Gateway current release is invalid");
  const raw = await readlink(config.currentPath);
  const target = resolve(config.releaseRoot, raw);
  const releaseName = basename(target);
  if (
    !COMMIT.test(releaseName) ||
    target !== join(config.releasesPath, releaseName) ||
    !isPathWithin(config.releasesPath, target)
  ) {
    throw new UpdateFailure("configuration_invalid", "Gateway current release is invalid");
  }
  return target;
}

async function switchCurrent(config, target) {
  const next = join(config.releaseRoot, `.current-${process.pid}`);
  await unlink(next).catch(() => {});
  await symlink(target, next);
  await rename(next, config.currentPath);
}

async function backupData(config, oldTarget, targetCommit, exec, now) {
  try {
    await exec("systemctl", ["stop", config.service]);
    const data = await lstat(config.dataPath);
    if (!data.isDirectory() || data.isSymbolicLink()) throw new Error("unsafe data path");
    await mkdir(config.backupRoot, { recursive: true, mode: 0o700 });
    const stamp = now().toISOString().replace(/[:.]/gu, "-");
    const backupPath = join(config.backupRoot, `${stamp}-${basename(oldTarget)}`);
    await mkdir(backupPath, { mode: 0o700 });
    await exec("cp", ["-a", "--", config.dataPath, join(backupPath, "data")]);
    await writeFile(join(backupPath, "metadata.json"), `${JSON.stringify({ schemaVersion: 1, previousRelease: basename(oldTarget), targetCommit, createdAt: now().toISOString() })}\n`, { mode: 0o600 });
    return backupPath;
  } catch {
    await exec("systemctl", ["start", config.service], { allowFailure: true }).catch(() => {});
    throw new UpdateFailure("backup_failed", "Gateway data could not be backed up");
  }
}

async function writeRollbackMetadata(config, { candidateCommit, oldTarget, backupPath, now }) {
  const value = {
    schemaVersion: 1,
    source: "candidate",
    candidateCommit,
    previousRelease: basename(oldTarget),
    backupPath: basename(backupPath),
    createdAt: now().toISOString(),
  };
  const temporary = `${config.rollbackMetadataPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, config.rollbackMetadataPath).catch(async (error) => {
    await unlink(temporary).catch(() => {});
    throw error;
  });
}

async function readRollbackMetadata(config) {
  const value = await readJsonFile(config.rollbackMetadataPath, { maxBytes: 4096 });
  if (
    !exactKeys(value, ROLLBACK_METADATA_KEYS) ||
    value.schemaVersion !== 1 ||
    value.source !== "candidate" ||
    !COMMIT.test(value.candidateCommit) ||
    !COMMIT.test(value.previousRelease) ||
    !SAFE_BASENAME.test(value.backupPath) ||
    Number.isNaN(Date.parse(value.createdAt))
  ) throw new UpdateFailure("rollback_invalid", "Gateway rollback state is invalid");
  const previousRelease = join(config.releasesPath, value.previousRelease);
  const backupPath = join(config.backupRoot, value.backupPath);
  if (!isPathWithin(config.releasesPath, previousRelease) || !isPathWithin(config.backupRoot, backupPath)) {
    throw new UpdateFailure("rollback_invalid", "Gateway rollback state is invalid");
  }
  const [releaseStat, backupStat, backupDataStat] = await Promise.all([
    lstat(previousRelease),
    lstat(backupPath),
    lstat(join(backupPath, "data")),
  ]).catch(() => { throw new UpdateFailure("rollback_invalid", "Gateway rollback state is invalid"); });
  if (
    !releaseStat.isDirectory() || releaseStat.isSymbolicLink() ||
    !backupStat.isDirectory() || backupStat.isSymbolicLink() ||
    !backupDataStat.isDirectory() || backupDataStat.isSymbolicLink()
  ) throw new UpdateFailure("rollback_invalid", "Gateway rollback state is invalid");
  const marker = await releaseMarker(previousRelease);
  if (!marker || marker.commit !== value.previousRelease) throw new UpdateFailure("rollback_invalid", "Gateway rollback state is invalid");
  return { ...value, previousRelease, backupPath };
}

async function moveDataToFailedPath(config, requestId) {
  const dataStat = await lstat(config.dataPath);
  if (!dataStat.isDirectory() || dataStat.isSymbolicLink()) throw new UpdateFailure("rollback_failed", "Gateway rollback needs administrator attention");
  const failedDataPath = join(resolve(config.dataPath, ".."), `${basename(config.dataPath)}.failed-update-${requestId.slice(-8)}`);
  if (!isPathWithin(resolve(config.dataPath, ".."), failedDataPath) || failedDataPath === config.dataPath) {
    throw new UpdateFailure("rollback_failed", "Gateway rollback needs administrator attention");
  }
  try { await lstat(failedDataPath); throw new Error("failed data path exists"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await rename(config.dataPath, failedDataPath);
  return failedDataPath;
}

async function restore(config, { oldTarget, backupPath, requestId, target, startedAt, exec, fetchImpl, sleep, now }) {
  try {
    await exec("systemctl", ["stop", config.service], { allowFailure: true });
    await switchCurrent(config, oldTarget);
    await moveDataToFailedPath(config, requestId);
    await exec("cp", ["-a", "--", join(backupPath, "data"), config.dataPath]);
    await exec("systemctl", ["start", config.service]);
    if (!await healthy(config.healthUrl, { fetchImpl, sleep })) throw new Error("rollback unhealthy");
    await writeStatus(config, { state: "rolled_back", requestId, target, checkedAt: null, startedAt, finishedAt: now().toISOString(), error: { code: "service_failed", message: "Gateway did not become healthy; the previous release was restored" } });
  } catch {
    await writeStatus(config, { state: "failed", requestId, target, checkedAt: null, startedAt, finishedAt: now().toISOString(), error: safeUpdateError(new UpdateFailure("rollback_failed", "Gateway rollback needs administrator attention")) });
  }
}

async function runCandidateRollback(config, request, { exec, fetchImpl, sleep, now, current }) {
  if (!current || current.source !== "candidate" || current.commit !== request.ifCurrentCommit) {
    throw new UpdateFailure("rollback_invalid", "Gateway rollback state is invalid");
  }
  const metadata = await readRollbackMetadata(config);
  if (metadata.candidateCommit !== current.commit || metadata.candidateCommit !== request.ifCurrentCommit) {
    throw new UpdateFailure("rollback_invalid", "Gateway rollback state is invalid");
  }
  const startedAt = now().toISOString();
  const target = { commit: request.ifCurrentCommit, version: current.version ?? null };
  await writeStatus(config, { state: "updating", requestId: request.requestId, target, checkedAt: null, startedAt, finishedAt: null, error: null });
  try {
    await exec("systemctl", ["stop", config.service], { allowFailure: true });
    await switchCurrent(config, metadata.previousRelease);
    await moveDataToFailedPath(config, request.requestId);
    await exec("cp", ["-a", "--", join(metadata.backupPath, "data"), config.dataPath]);
    await exec("systemctl", ["start", config.service]);
    if (!await healthy(config.healthUrl, { fetchImpl, sleep })) throw new Error("rollback unhealthy");
    await unlink(config.rollbackMetadataPath);
    const restored = await releaseMarker(metadata.previousRelease);
    await writeStatus(config, {
      state: "rolled_back",
      requestId: request.requestId,
      target: { commit: restored.commit, version: restored.version ?? null },
      checkedAt: null,
      startedAt,
      finishedAt: now().toISOString(),
      error: null,
    });
  } catch (error) {
    await writeStatus(config, {
      state: "failed",
      requestId: request.requestId,
      target,
      checkedAt: null,
      startedAt,
      finishedAt: now().toISOString(),
      error: safeUpdateError(error instanceof UpdateFailure ? error : new UpdateFailure("rollback_failed", "Gateway rollback needs administrator attention")),
    });
  }
}

export async function runGatewayUpdate(env, {
  exec = runCommand,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  now = () => new Date(),
} = {}) {
  let config;
  let request;
  try {
    config = parseUpdateConfig(env);
    request = await readRequest(config.requestPath);
    await unlink(config.requestPath);
    if (request.action === "check") {
      await writeStatus(config, { state: "checking", requestId: request.requestId, target: null, checkedAt: null, startedAt: null, finishedAt: null, error: null });
    }
    const current = await releaseMarker(config.currentPath);
    if (request.action === "rollback") {
      await writeStatus(config, { state: "queued", requestId: request.requestId, target: { commit: request.ifCurrentCommit, version: null }, checkedAt: null, startedAt: null, finishedAt: null, error: null });
      await runCandidateRollback(config, request, { exec, fetchImpl, sleep, now, current });
      return;
    }
    if (request.action !== "check") {
      await writeStatus(config, { state: "queued", requestId: request.requestId, target: { commit: request.targetCommit, version: null }, checkedAt: null, startedAt: null, finishedAt: null, error: null });
    }
    const targetCommit = request.action === "candidate"
      ? await ensureCandidateRepository(config, request.targetCommit, exec)
      : await ensurePublicRepository(config, exec);
    const version = await targetVersion(config, targetCommit, exec);
    if (request.action === "check") {
      await writeStatus(config, {
        state: current?.commit === targetCommit ? "up_to_date" : "available",
        requestId: request.requestId,
        target: { commit: targetCommit, version },
        checkedAt: now().toISOString(),
        startedAt: null,
        finishedAt: now().toISOString(),
        error: null,
      });
      return;
    }
    if (request.targetCommit !== targetCommit) throw new UpdateFailure("target_changed", "The checked update is no longer current");
    const startedAt = now().toISOString();
    const source = request.action === "candidate" ? "candidate" : "public";
    const target = { commit: targetCommit, version };
    await writeStatus(config, { state: "updating", requestId: request.requestId, target, checkedAt: null, startedAt, finishedAt: null, error: null });
    const releasePath = await prepareRelease(config, targetCommit, version, source, exec, now);
    const oldTarget = await currentTarget(config);
    const backupPath = await backupData(config, oldTarget, targetCommit, exec, now);
    try {
      await switchCurrent(config, releasePath);
      await exec("systemctl", ["start", config.service]);
      if (!await healthy(config.healthUrl, { fetchImpl, sleep })) throw new UpdateFailure("service_failed", "Gateway did not become healthy");
      if (source === "candidate") {
        await writeRollbackMetadata(config, { candidateCommit: targetCommit, oldTarget, backupPath, now });
      } else {
        await unlink(config.rollbackMetadataPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      }
      await writeStatus(config, { state: "succeeded", requestId: request.requestId, target, checkedAt: null, startedAt, finishedAt: now().toISOString(), error: null });
    } catch {
      await restore(config, { oldTarget, backupPath, requestId: request.requestId, target, startedAt, exec, fetchImpl, sleep, now });
    }
  } catch (error) {
    if (config) {
      await unlink(config.requestPath).catch(() => {});
      await writeStatus(config, {
        state: "failed",
        requestId: REQUEST_ID.test(request?.requestId ?? "") ? request.requestId : null,
        target: request?.targetCommit && COMMIT.test(request.targetCommit) ? { commit: request.targetCommit, version: null } : null,
        checkedAt: null,
        startedAt: null,
        finishedAt: now().toISOString(),
        error: safeUpdateError(error),
      }).catch(() => {});
    }
    throw error;
  }
}
