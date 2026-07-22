import test from "node:test";
import assert from "node:assert/strict";

import { runSetup } from "../../src/core/setup-cli.js";
import { parsePreflightOutput } from "../../src/core/setup-preflight.js";

function memoryStream() {
  let value = "";
  return { write(chunk) { value += chunk; }, read() { return value; } };
}

const args = [
  "--target", "ssh", "--ssh-host", "vps", "--role", "gateway",
  "--tailnet", "existing", "--owner-login", "owner@example.com",
  "--gateway-data-path", "/var/lib/vera/data",
  "--files-path", "/var/lib/vera/files",
  "--memory-path", "/var/lib/vera/memory", "--json",
];

function snapshotFor(target) {
  return {
    targetId: target.id,
    transport: "ssh",
    capturedAt: "2026-07-22T00:00:00.000Z",
    clockDeltaMs: 0,
    facts: {
      os: "Linux", arch: "x86_64", nodeVersion: "v20.19.0", systemdState: "running",
      serviceScanAvailable: true,
      tailscale: { installed: true, active: true, serve: "absent" },
      listenerScanAvailable: true, services: [], listeners: [],
      paths: Object.entries(target.paths).map(([name, path]) => ({
        name, path, kind: "directory", writable: true, hasSymlink: false, availableKb: 9000000,
      })),
    },
  };
}

test("non-TTY style missing input exits before any probe", async () => {
  const stdout = memoryStream();
  const stderr = memoryStream();
  let probes = 0;
  const code = await runSetup({ argv: [], stdout, stderr, collectPreflight: async () => { probes += 1; } });
  assert.equal(code, 64);
  assert.equal(probes, 0);
  assert.match(stderr.read(), /Usage:/u);
});

test("setup JSON output cannot advance beyond planned or claim application", async () => {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const code = await runSetup({
    argv: args,
    stdout,
    stderr,
    collectPreflight: async (target) => snapshotFor(target),
  });
  assert.equal(code, 0);
  const output = JSON.parse(stdout.read());
  assert.equal(output.stage, "planned");
  assert.equal(output.applied, false);
  assert.notEqual(output.stage, "completed");
  assert.equal(stderr.read(), "");
});

test("preflight failures never echo raw secret-bearing errors", async () => {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const secret = "vat_SUPER_SECRET";
  const code = await runSetup({
    argv: args,
    stdout,
    stderr,
    collectPreflight: async () => { throw Object.assign(new Error(secret), { code: "preflight_failed" }); },
  });
  assert.equal(code, 1);
  assert.equal(stdout.read(), "");
  assert.doesNotMatch(stderr.read(), new RegExp(secret, "u"));
  const failure = JSON.parse(stderr.read());
  assert.equal(failure.applied, false);
  assert.equal(failure.status, "blocked");
});

test("malicious typed probe values are rejected without reaching JSON output", async () => {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const secret = "vat_SUPER_SECRET";
  const malicious = `schema\tvera-preflight-v1\nos\tLinux\narch\tx86_64\nepoch\t1750000000\nnode\tv20.19.${secret}\nsystemd\trunning\nserviceScan\tavailable\ntailscaleInstalled\tyes\ntailscaleActive\tyes\ntailscaleServe\tabsent\nlistenerScan\tavailable\nrole\tgateway\n`;
  const code = await runSetup({
    argv: args,
    stdout,
    stderr,
    collectPreflight: async () => parsePreflightOutput(malicious),
  });
  assert.equal(code, 1);
  assert.equal(stdout.read(), "");
  assert.doesNotMatch(stderr.read(), new RegExp(secret, "u"));
});
