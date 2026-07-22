import test from "node:test";
import assert from "node:assert/strict";

import { defineSetupOperation, previewSetupOperation } from "../../src/core/setup-operation.js";
import { buildSetupPlan } from "../../src/core/setup-plan.js";
import {
  createSetupSession,
  recordSetupPlan,
  recordSetupPreflight,
  setupFingerprint,
} from "../../src/core/setup-state.js";

function fixture() {
  const input = {
    tailnet: "existing",
    ownerLogin: "owner@example.com",
    format: "json",
    targets: [{
      id: "target-1",
      role: "gateway",
      connection: { kind: "ssh", host: "vps", port: 22 },
      paths: { gatewayData: "/var/lib/vera/data" },
    }],
  };
  const snapshot = {
    targetId: "target-1",
    transport: "ssh",
    capturedAt: "2026-07-22T00:00:00.000Z",
    clockDeltaMs: 1000,
    facts: {
      os: "Linux",
      arch: "x86_64",
      nodeVersion: "v20.19.0",
      systemdState: "running",
      serviceScanAvailable: true,
      tailscale: { installed: true, active: true, serve: "absent" },
      listenerScanAvailable: true,
      services: [],
      listeners: ["0.0.0.0:22"],
      paths: [{
        name: "gatewayData", path: "/var/lib/vera/data", kind: "directory",
        writable: true, hasSymlink: false, availableKb: 9000000,
      }],
    },
  };
  return { input, snapshot };
}

test("setup state and plan stop at planned with a stable fact-bound id", () => {
  const { input, snapshot } = fixture();
  let session = createSetupSession(input);
  session = recordSetupPreflight(session, [snapshot]);
  const plan = buildSetupPlan(input, [snapshot], session.snapshotFingerprint);
  session = recordSetupPlan(session, plan);
  assert.equal(session.stage, "planned");
  assert.equal(plan.applied, false);
  assert.equal(plan.status, "remediation_required");
  assert.equal(plan.planId, buildSetupPlan(input, [snapshot], session.snapshotFingerprint).planId);
  assert.throws(() => recordSetupPreflight(session, [snapshot]), { code: "invalid_setup_transition" });
});

test("unknown port owners, proxy services, symlinks, and unsupported hosts block planning", () => {
  const { input, snapshot } = fixture();
  snapshot.facts.listeners.push("0.0.0.0:3210");
  snapshot.facts.services.push({ name: "nginx.service", state: "enabled" });
  snapshot.facts.paths[0].hasSymlink = true;
  snapshot.facts.os = "Darwin";
  const snapshotFingerprint = setupFingerprint({ input, snapshot });
  const plan = buildSetupPlan(input, [snapshot], snapshotFingerprint);
  assert.equal(plan.status, "blocked");
  assert.ok(plan.targets[0].checks.filter((item) => item.status === "blocked").length >= 4);
  assert.equal(plan.applied, false);
});

test("failed service or listener scans block instead of reporting an empty host", () => {
  const { input, snapshot } = fixture();
  snapshot.facts.serviceScanAvailable = false;
  snapshot.facts.listenerScanAvailable = false;
  snapshot.facts.tailscale.serve = "unavailable";
  const plan = buildSetupPlan(input, [snapshot], setupFingerprint({ input, snapshot }));
  assert.equal(plan.status, "blocked");
  assert.equal(plan.targets[0].checks.find((item) => item.id === "service-scan").status, "blocked");
  assert.equal(plan.targets[0].checks.find((item) => item.id === "listeners").status, "blocked");
  assert.notEqual(plan.targets[0].checks.find((item) => item.id === "tailscale-host").status, "ready");
});

test("setup operation interface previews detect and diff without exposing apply", async () => {
  const actual = { value: 1 };
  let applyCount = 0;
  const operation = defineSetupOperation({
    id: "fixture.apply",
    detect: async () => actual,
    diff: async (detected) => detected.value === 2 ? null : { value: 2 },
    apply: async (difference) => { applyCount += 1; actual = difference; return actual; },
    verify: async (detected) => detected.value === 2,
  });
  const preview = await previewSetupOperation(operation, {});
  assert.deepEqual(preview.difference, { value: 2 });
  assert.match(preview.detectionFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(applyCount, 0);
  assert.equal(operation.apply, undefined);
  assert.equal(operation.verify, undefined);
  assert.equal(operation.backup, undefined);
});

test("destructive setup operation definitions require a backup function", () => {
  assert.throws(() => defineSetupOperation({
    id: "fixture.destructive", destructive: true,
    detect() {}, diff() {}, apply() {}, verify() {},
  }), { code: "invalid_setup_operation" });
});
