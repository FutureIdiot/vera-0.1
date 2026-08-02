import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCandidateControl, main } from "../../scripts/gateway-candidate-control.js";

const CURRENT = "1".repeat(40);
const TARGET = "2".repeat(40);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vera-candidate-control-"));
  const updateRoot = join(root, "update");
  const releaseRoot = join(root, "release");
  const dataPath = join(root, "data");
  const candidateRepository = join(root, "candidates.git");
  await mkdir(join(updateRoot, "requests"), { recursive: true });
  await mkdir(join(updateRoot, "status"), { recursive: true });
  await mkdir(dataPath);
  const releasePath = join(releaseRoot, "releases", CURRENT);
  await mkdir(releasePath, { recursive: true });
  await writeFile(join(releasePath, ".vera-release.json"), JSON.stringify({ schemaVersion: 1, commit: CURRENT, source: "public", version: "0.0.1" }));
  await symlink(releasePath, join(releaseRoot, "current"));
  return {
    root,
    updateRoot,
    env: {
      VERA_UPDATE_ROOT: updateRoot,
      VERA_RELEASE_ROOT: releaseRoot,
      VERA_UPDATE_DATA_PATH: dataPath,
      VERA_UPDATE_CANDIDATE_REPOSITORY: candidateRepository,
      VERA_UPDATE_REPOSITORY: "https://github.com/FutureIdiot/vera-0.1.git",
      VERA_UPDATE_BRANCH: "master",
      VERA_UPDATE_SERVICE: "vera-gateway.service",
      VERA_UPDATE_HEALTH_URL: "http://127.0.0.1:3210/api/health",
    },
  };
}

test("candidate CLI writes strict requests atomically and never accepts source paths", async () => {
  const value = await fixture();
  const control = await createCandidateControl({ env: value.env });
  const queued = await control.candidate(TARGET);
  const request = JSON.parse(await readFile(join(value.updateRoot, "requests", "request.json"), "utf8"));
  assert.deepEqual(Object.keys(request).sort(), ["action", "requestId", "requestedAt", "schemaVersion", "targetCommit"]);
  assert.equal(request.action, "candidate");
  assert.equal(request.targetCommit, TARGET);
  assert.match(queued.requestId, /^upd_[0-9a-f]{32}$/u);
  await assert.rejects(() => control.candidate("master"), /full commit/u);
  await assert.rejects(() => control.rollback(TARGET), /already active or pending/u);
  await assert.rejects(() => main(["candidate", "master"], { env: value.env }), /full commit/u);
  assert.equal(JSON.stringify(request).includes("candidateRepository"), false);
});

test("candidate CLI rejects active updater state and projects only safe status fields", async () => {
  const value = await fixture();
  await writeFile(join(value.updateRoot, "status", "status.json"), JSON.stringify({
    schemaVersion: 1,
    state: "updating",
    requestId: `upd_${"a".repeat(32)}`,
    target: { commit: TARGET, version: "0.1.0", path: "/secret/release" },
    log: "/secret/log",
  }), { mode: 0o640 });
  const control = await createCandidateControl({ env: value.env });
  await assert.rejects(() => control.candidate(TARGET), /already active or pending/u);
  const status = await control.status();
  assert.deepEqual(status, {
    schemaVersion: 1,
    current: { commit: CURRENT, source: "public", version: "0.0.1" },
    update: { state: "updating", target: { commit: TARGET, version: "0.1.0" } },
  });
  assert.equal(JSON.stringify(status).includes(value.root), false);
  assert.equal(JSON.stringify(status).includes("/secret"), false);
});

test("candidate CLI rollback request is strict and status does not expose rollback metadata", async () => {
  const value = await fixture();
  const control = await createCandidateControl({ env: value.env });
  const queued = await control.rollback(CURRENT);
  const request = JSON.parse(await readFile(join(value.updateRoot, "requests", "request.json"), "utf8"));
  assert.equal(request.action, "rollback");
  assert.equal(request.ifCurrentCommit, CURRENT);
  assert.equal(queued.action, "rollback");
  assert.equal(JSON.stringify(await control.status()).includes("backup"), false);
});

test("candidate CLI rejects a current symlink into a staging directory", async () => {
  const value = await fixture();
  const staging = join(value.env.VERA_RELEASE_ROOT, "releases", `.staging-${CURRENT}-1`);
  await mkdir(staging);
  await writeFile(join(staging, ".vera-release.json"), JSON.stringify({ schemaVersion: 1, commit: CURRENT, source: "candidate" }));
  const current = join(value.env.VERA_RELEASE_ROOT, "current");
  await unlink(current);
  await symlink(staging, current);
  const control = await createCandidateControl({ env: value.env });
  await assert.rejects(() => control.status(), /current release is invalid/u);
});
