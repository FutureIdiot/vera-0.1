import { readFile } from "node:fs/promises";

import { spawnProcess } from "./spawn.js";

const PROBE_URL = new URL("../../scripts/setup-preflight.sh", import.meta.url);
const SINGLE_KEYS = new Set([
  "schema",
  "os",
  "arch",
  "epoch",
  "node",
  "systemd",
  "serviceScan",
  "tailscaleInstalled",
  "tailscaleActive",
  "tailscaleServe",
  "listenerScan",
  "role",
]);
const REPEATED_KEYS = new Set(["service", "listener", "path", "disk"]);
const SAFE_ATOM = /^[A-Za-z0-9._+:/@%\[\]*-]+$/u;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function preflightError(message, code = "preflight_failed") {
  return Object.assign(new Error(message), { code });
}

function minimalProcessEnv(env) {
  const result = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin",
    LANG: "C",
    LC_ALL: "C",
  };
  for (const name of ["HOME", "SSH_AUTH_SOCK"]) {
    if (typeof env[name] === "string" && env[name]) result[name] = env[name];
  }
  return result;
}

export function buildPreflightInvocation(target, probeScript) {
  const pathArgs = Object.entries(target.paths).flatMap(([name, value]) => [name, value]);
  const remoteArgs = ["sh", "-s", "--", target.role, ...pathArgs];
  if (target.connection.kind === "local") {
    return {
      command: "/bin/sh",
      args: ["-s", "--", target.role, ...pathArgs],
      stdin: probeScript,
    };
  }
  return {
    command: "/usr/bin/ssh",
    args: [
      "-T",
      "-p",
      String(target.connection.port),
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "--",
      target.connection.host,
      ...remoteArgs,
    ],
    stdin: probeScript,
  };
}

export function executePreflightInvocation(invocation, {
  env = process.env,
  spawnImpl = spawnProcess,
  timeoutMs = 20_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(invocation.command, invocation.args, {
      env: minimalProcessEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderrBytes = 0;
    let settled = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      finish(() => reject(preflightError("preflight probe timed out", "preflight_timeout")));
    }, timeoutMs);

    child.once("error", () => finish(() => reject(preflightError("preflight transport could not start"))));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        try { child.kill("SIGTERM"); } catch { /* already exited */ }
        finish(() => reject(preflightError("preflight output exceeded the safety limit", "preflight_invalid_output")));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        try { child.kill("SIGTERM"); } catch { /* already exited */ }
        finish(() => reject(preflightError("preflight error output exceeded the safety limit", "preflight_invalid_output")));
      }
    });
    child.once("close", (code) => finish(() => {
      if (code !== 0) reject(preflightError("preflight target is unreachable or rejected the fixed probe"));
      else resolve({ stdout });
    }));
    child.stdin.once("error", () => {});
    child.stdin.end(invocation.stdin);
  });
}

function splitRecord(value, expectedParts, key) {
  const parts = value.split("|");
  if (parts.length !== expectedParts) throw preflightError(`invalid ${key} record`, "preflight_invalid_output");
  return parts;
}

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function validIpv4(value) {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^[0-9]{1,3}$/u.test(part) && Number(part) <= 255);
}

