import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createReleaseClient } from "../../scripts/release.mjs";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);

async function fixture({ dirty = false, drift = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "vera-release-client-"));
  await mkdir(join(cwd, ".git"));
  const calls = [];
  let rolledBack = false;
  let publicDrift = drift;
  const exec = async (command, args, options = {}) => {
    calls.push([command, args, options]);
    if (command === "git") {
      if (args[0] === "status") return { code: 0, stdout: dirty ? " M src/server.js\n" : "", stderr: "" };
      if (args[0] === "symbolic-ref") return { code: 0, stdout: "master\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "HEAD^{commit}") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
      if (args[0] === "rev-parse" && args[1]?.startsWith("refs/remotes/")) {
        return { code: 0, stdout: `${publicDrift ? "3".repeat(40) : BASE}\n`, stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--git-path") return { code: 0, stdout: ".git/vera-candidate.json\n", stderr: "" };
      if (args[0] === "merge-base") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "fetch" || args[0] === "push") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "ls-remote") {
        const ref = args.at(-1);
        return { code: 0, stdout: `${HEAD}\t${ref}\n`, stderr: "" };
      }
    }
    if (command === "ssh") {
      const action = args.at(-1);
      if (args.includes("candidate")) return { code: 0, stdout: "{}\n", stderr: "" };
      if (args.includes("rollback")) {
        rolledBack = true;
        return { code: 0, stdout: "{}\n", stderr: "" };
      }
      if (action === "status") {
        return {
          code: 0,
          stdout: `${JSON.stringify({
            current: { commit: rolledBack ? BASE : HEAD, version: "0.1.0", deployedAt: "2026-08-02T00:00:00.000Z", source: rolledBack ? "public" : "candidate" },
            update: { state: rolledBack ? "rolled_back" : "succeeded", target: { commit: HEAD, version: "0.1.0" } },
          })}\n`,
          stderr: "",
        };
      }
      if (args.includes("systemctl")) return { code: 0, stdout: "active\n", stderr: "" };
      if (args.includes("curl")) return { code: 0, stdout: "{\"app\":\"vera\",\"ok\":true}\n", stderr: "" };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  return {
    cwd,
    calls,
    setDrift(value) { publicDrift = value; },
    client: createReleaseClient({ cwd, exec, now: () => new Date("2026-08-02T01:02:03.000Z"), sleep: async () => {} }),
  };
}

test("candidate, verify, and promote preserve one exact commit", async () => {
  const { client, calls } = await fixture();
  await client.candidate();
  await client.verify();
  await client.promote();

  assert.equal(calls.some(([command, args]) => command === "git" && args.includes(`refs/heads/candidates/${HEAD}`)), true);
  assert.equal(calls.some(([command, args]) => command === "ssh" && args.slice(-2).join(" ") === `candidate ${HEAD}`), true);
  assert.equal(calls.some(([command, args]) => command === "git" && args.includes(`${HEAD}:refs/heads/master`)), true);
  assert.equal(calls.some(([command, args]) => command === "git" && args.includes("--force")), false);
});

test("candidate refuses a dirty worktree before upload", async () => {
  const { client, calls } = await fixture({ dirty: true });
  await assert.rejects(() => client.candidate(), /Working tree must be clean/u);
  assert.equal(calls.some(([command, args]) => command === "git" && args[0] === "push"), false);
});

test("promote refuses public branch drift", async () => {
  const stable = await fixture();
  await stable.client.candidate();
  await stable.client.verify();
  stable.setDrift(true);
  await assert.rejects(() => stable.client.promote(), /Public branch changed/u);
});

test("rollback delegates to the root updater transaction", async () => {
  const { client, calls } = await fixture();
  await client.candidate();
  const result = await client.rollback();
  assert.equal(result.current.commit, BASE);
  assert.equal(calls.some(([command, args]) => command === "ssh" && args.includes("rollback") && args.includes(HEAD)), true);
  assert.equal(calls.some(([command, args]) => command === "ssh" && args.includes("ln")), false);
});

test("rollback refuses a candidate after public promotion", async () => {
  const { client } = await fixture();
  await client.candidate();
  await client.verify();
  await client.promote();
  await assert.rejects(() => client.rollback(), /promoted candidate/u);
});

test("release client rejects unsafe SSH host configuration", () => {
  assert.throws(
    () => createReleaseClient({ env: { VERA_DEPLOY_SSH_HOST: "gateway;touch /tmp/pwn" } }),
    /configuration is invalid/u,
  );
});
