import test from "node:test";
import assert from "node:assert/strict";

import { normalizeSetupInput, parseSetupArgs } from "../../src/core/setup-input.js";

function gatewayArgs(overrides = []) {
  return [
    "--target", "ssh",
    "--ssh-host", "vera@example-vps",
    "--role", "gateway",
    "--tailnet", "existing",
    "--owner-login", "owner@example.com",
    "--gateway-data-path", "/var/lib/vera/data",
    "--files-path", "/var/lib/vera/files",
    "--memory-path", "/var/lib/vera/memory",
    ...overrides,
  ];
}

test("setup input normalizes one target into a future multi-target shape", () => {
  const input = normalizeSetupInput(parseSetupArgs(gatewayArgs()).values);
  assert.equal(input.tailnet, "existing");
  assert.equal(input.ownerLogin, "owner@example.com");
  assert.deepEqual(input.targets, [{
    id: "target-1",
    role: "gateway",
    connection: { kind: "ssh", host: "vera@example-vps", port: 22 },
    paths: {
      gatewayData: "/var/lib/vera/data",
      files: "/var/lib/vera/files",
      memory: "/var/lib/vera/memory",
    },
  }]);
});

test("setup input rejects SSH option and path injection", () => {
  for (const host of ["-oProxyCommand=bad", "host;touch /tmp/x", "host $(id)", "host\nother"]) {
    const args = gatewayArgs();
    args[args.indexOf("--ssh-host") + 1] = host;
    assert.throws(() => normalizeSetupInput(parseSetupArgs(args).values), /ssh-host/u, host);
  }
  for (const value of ["/var/lib/vera/data;id", "/var/lib/vera/data path", "/var/lib/vera/$(id)", "/etc/vera", "/var/lib/vera/../data"]) {
    const args = gatewayArgs();
    args[args.indexOf("--gateway-data-path") + 1] = value;
    assert.throws(() => normalizeSetupInput(parseSetupArgs(args).values), /gateway-data-path/u, value);
  }
  for (const value of ["/", "/root", "/home", "/home/alice", "/Users/alice", "/var/lib"]) {
    const args = gatewayArgs();
    args[args.indexOf("--gateway-data-path") + 1] = value;
    assert.throws(() => normalizeSetupInput(parseSetupArgs(args).values), /gateway-data-path/u, value);
  }
});

test("setup input enforces role-specific, non-overlapping paths", () => {
  const overlapping = gatewayArgs();
  overlapping[overlapping.indexOf("--gateway-data-path") + 1] = "/var/lib/vera";
  assert.throws(() => normalizeSetupInput(parseSetupArgs(overlapping).values), /must not overlap/u);

  assert.throws(
    () => normalizeSetupInput(parseSetupArgs([
      "--target", "local", "--role", "client", "--tailnet", "existing",
      "--owner-login", "owner@example.com", "--memory-path", "/var/lib/vera/memory",
    ]).values),
    /not valid for client/u,
  );

  const localRepo = [
    "--target", "local", "--role", "gateway", "--tailnet", "existing",
    "--owner-login", "owner@example.com", "--gateway-data-path", "/workspace/vera/data",
    "--files-path", "/safe/vera/files", "--memory-path", "/safe/vera/memory",
  ];
  assert.throws(
    () => normalizeSetupInput(parseSetupArgs(localRepo).values, { repoRoot: "/workspace/vera" }),
    /source repository/u,
  );
});

test("setup argument errors do not echo unrecognized canary values", () => {
  assert.throws(
    () => parseSetupArgs(["vat_SUPER_SECRET"]),
    (error) => error.code === "invalid_setup_input" && !error.message.includes("vat_SUPER_SECRET"),
  );
  for (const ownerLogin of ["vat_SUPER_SECRET", "session-token@example.com", "not-a-login"]) {
    const args = gatewayArgs();
    args[args.indexOf("--owner-login") + 1] = ownerLogin;
    assert.throws(() => normalizeSetupInput(parseSetupArgs(args).values), /owner-login/u);
  }
});