function normalizeListener(value) {
  if (value.length > 128) throw preflightError("invalid listener record", "preflight_invalid_output");
  let match = /^\*[:.]([0-9]+)$/u.exec(value);
  if (match) {
    const port = validPort(match[1]);
    if (port) return `*:${port}`;
  }
  match = /^((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?:%[A-Za-z0-9_.-]{1,32})?:([0-9]+)$/u.exec(value);
  if (match && validIpv4(match[1])) {
    const port = validPort(match[2]);
    if (port) return `${match[1]}:${port}`;
  }
  match = /^((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?:%[A-Za-z0-9_.-]{1,32})?\.([0-9]+)$/u.exec(value);
  if (match && validIpv4(match[1])) {
    const port = validPort(match[2]);
    if (port) return `${match[1]}:${port}`;
  }
  match = /^\[([0-9A-Fa-f:]+)(?:%[A-Za-z0-9_.-]{1,32})?\]:([0-9]+)$/u.exec(value);
  if (match && match[1].includes(":")) {
    const port = validPort(match[2]);
    if (port) return `[${match[1]}]:${port}`;
  }
  match = /^([0-9A-Fa-f:]+)[:.]([0-9]+)$/u.exec(value);
  if (match && match[1].includes(":")) {
    const port = validPort(match[2]);
    if (port) return `[${match[1]}]:${port}`;
  }
  throw preflightError("invalid listener record", "preflight_invalid_output");
}

export function parsePreflightOutput(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
    throw preflightError("invalid preflight output", "preflight_invalid_output");
  }
  const singles = {};
  const repeated = { service: [], listener: [], path: [], disk: [] };
  const lines = stdout.split("\n").filter(Boolean);
  if (lines.length > 4096) throw preflightError("too many preflight records", "preflight_invalid_output");

  for (const line of lines) {
    const tab = line.indexOf("\t");
    if (tab < 1) throw preflightError("malformed preflight record", "preflight_invalid_output");
    const key = line.slice(0, tab);
    const value = line.slice(tab + 1);
    if (value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw preflightError("unsafe preflight record", "preflight_invalid_output");
    }
    if (SINGLE_KEYS.has(key)) {
      if (Object.hasOwn(singles, key)) throw preflightError(`duplicate ${key} record`, "preflight_invalid_output");
      singles[key] = value;
    } else if (REPEATED_KEYS.has(key)) {
      const limits = { service: 64, listener: 2048, path: 16, disk: 16 };
      if (repeated[key].length >= limits[key]) throw preflightError(`too many ${key} records`, "preflight_invalid_output");
      repeated[key].push(value);
    } else {
      throw preflightError("unknown preflight record", "preflight_invalid_output");
    }
  }

  for (const key of ["schema", "os", "arch", "epoch", "node", "systemd", "serviceScan", "tailscaleInstalled", "tailscaleActive", "tailscaleServe", "listenerScan", "role"]) {
    if (!Object.hasOwn(singles, key)) throw preflightError(`missing ${key} record`, "preflight_invalid_output");
  }
  if (singles.schema !== "vera-preflight-v1") throw preflightError("unsupported preflight schema", "preflight_invalid_output");
  if (!["Linux", "Darwin", "unsupported"].includes(singles.os)) throw preflightError("invalid os value", "preflight_invalid_output");
  if (!["x86_64", "arm64", "unsupported"].includes(singles.arch)) throw preflightError("invalid arch value", "preflight_invalid_output");
  if (singles.node !== "missing" && !/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(singles.node)) {
    throw preflightError("invalid node value", "preflight_invalid_output");
  }
  if (!/^(?:gateway|daemon|client)$/u.test(singles.role)) throw preflightError("invalid role value", "preflight_invalid_output");
  if (!/^[0-9]+$/u.test(singles.epoch)) throw preflightError("invalid target clock", "preflight_invalid_output");
  if (!["running", "degraded", "unavailable"].includes(singles.systemd)) throw preflightError("invalid systemd value", "preflight_invalid_output");
  if (!["available", "unavailable"].includes(singles.serviceScan)) throw preflightError("invalid service scan value", "preflight_invalid_output");
  if (!["yes", "no"].includes(singles.tailscaleInstalled) || !["yes", "no"].includes(singles.tailscaleActive)) {
    throw preflightError("invalid Tailscale state", "preflight_invalid_output");
  }
  if (!["configured", "absent", "unavailable"].includes(singles.tailscaleServe)) {
    throw preflightError("invalid Tailscale Serve state", "preflight_invalid_output");
  }
  if (!["available", "unavailable"].includes(singles.listenerScan)) {
    throw preflightError("invalid listener scan state", "preflight_invalid_output");
  }

  const paths = repeated.path.map((value) => {
    const [name, targetPath, kind, writable, symlink] = splitRecord(value, 5, "path");
    if (!SAFE_ATOM.test(name) || !["directory", "other", "missing"].includes(kind)
      || !["yes", "no"].includes(writable) || !["yes", "no"].includes(symlink)) {
      throw preflightError("invalid path record", "preflight_invalid_output");
    }
    return { name, path: targetPath, kind, writable: writable === "yes", hasSymlink: symlink === "yes" };
  });
  if (new Set(paths.map((item) => item.name)).size !== paths.length) {
    throw preflightError("duplicate path record", "preflight_invalid_output");
  }
  const diskEntries = repeated.disk.map((value) => {
    const [name, availableKb] = splitRecord(value, 2, "disk");
    if (!SAFE_ATOM.test(name) || (availableKb !== "unknown" && !/^[0-9]+$/u.test(availableKb))) {
      throw preflightError("invalid disk record", "preflight_invalid_output");
    }
    return [name, availableKb === "unknown" ? null : Number(availableKb)];
  });
  if (new Set(diskEntries.map(([name]) => name)).size !== diskEntries.length) {
    throw preflightError("duplicate disk record", "preflight_invalid_output");
  }
  const disks = Object.fromEntries(diskEntries);
  if (paths.some((item) => !Object.hasOwn(disks, item.name)) || diskEntries.some(([name]) => !paths.some((item) => item.name === name))) {
    throw preflightError("path and disk records do not match", "preflight_invalid_output");
  }
  const services = repeated.service.map((value) => {
    const [name, state] = splitRecord(value, 2, "service");
    if (!/^(?:vera|cloudflared|nginx|caddy)[A-Za-z0-9_.@-]*\.service$/u.test(name) || !SAFE_ATOM.test(state)) {
      throw preflightError("invalid service record", "preflight_invalid_output");
    }
    return { name, state };
  });
  const listeners = repeated.listener.map((value) => normalizeListener(value));

  return {
    schema: singles.schema,
    os: singles.os,
    arch: singles.arch,
    epoch: Number(singles.epoch),
    nodeVersion: singles.node === "missing" ? null : singles.node,
    systemdState: singles.systemd,
    serviceScanAvailable: singles.serviceScan === "available",
    tailscale: {
      installed: singles.tailscaleInstalled === "yes",
      active: singles.tailscaleActive === "yes",
      serve: singles.tailscaleServe,
    },
    listenerScanAvailable: singles.listenerScan === "available",
    role: singles.role,
    services,
    listeners,
    paths: paths.map((item) => ({ ...item, availableKb: disks[item.name] ?? null })),
  };
}

export async function collectSetupPreflight(target, {
  loadProbe = () => readFile(PROBE_URL, "utf8"),
  execute = executePreflightInvocation,
  now = () => Date.now(),
} = {}) {
  const probeScript = await loadProbe();
  const invocation = buildPreflightInvocation(target, probeScript);
  const { stdout } = await execute(invocation);
  const facts = parsePreflightOutput(stdout);
  if (facts.role !== target.role) throw preflightError("preflight role mismatch", "preflight_invalid_output");
  const expectedPaths = Object.entries(target.paths);
  if (facts.paths.length !== expectedPaths.length || expectedPaths.some(([name, value]) => {
    const fact = facts.paths.find((item) => item.name === name);
    return !fact || fact.path !== value;
  })) {
    throw preflightError("preflight path mismatch", "preflight_invalid_output");
  }
  return Object.freeze({
    targetId: target.id,
    transport: target.connection.kind,
    capturedAt: new Date(now()).toISOString(),
    clockDeltaMs: Math.abs(now() - facts.epoch * 1000),
    facts,
  });
}
