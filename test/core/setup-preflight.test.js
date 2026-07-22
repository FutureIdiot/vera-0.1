import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPreflightInvocation,
  collectSetupPreflight,
  executePreflightInvocation,
  parsePreflightOutput,
} from "../../src/core/setup-preflight.js";

const validOutput = `schema\tvera-preflight-v1
os\tLinux
arch\tx86_64
epoch\t1750000000
node\tv20.19.0
systemd\trunning
serviceScan\tavailable
tailscaleInstalled\tyes
tailscaleActive\tyes
tailscaleServe\tabsent
listenerScan\tavailable
listener\t127.0.0.1:22
role\tgateway
path\tgatewayData|/var/lib/vera/data|missing|yes|no
disk\tgatewayData|9000000
path\tfiles|/var/lib/vera/files|directory|yes|no
disk\tfiles|8000000
path\tmemory|/var/lib/vera/memory|directory|yes|no
disk\tmemory|7000000
`;

const target = {
  id: "target-1",
  role: "gateway",
  connection: { kind: "ssh", host: "vera@example-vps", port: 22 },
  paths: {
    gatewayData: "/var/lib/vera/data",
    files: "/var/lib/vera/files",
    memory: "/var/lib/vera/memory",
  },
};

test("fixed preflight probe contains no deployment mutators", async () => {
  const script = await readFile(new URL("../../scripts/setup-preflight.sh", import.meta.url), "utf8");
  for (const pattern of [
    /\bsudo\b/u,
    /\b(?:rm|mv|cp|mkdir|touch|install|tee|chmod|chown|chgrp|ln|dd)\b/u,
    /\b(?:apt|apt-get|dnf|yum|pacman|apk|brew)\s+(?:install|remove|upgrade|update)/u,
    /sed\s+-i/u,
    /systemctl\s+(?:start|stop|restart|enable|disable|reload)/u,
    /tailscale\s+(?:up|down|funnel)(?:\s|$)/u,
    /tailscale\s+serve\s+(?!status)/u,
    /\b(?:ufw|iptables|nft)\b/u,
  ]) assert.doesNotMatch(script, pattern);
  const redirections = script.match(/[0-9]*>[^\s;)]+/gu) ?? [];
  assert.ok(redirections.every((value) => ["2>/dev/null", ">/dev/null", "2>&1"].includes(value)), redirections.join(", "));
  assert.match(script, /schema vera-preflight-v1/u);
});

test("SSH preflight uses fixed transport options, fixed stdin, and safe argv", () => {
  const invocation = buildPreflightInvocation(target, "FIXED_PROBE");
  assert.equal(invocation.command, "/usr/bin/ssh");
  assert.deepEqual(invocation.args.slice(0, 9), [
    "-T", "-p", "22", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "vera@example-vps",
  ]);
  assert.deepEqual(invocation.args.slice(9, 13), ["sh", "-s", "--", "gateway"]);
  assert.equal(invocation.stdin, "FIXED_PROBE");
});

test("preflight parser returns only typed allowlisted facts", () => {
  const facts = parsePreflightOutput(validOutput);
  assert.equal(facts.nodeVersion, "v20.19.0");
  assert.equal(facts.tailscale.active, true);
  assert.deepEqual(facts.paths[0], {
    name: "gatewayData",
    path: "/var/lib/vera/data",
    kind: "missing",
    writable: true,
    hasSymlink: false,
    availableKb: 9000000,
  });
});

test("preflight parser fails closed on duplicate, unknown, truncated, or injected output", () => {
  for (const output of [
    `${validOutput}schema\tvera-preflight-v1\n`,
    `${validOutput}secret\tvat_SUPER_SECRET\n`,
    validOutput.replace("role\tgateway\n", ""),
    validOutput.replace("os\tLinux", "os\tLinux\nvat_SUPER_SECRET"),
    validOutput.replace("disk\tfiles|8000000", "disk\tgatewayData|8000000"),
    validOutput.replace("node\tv20.19.0", "node\tv20.19.vat_SUPER_SECRET"),
    validOutput.replace("listener\t127.0.0.1:22", "listener\tvat_SUPER_SECRET:3210"),
  ]) assert.throws(() => parsePreflightOutput(output), { code: "preflight_invalid_output" });
});

test("preflight collection binds facts to the exact requested role and paths", async () => {
  const snapshot = await collectSetupPreflight(target, {
    loadProbe: async () => "FIXED",
    execute: async (invocation) => {
      assert.equal(invocation.stdin, "FIXED");
      return { stdout: validOutput };
    },
    now: () => 1750000000000,
  });
  assert.equal(snapshot.targetId, "target-1");
  assert.equal(snapshot.clockDeltaMs, 0);

  await assert.rejects(
    collectSetupPreflight(target, {
      loadProbe: async () => "FIXED",
      execute: async () => ({ stdout: validOutput.replace("/var/lib/vera/data", "/var/lib/vera/other") }),
    }),
    { code: "preflight_invalid_output" },
  );
});

async function snapshotTree(root) {
  async function walk(path, relative = "") {
    const info = await stat(path);
    const item = { relative, mode: info.mode, size: info.size, mtimeMs: info.mtimeMs };
    if (!info.isDirectory()) return [item];
    const children = (await readdir(path)).sort();
    const nested = await Promise.all(children.map((name) => walk(join(path, name), join(relative, name))));
    return [item, ...nested.flat()];
  }
  return walk(root);
}

test("fixed probe leaves a real fixture tree unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "vera-setup-probe-"));
  try {
    const workspace = join(root, "workspace");
    const memory = join(root, "memory");
    await mkdir(workspace);
    await mkdir(memory);
    await writeFile(join(workspace, "sentinel.txt"), "unchanged", "utf8");
    const before = await snapshotTree(root);
    const script = await readFile(new URL("../../scripts/setup-preflight.sh", import.meta.url), "utf8");
    const invocation = buildPreflightInvocation({
      id: "fixture", role: "daemon", connection: { kind: "local" }, paths: { workspace, memory },
    }, script);
    const { stdout } = await executePreflightInvocation(invocation);
    const facts = parsePreflightOutput(stdout);
    assert.equal(facts.paths.length, 2);
    assert.deepEqual(await snapshotTree(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
