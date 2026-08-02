#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT = /^[0-9a-f]{40}$/u;
const SAFE_HOST = /^[A-Za-z0-9._-]{1,128}$/u;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const TERMINAL_STATES = new Set(["succeeded", "failed", "rolled_back"]);

export function runCommand(command, args, { cwd = process.cwd(), allowFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      const result = { code, stdout, stderr };
      if (code === 0 || allowFailure) resolvePromise(result);
      else reject(new Error(`${command} failed`));
    });
  });
}

function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label} returned an invalid response`); }
}

function assertCommit(value, label) {
  if (!COMMIT.test(value ?? "")) throw new Error(`${label} is not a full commit`);
  return value;
}

function normalizeStatus(value) {
  const update = value?.update ?? value?.status ?? null;
  const current = value?.current ?? update?.current ?? null;
  if (!update || !current) throw new Error("Gateway candidate status is incomplete");
  return { update, current };
}

export function createReleaseClient({
  cwd = process.cwd(),
  env = process.env,
  exec = runCommand,
  sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  now = () => new Date(),
} = {}) {
  const sshHost = env.VERA_DEPLOY_SSH_HOST || "vera-gateway";
  const candidatePath = env.VERA_DEPLOY_CANDIDATE_PATH || "/var/lib/vera-candidates/repository.git";
  const publicRemote = env.VERA_DEPLOY_PUBLIC_REMOTE || "origin";
  const publicBranch = env.VERA_DEPLOY_PUBLIC_BRANCH || "master";
  const remoteControl = env.VERA_DEPLOY_REMOTE_CONTROL || "/usr/local/sbin/vera-gateway-candidate";
  if (!SAFE_HOST.test(sshHost) || !candidatePath.startsWith("/") || !SAFE_BRANCH.test(publicBranch)) {
    throw new Error("Release client configuration is invalid");
  }
  const candidateRemote = `${sshHost}:${candidatePath}`;

  const command = (name, args, options = {}) => exec(name, args, { cwd, ...options });
  const git = (args, options = {}) => command("git", args, options);
  const ssh = (args, options = {}) => command("ssh", [sshHost, ...args], options);

  async function localHead({ requireClean = true } = {}) {
    if (requireClean) {
      const status = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
      if (status.stdout.trim()) throw new Error("Working tree must be clean");
    }
    const branch = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
    if (branch !== publicBranch) throw new Error(`Candidate must be created from ${publicBranch}`);
    return assertCommit((await git(["rev-parse", "HEAD^{commit}"])).stdout.trim(), "Local HEAD");
  }

  async function publicBase() {
    await git(["fetch", "--no-tags", publicRemote, publicBranch]);
    return assertCommit(
      (await git(["rev-parse", `refs/remotes/${publicRemote}/${publicBranch}^{commit}`])).stdout.trim(),
      "Public branch",
    );
  }

  async function requireAncestor(base, head) {
    const result = await git(["merge-base", "--is-ancestor", base, head], { allowFailure: true });
    if (result.code !== 0) throw new Error("Candidate does not descend from the public branch");
  }

  async function statePath() {
    return resolve(cwd, (await git(["rev-parse", "--git-path", "vera-candidate.json"])).stdout.trim());
  }

  async function writeState(value) {
    const path = await statePath();
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }

  async function readState() {
    const value = parseJson(await readFile(await statePath(), "utf8"), "Local candidate state");
    assertCommit(value.commit, "Candidate state commit");
    assertCommit(value.baseCommit, "Candidate state base");
    return value;
  }

  async function remoteStatus() {
    const result = await ssh(["sudo", "-n", remoteControl, "status"]);
    return normalizeStatus(parseJson(result.stdout, "Gateway candidate control"));
  }

  async function waitForTerminal(expectedCommit, { rollback = false, timeoutMs = 20 * 60 * 1000 } = {}) {
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      const status = await remoteStatus();
      if (TERMINAL_STATES.has(status.update.state)) {
        if (rollback) {
          if (status.update.state !== "rolled_back" || status.current.commit === expectedCommit) {
            throw new Error(`Gateway rollback ended as ${status.update.state}`);
          }
        } else if (status.update.state !== "succeeded" || status.current.commit !== expectedCommit) {
          throw new Error(`Gateway candidate ended as ${status.update.state}`);
        }
        return status;
      }
      await sleep(2000);
    }
    throw new Error("Gateway candidate operation timed out");
  }

  async function candidate() {
    const commit = await localHead();
    const baseCommit = await publicBase();
    await requireAncestor(baseCommit, commit);
    const ref = `refs/heads/candidates/${commit}`;
    await git(["push", candidateRemote, `${commit}:${ref}`]);
    const remote = (await git(["ls-remote", candidateRemote, ref])).stdout.trim().split(/\s+/u);
    if (remote[0] !== commit || remote[1] !== ref) throw new Error("Candidate upload verification failed");
    await writeState({ schemaVersion: 1, commit, baseCommit, createdAt: now().toISOString(), verifiedAt: null, promotedAt: null });
    await ssh(["sudo", "-n", remoteControl, "candidate", commit]);
    return waitForTerminal(commit);
  }

  async function verify() {
    const commit = await localHead();
    const state = await readState();
    if (state.commit !== commit) throw new Error("Local candidate state does not match HEAD");
    const status = await remoteStatus();
    if (status.current.commit !== commit || status.current.source !== "candidate") {
      throw new Error("Gateway is not running this candidate");
    }
    const service = await ssh(["sudo", "-n", "systemctl", "is-active", "vera-gateway.service"]);
    if (service.stdout.trim() !== "active") throw new Error("Gateway service is not active");
    const health = parseJson((await ssh(["curl", "-fsS", "--max-time", "5", "http://127.0.0.1:3210/api/health"])).stdout, "Gateway health");
    if (health?.app !== "vera" || health?.ok !== true) throw new Error("Gateway health check failed");
    await writeState({ ...state, verifiedAt: now().toISOString() });
    return status;
  }

  async function promote() {
    const commit = await localHead();
    const state = await readState();
    if (state.commit !== commit || !state.verifiedAt) throw new Error("Candidate has not been verified");
    const status = await remoteStatus();
    if (status.current.commit !== commit || status.current.source !== "candidate") {
      throw new Error("Gateway current release does not match the verified candidate");
    }
    const baseCommit = await publicBase();
    if (baseCommit !== state.baseCommit) throw new Error("Public branch changed after candidate creation");
    await requireAncestor(baseCommit, commit);
    await git(["push", publicRemote, `${commit}:refs/heads/${publicBranch}`]);
    const published = (await git(["ls-remote", publicRemote, `refs/heads/${publicBranch}`])).stdout.trim().split(/\s+/u)[0];
    if (published !== commit) throw new Error("Public promotion verification failed");
    await writeState({ ...state, promotedAt: now().toISOString() });
    return { commit };
  }

  async function rollback() {
    const local = await readState();
    if (local.promotedAt) throw new Error("A promoted candidate cannot be rolled back through the candidate channel");
    const status = await remoteStatus();
    const commit = assertCommit(status.current.commit, "Gateway current release");
    if (status.current.source !== "candidate") throw new Error("Gateway is not running a candidate release");
    await ssh(["sudo", "-n", remoteControl, "rollback", commit]);
    return waitForTerminal(commit, { rollback: true });
  }

  return { candidate, verify, promote, rollback, remoteStatus };
}

export async function main(argv = process.argv.slice(2)) {
  const action = argv[0];
  if (argv.length !== 1 || !["candidate", "verify", "promote", "rollback"].includes(action)) {
    throw new Error("Usage: release.mjs <candidate|verify|promote|rollback>");
  }
  const result = await createReleaseClient()[action]();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
