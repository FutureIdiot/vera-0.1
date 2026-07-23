import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseUpdateConfig, parseUpdateRequest } from "../../scripts/gateway-update-contract.js";
import { runGatewayUpdate } from "../../scripts/gateway-update-runtime.js";

const TARGET = "3".repeat(40);
const REQUEST_ID = `upd_${"a".repeat(32)}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vera-root-updater-"));
  const updateRoot = join(root, "update");
  const releaseRoot = join(root, "release");
  const dataPath = join(root, "data");
  await mkdir(join(updateRoot, "requests"), { recursive: true });
  await mkdir(join(updateRoot, "status"), { recursive: true });
  await mkdir(releaseRoot);
  await mkdir(dataPath);
  const env = {
    VERA_UPDATE_ROOT: updateRoot,
    VERA_RELEASE_ROOT: releaseRoot,
    VERA_UPDATE_DATA_PATH: dataPath,
    VERA_UPDATE_REPOSITORY: "https://github.com/FutureIdiot/vera-0.1.git",
    VERA_UPDATE_BRANCH: "master",
    VERA_UPDATE_SERVICE: "vera-gateway.service",
    VERA_UPDATE_HEALTH_URL: "http://127.0.0.1:3210/api/health",
  };
  return { root, updateRoot, releaseRoot, dataPath, env };
}

async function applyFixture() {
  const value = await fixture();
  const oldCommit = "1".repeat(40);
  const oldRelease = join(value.releaseRoot, "releases", oldCommit);
  await mkdir(oldRelease, { recursive: true });
  await writeFile(join(oldRelease, ".vera-release.json"), JSON.stringify({ schemaVersion: 1, commit: oldCommit, version: "0.0.1", deployedAt: "2026-07-22T00:00:00.000Z" }));
  await symlink(oldRelease, join(value.releaseRoot, "current"));
  await writeFile(join(value.dataPath, "canary"), "original");
  await writeFile(join(value.updateRoot, "requests", "request.json"), JSON.stringify({
    schemaVersion: 1,
    requestId: REQUEST_ID,
    action: "apply",
    targetCommit: TARGET,
    checkedRequestId: `upd_${"b".repeat(32)}`,
    requestedAt: "2026-07-23T00:00:00.000Z",
  }));
  return { ...value, oldCommit, oldRelease };
}

function releaseExec(fixtureValue, { mutateOnNewStart = false } = {}) {
  let startCount = 0;
  const calls = [];
  const exec = async (command, args, options = {}) => {
    calls.push([command, args, options.cwd ?? null]);
    if (command === "git" && args[0] === "clone") {
      await mkdir(join(fixtureValue.updateRoot, "repository", ".git"), { recursive: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "git" && args.includes("rev-parse")) return { code: 0, stdout: `${TARGET}\n`, stderr: "" };
    if (command === "git" && args.includes("show")) return { code: 0, stdout: JSON.stringify({ version: "0.1.0" }), stderr: "" };
    if (command === "git" && args.includes("archive")) {
      const output = args.find((value) => value.startsWith("--output=")).slice("--output=".length);
      await writeFile(output, "fake archive");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "tar") {
      const destination = args[args.indexOf("-C") + 1];
      await mkdir(join(destination, "src"), { recursive: true });
      await writeFile(join(destination, "src", "server.js"), "export {};\n");
      await writeFile(join(destination, "package.json"), JSON.stringify({ name: "vera", version: "0.1.0" }));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "npm" && args[0] === "run") {
      await mkdir(join(options.cwd, "dist"), { recursive: true });
      await writeFile(join(options.cwd, "dist", "index.html"), "ok");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "cp") {
      await cp(args[args.length - 2], args[args.length - 1], { recursive: true, preserveTimestamps: true, errorOnExist: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "systemctl" && args[0] === "start") {
      startCount += 1;
      if (mutateOnNewStart && startCount === 1) await writeFile(join(fixtureValue.dataPath, "canary"), "migrated");
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls, get startCount() { return startCount; } };
}

test("root updater config rejects browser-shaped targets and overlapping paths", async () => {
  const { env, releaseRoot } = await fixture();
  assert.equal(parseUpdateConfig(env).branch, "master");
  assert.throws(() => parseUpdateConfig({ ...env, VERA_UPDATE_REPOSITORY: "ssh://evil/repo" }), { code: "configuration_invalid" });
  assert.throws(() => parseUpdateConfig({ ...env, VERA_UPDATE_BRANCH: "../evil" }), { code: "configuration_invalid" });
  assert.throws(() => parseUpdateConfig({ ...env, VERA_UPDATE_DATA_PATH: join(releaseRoot, "data") }), { code: "configuration_invalid" });
});

test("root updater request parser accepts only frozen check and apply shapes", () => {
  const check = { schemaVersion: 1, requestId: REQUEST_ID, action: "check", requestedAt: "2026-07-23T00:00:00.000Z" };
  assert.deepEqual(parseUpdateRequest(check), check);
  assert.throws(() => parseUpdateRequest({ ...check, repository: "evil" }), { code: "request_invalid" });
  const apply = { ...check, action: "apply", targetCommit: TARGET, checkedRequestId: `upd_${"b".repeat(32)}` };
  assert.deepEqual(parseUpdateRequest(apply), apply);
  assert.throws(() => parseUpdateRequest({ ...apply, targetCommit: "master" }), { code: "request_invalid" });
});

test("check request writes only a safe available status", async () => {
  const { env, updateRoot } = await fixture();
  await writeFile(join(updateRoot, "requests", "request.json"), JSON.stringify({ schemaVersion: 1, requestId: REQUEST_ID, action: "check", requestedAt: "2026-07-23T00:00:00.000Z" }));
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, args]);
    if (args.includes("get-url")) return { code: 0, stdout: `${env.VERA_UPDATE_REPOSITORY}\n`, stderr: "" };
    if (args.includes("rev-parse")) return { code: 0, stdout: `${TARGET}\n`, stderr: "" };
    if (args.includes("show")) return { code: 0, stdout: JSON.stringify({ version: "0.1.0", secret: "not-projected" }), stderr: "" };
    if (command === "git" && args[0] === "clone") {
      await mkdir(join(updateRoot, "repository", ".git"), { recursive: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  await runGatewayUpdate(env, { exec, now: () => new Date("2026-07-23T01:02:03.000Z") });
  const status = JSON.parse(await readFile(join(updateRoot, "status", "status.json"), "utf8"));
  assert.equal(status.state, "available");
  assert.deepEqual(status.target, { commit: TARGET, version: "0.1.0" });
  assert.equal(JSON.stringify(status).includes("secret"), false);
  assert.equal(calls.some(([, args]) => args.includes("fetch")), true);
});

test("changed apply target fails before npm, service, or data mutation", async () => {
  const { env, updateRoot, dataPath } = await fixture();
  await writeFile(join(dataPath, "canary"), "preserved");
  await writeFile(join(updateRoot, "requests", "request.json"), JSON.stringify({
    schemaVersion: 1,
    requestId: REQUEST_ID,
    action: "apply",
    targetCommit: "4".repeat(40),
    checkedRequestId: `upd_${"b".repeat(32)}`,
    requestedAt: "2026-07-23T00:00:00.000Z",
  }));
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, args]);
    if (args.includes("rev-parse")) return { code: 0, stdout: `${TARGET}\n`, stderr: "" };
    if (args.includes("show")) return { code: 0, stdout: JSON.stringify({ version: "0.1.0" }), stderr: "" };
    if (command === "git" && args[0] === "clone") {
      await mkdir(join(updateRoot, "repository", ".git"), { recursive: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(() => runGatewayUpdate(env, { exec }), { code: "target_changed" });
  const status = JSON.parse(await readFile(join(updateRoot, "status", "status.json"), "utf8"));
  assert.equal(status.state, "failed");
  assert.equal(status.error.code, "target_changed");
  assert.equal(calls.some(([command]) => command === "npm" || command === "systemctl"), false);
  assert.equal(await readFile(join(dataPath, "canary"), "utf8"), "preserved");
});

test("successful apply builds a release, preserves a cold backup, and switches atomically", async () => {
  const value = await applyFixture();
  const commands = releaseExec(value);
  const previousUmask = process.umask(0o027);
  try {
    await runGatewayUpdate(value.env, {
      exec: commands.exec,
      fetchImpl: async () => new Response(JSON.stringify({ app: "vera", ok: true }), { status: 200 }),
      sleep: async () => {},
      now: () => new Date("2026-07-23T01:02:03.000Z"),
    });
  } finally {
    process.umask(previousUmask);
  }
  assert.equal(await readlink(join(value.releaseRoot, "current")), join(value.releaseRoot, "releases", TARGET));
  assert.equal((await stat(join(value.releaseRoot, "releases", TARGET))).mode & 0o777, 0o755);
  assert.equal((await stat(join(value.releaseRoot, "releases", TARGET, ".vera-release.json"))).mode & 0o777, 0o644);
  const marker = JSON.parse(await readFile(join(value.releaseRoot, "releases", TARGET, ".vera-release.json"), "utf8"));
  assert.equal(marker.commit, TARGET);
  const status = JSON.parse(await readFile(join(value.updateRoot, "status", "status.json"), "utf8"));
  assert.equal(status.state, "succeeded");
  assert.equal(commands.calls.some(([command, args]) => command === "systemctl" && args[0] === "stop"), true);
  assert.equal(commands.calls.some(([command, args]) => command === "cp" && args[0] === "-a"), true);
});

test("unhealthy new release restores the old symlink and pre-update data", async () => {
  const value = await applyFixture();
  const commands = releaseExec(value, { mutateOnNewStart: true });
  const fetchImpl = async () => {
    const target = await readlink(join(value.releaseRoot, "current"));
    const ok = target === value.oldRelease;
    return new Response(JSON.stringify(ok ? { app: "vera", ok: true } : { app: "vera", ok: false }), { status: ok ? 200 : 503 });
  };
  await runGatewayUpdate(value.env, { exec: commands.exec, fetchImpl, sleep: async () => {} });
  assert.equal(await readlink(join(value.releaseRoot, "current")), value.oldRelease);
  assert.equal(await readFile(join(value.dataPath, "canary"), "utf8"), "original");
  const status = JSON.parse(await readFile(join(value.updateRoot, "status", "status.json"), "utf8"));
  assert.equal(status.state, "rolled_back");
  assert.equal(status.error.code, "service_failed");
  assert.equal(commands.startCount, 2);
});
