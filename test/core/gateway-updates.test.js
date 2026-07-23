import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { createGatewayUpdateControl } from "../../src/core/gateway-updates.js";

const CURRENT = "1".repeat(40);
const TARGET = "2".repeat(40);
const CHECK_ID = `upd_${"a".repeat(32)}`;

async function fixture({ configured = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vera-updates-"));
  const controlPath = join(root, "control");
  const releaseMetadataPath = join(root, "release.json");
  await mkdir(join(controlPath, "requests"), { recursive: true });
  await mkdir(join(controlPath, "status"), { recursive: true });
  await writeFile(releaseMetadataPath, JSON.stringify({ schemaVersion: 1, commit: CURRENT, version: "0.0.1", deployedAt: "2026-07-23T00:00:00.000Z" }));
  let uuid = 0;
  const control = createGatewayUpdateControl({
    config: { controlPath: configured ? controlPath : null, releaseMetadataPath },
    now: () => new Date("2026-07-23T01:02:03.000Z"),
    randomUUIDFn: () => `${String(++uuid).padStart(8, "0")}-0000-0000-0000-000000000000`,
  });
  return { root, controlPath, releaseMetadataPath, control };
}

test("disabled update control exposes current release without creating work", async () => {
  const { control } = await fixture({ configured: false });
  const status = await control.getStatus();
  assert.equal(status.supported, false);
  assert.equal(status.state, "disabled");
  assert.equal(status.current.commit, CURRENT);
  await assert.rejects(() => control.queueCheck(), { code: "update_unavailable" });
});

test("check request is strict, atomic, and immediately projected as active", async () => {
  const { control, controlPath } = await fixture();
  const queued = await control.queueCheck();
  assert.equal(queued.state, "checking");
  assert.match(queued.requestId, /^upd_[0-9a-f]{32}$/u);
  const request = JSON.parse(await readFile(join(controlPath, "requests", "request.json"), "utf8"));
  assert.deepEqual(request, {
    schemaVersion: 1,
    requestId: queued.requestId,
    action: "check",
    requestedAt: "2026-07-23T01:02:03.000Z",
  });
  assert.equal((await control.getStatus()).state, "checking");
  await assert.rejects(() => control.queueCheck(), { code: "update_busy" });
});

test("apply requires the exact available check and writes no remote-controlled fields", async () => {
  const { control, controlPath } = await fixture();
  await writeFile(join(controlPath, "status", "status.json"), JSON.stringify({
    schemaVersion: 1,
    state: "available",
    requestId: CHECK_ID,
    target: { commit: TARGET, version: "0.0.2", ignored: "not-projected" },
    checkedAt: "2026-07-23T01:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    error: null,
    command: "must-not-project",
  }));
  await assert.rejects(
    () => control.queueApply({ targetCommit: TARGET, ifRequestId: `upd_${"b".repeat(32)}` }),
    { code: "update_conflict" },
  );
  const queued = await control.queueApply({ targetCommit: TARGET, ifRequestId: CHECK_ID });
  assert.equal(queued.state, "queued");
  assert.equal(queued.target.commit, TARGET);
  const request = JSON.parse(await readFile(join(controlPath, "requests", "request.json"), "utf8"));
  assert.deepEqual(Object.keys(request).sort(), ["action", "checkedRequestId", "requestId", "requestedAt", "schemaVersion", "targetCommit"]);
  assert.equal(JSON.stringify(queued).includes("must-not-project"), false);
});

test("unsafe control files and symlink request directories fail closed", async () => {
  const one = await fixture();
  await writeFile(join(one.controlPath, "status", "status.json"), JSON.stringify({ schemaVersion: 1, state: "available", requestId: "bad" }));
  await assert.rejects(() => one.control.getStatus(), { code: "update_unavailable" });

  const two = await fixture();
  const alternate = join(two.root, "alternate");
  await mkdir(alternate);
  const unsafeRoot = join(two.root, "unsafe-control");
  await mkdir(join(unsafeRoot, "status"), { recursive: true });
  await symlink(alternate, join(unsafeRoot, "requests"));
  const unsafe = createGatewayUpdateControl({ config: { controlPath: unsafeRoot, releaseMetadataPath: two.releaseMetadataPath } });
  await assert.rejects(() => unsafe.queueCheck(), { code: "update_unavailable" });
});
