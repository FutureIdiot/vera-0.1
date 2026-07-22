import { posix as path } from "node:path";

const ROLES = new Set(["gateway", "daemon", "client"]);
const TARGETS = new Set(["local", "ssh"]);
const TAILNET_PATHS = new Set(["existing", "new"]);
const VALUE_FLAGS = new Set([
  "target",
  "role",
  "tailnet",
  "owner-login",
  "ssh-host",
  "ssh-port",
  "gateway-data-path",
  "files-path",
  "memory-path",
  "workspace-path",
  "format",
]);

const REMOTE_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/u;
const SSH_HOST_PATTERN = /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\])$/u;
const PATH_FLAG_NAMES = { gatewayData: "gateway-data-path", files: "files-path", memory: "memory-path", workspace: "workspace-path" };
const FORBIDDEN_PATH_TREES = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/private/tmp", "/private/var/tmp", "/proc", "/run", "/sbin", "/sys", "/tmp", "/usr"];
const FORBIDDEN_EXACT_PATHS = ["/", "/Users", "/home", "/opt", "/private", "/root", "/srv", "/var", "/var/lib"];

function fail(message) {
  throw Object.assign(new Error(message), { code: "invalid_setup_input" });
}

function required(values, name) {
  const value = values[name];
  if (typeof value !== "string" || !value.trim()) fail(`--${name} is required`);
  return value.trim();
}

function deploymentPath(value, name, target) {
  if (!path.isAbsolute(value) || /[\u0000-\u001f\u007f|]/u.test(value)) {
    fail(`--${name} must be an absolute path without control characters`);
  }
  if (target === "ssh" && !REMOTE_PATH_PATTERN.test(value)) {
    fail(`--${name} must use only letters, numbers, dot, underscore, slash, or dash for SSH targets`);
  }
  const normalized = path.normalize(value);
  if (normalized !== value || FORBIDDEN_EXACT_PATHS.includes(normalized)
    || FORBIDDEN_PATH_TREES.some((root) => normalized === root || normalized.startsWith(`${root}/`))) {
    fail(`--${name} must be a dedicated data path outside system roots and without dot segments`);
  }
  return normalized;
}

function assertDistinctPaths(paths) {
  const entries = Object.entries(paths);
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const [leftName, leftPath] = entries[left];
      const [rightName, rightPath] = entries[right];
      if (leftPath === rightPath || leftPath.startsWith(`${rightPath}/`) || rightPath.startsWith(`${leftPath}/`)) {
        fail(`${leftName} and ${rightName} paths must not overlap`);
      }
    }
  }
}

export function parseSetupArgs(argv) {
  const values = {};
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--json") {
      values.format = "json";
      continue;
    }
    if (!token.startsWith("--")) fail("unexpected positional argument");
    const name = token.slice(2);
    if (!VALUE_FLAGS.has(name)) fail("unknown setup option");
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`--${name} requires a value`);
    if (Object.hasOwn(values, name)) fail(`--${name} may only be provided once`);
    values[name] = value;
    index += 1;
  }
  return { help, values };
}

export function normalizeSetupInput(values, { repoRoot = process.cwd() } = {}) {
  const target = required(values, "target");
  const role = required(values, "role");
  const tailnet = required(values, "tailnet");
  const ownerLogin = required(values, "owner-login");
  const format = values.format ?? "text";

  if (!TARGETS.has(target)) fail("--target must be local or ssh");
  if (!ROLES.has(role)) fail("--role must be gateway, daemon, or client");
  if (!TAILNET_PATHS.has(tailnet)) fail("--tailnet must be existing or new");
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/u.test(ownerLogin) || ownerLogin.length > 254
    || /^(?:vat_|vak_|session(?:_|-)|provider(?:_|-))/iu.test(ownerLogin)) {
    fail("--owner-login must be one exact non-secret Tailscale login in user@domain form");
  }
  if (format !== "text" && format !== "json") fail("--format must be text or json");

  let connection = { kind: "local" };
  if (target === "ssh") {
    const host = required(values, "ssh-host");
    if (!SSH_HOST_PATTERN.test(host) || host.startsWith("-")) {
      fail("--ssh-host must be a host, user@host, or bracketed IPv6 address without SSH options");
    }
    const portText = values["ssh-port"] ?? "22";
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--ssh-port must be an integer from 1 to 65535");
    connection = { kind: "ssh", host, port };
  } else if (values["ssh-host"] !== undefined || values["ssh-port"] !== undefined) {
    fail("--ssh-host and --ssh-port are only valid with --target ssh");
  }

  const paths = {};
  if (role === "gateway") {
    paths.gatewayData = deploymentPath(required(values, "gateway-data-path"), "gateway-data-path", target);
    paths.files = deploymentPath(required(values, "files-path"), "files-path", target);
    paths.memory = deploymentPath(required(values, "memory-path"), "memory-path", target);
    if (values["workspace-path"] !== undefined) fail("--workspace-path is only valid for daemon targets");
  } else if (role === "daemon") {
    paths.workspace = deploymentPath(required(values, "workspace-path"), "workspace-path", target);
    paths.memory = deploymentPath(required(values, "memory-path"), "memory-path", target);
    if (values["gateway-data-path"] !== undefined || values["files-path"] !== undefined) {
      fail("gateway paths are only valid for gateway targets");
    }
  } else {
    for (const name of ["gateway-data-path", "files-path", "memory-path", "workspace-path"]) {
      if (values[name] !== undefined) fail(`--${name} is not valid for client targets`);
    }
  }
  assertDistinctPaths(paths);
  for (const [name, value] of Object.entries(paths)) {
    if (name !== "workspace" && /^\/(?:home|Users)\/[^/]+$/u.test(value)) {
      fail(`--${PATH_FLAG_NAMES[name]} must be a dedicated Vera path, not an entire user home`);
    }
  }
  if (target === "local") {
    const normalizedRepoRoot = path.normalize(repoRoot);
    for (const [name, value] of Object.entries(paths)) {
      if (name === "workspace") continue;
      if (value === normalizedRepoRoot || value.startsWith(`${normalizedRepoRoot}/`) || normalizedRepoRoot.startsWith(`${value}/`)) {
        fail(`--${PATH_FLAG_NAMES[name]} must not overlap the Vera source repository`);
      }
    }
  }

  const deploymentTarget = Object.freeze({ id: "target-1", role, connection, paths: Object.freeze(paths) });
  return Object.freeze({ tailnet, ownerLogin, targets: Object.freeze([deploymentTarget]), format });
}

export const setupUsage = `Usage:
  npm run setup -- --target ssh --ssh-host <host> --role gateway \\
    --tailnet existing --owner-login <email> \\
    --gateway-data-path /var/lib/vera/data --files-path /var/lib/vera/files \\
    --memory-path /var/lib/vera/memory

Roles:
  gateway  requires --gateway-data-path, --files-path, --memory-path
  daemon   requires --workspace-path, --memory-path
  client   accepts no server paths

This first setup slice performs read-only preflight and prints a plan. It does
not install packages, write files, change services, firewall, SSH, or Tailscale.`;
