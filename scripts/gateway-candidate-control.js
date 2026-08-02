#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readlink, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMIT, isPathWithin, parseUpdateConfig } from "./gateway-update-contract.js";

const ACTIVE_STATES = new Set(["checking", "queued", "updating"]);
const REQUEST_ID = /^upd_[0-9a-f]{32}$/u;
const STATES = new Set(["idle", "checking", "up_to_date", "available", "queued", "updating", "succeeded", "failed", "rolled_back"]);

function fail(message) {
  throw new Error(message);
}

async function readJson(path, maxBytes) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) fail("Updater state is invalid");
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.message === "Updater state is invalid") throw error;
    throw new Error("Updater state is invalid");
  } finally {
    await handle?.close();
  }
}

async function currentMarker(config) {
  const current = await lstat(config.currentPath);
  if (!current.isSymbolicLink()) fail("Gateway current release is invalid");
  const target = resolve(config.releaseRoot, await readlink(config.currentPath));
  const releaseName = basename(target);
  if (!COMMIT.test(releaseName) || target !== join(config.releasesPath, releaseName) || !isPathWithin(config.releasesPath, target)) {
    fail("Gateway current release is invalid");
  }
  const marker = await readJson(join(target, ".vera-release.json"), 4096);
  if (!marker || marker.schemaVersion !== 1 || !COMMIT.test(marker.commit)) fail("Gateway current release is invalid");
  return {
    commit: marker.commit,
    source: marker.source === "candidate" ? "candidate" : "public",
    version: typeof marker.version === "string" && marker.version.length <= 80 ? marker.version : null,
  };
}

function safeTarget(value) {
  if (!value || typeof value !== "object" || !COMMIT.test(value.commit ?? "")) return null;
  return { commit: value.commit, version: typeof value.version === "string" && value.version.length <= 80 ? value.version : null };
}

async function updaterProjection(config) {
  const value = await readJson(config.statusPath, 16 * 1024);
  if (!value) return { state: "idle", target: null };
  if (value.schemaVersion !== 1 || !STATES.has(value.state)) fail("Updater state is invalid");
  return { state: value.state, target: safeTarget(value.target) };
}

async function rejectBusy(config) {
  const request = await lstat(config.requestPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw new Error("Updater request state is invalid");
  });
  if (request) fail("Gateway update operation is already active or pending");
  const status = await updaterProjection(config);
  if (ACTIVE_STATES.has(status.state)) fail("Gateway update operation is already active or pending");
}

function requestFor(action, commit) {
  const requestId = `upd_${randomBytes(16).toString("hex")}`;
  const requestedAt = new Date().toISOString();
  return action === "candidate"
    ? { schemaVersion: 1, requestId, action, targetCommit: commit, requestedAt }
    : { schemaVersion: 1, requestId, action, ifCurrentCommit: commit, requestedAt };
}

async function writeRequest(config, request) {
  const directory = await lstat(join(config.updateRoot, "requests"));
  if (!directory.isDirectory() || directory.isSymbolicLink()) fail("Updater request directory is invalid");
  await rejectBusy(config);
  const temporary = join(config.updateRoot, "requests", `.request-${request.requestId}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(request)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporary, config.requestPath);
  } catch (error) {
    if (error?.code === "EEXIST") fail("Gateway update operation is already active or pending");
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
  return { requestId: request.requestId, action: request.action };
}

export async function createCandidateControl({ env = process.env } = {}) {
  const config = parseUpdateConfig(env);
  return {
    candidate: async (commit) => {
      if (!COMMIT.test(commit ?? "")) fail("Candidate commit must be a full commit");
      return writeRequest(config, requestFor("candidate", commit));
    },
    rollback: async (commit) => {
      if (!COMMIT.test(commit ?? "")) fail("Rollback commit must be a full commit");
      return writeRequest(config, requestFor("rollback", commit));
    },
    status: async () => ({ schemaVersion: 1, current: await currentMarker(config), update: await updaterProjection(config) }),
  };
}

export async function main(argv = process.argv.slice(2), { env = process.env } = {}) {
  if (argv.length < 1 || argv.length > 2 || !["candidate", "rollback", "status"].includes(argv[0]) || (argv[0] === "status" && argv.length !== 1) || (argv[0] !== "status" && argv.length !== 2)) {
    fail("Usage: gateway-candidate-control.js <candidate|rollback> <40-hex-commit> | status");
  }
  const control = await createCandidateControl({ env });
  const result = argv[0] === "status" ? await control.status() : await control[argv[0]](argv[1]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
