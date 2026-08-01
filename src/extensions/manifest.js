import { isAbsolute, relative, resolve } from "node:path";
import { ApiError } from "../core/errors.js";

const KINDS = new Set(["mcp", "hook", "skill", "plugin"]);
const ID = /^[a-z][a-z0-9.-]{1,80}$/;

function invalid(message) { throw new ApiError("invalid_request", message); }

export function validateManifest(manifest, { rootPath = null } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) invalid("extension manifest must be an object");
  if (manifest.schemaVersion !== 1) invalid("unsupported extension manifest schemaVersion");
  if (typeof manifest.extensionId !== "string" || !ID.test(manifest.extensionId)) invalid("invalid extensionId");
  if (typeof manifest.name !== "string" || !manifest.name.trim()) invalid("extension name is required");
  if (typeof manifest.version !== "string" || !manifest.version.trim()) invalid("extension version is required");
  if (typeof manifest.entry !== "string" || !manifest.entry || manifest.entry.startsWith("/")) invalid("extension entry must be a relative path");
  if (rootPath) {
    const root = resolve(rootPath);
    const entry = resolve(root, manifest.entry);
    const relativeEntry = relative(root, entry);
    if (relativeEntry.startsWith("..") || isAbsolute(relativeEntry)) invalid("extension entry must remain inside its source directory");
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) invalid("extension capabilities are required");
  const unitIds = new Set();
  for (const capability of manifest.capabilities) {
    if (!capability || typeof capability !== "object" || !ID.test(String(capability.unitId ?? ""))) invalid("invalid capability unitId");
    if (unitIds.has(capability.unitId)) invalid(`duplicate capability unitId: ${capability.unitId}`);
    unitIds.add(capability.unitId);
    if (!KINDS.has(capability.kind)) invalid(`unsupported capability kind: ${capability.kind}`);
    if (typeof capability.name !== "string" || !capability.name.trim()) invalid(`capability name is required: ${capability.unitId}`);
    if (capability.permissions !== undefined && (!Array.isArray(capability.permissions) || capability.permissions.some((item) => typeof item !== "string"))) invalid(`invalid capability permissions: ${capability.unitId}`);
  }
  if (manifest.permissions !== undefined && (!Array.isArray(manifest.permissions) || manifest.permissions.some((item) => typeof item !== "string"))) invalid("invalid extension permissions");
  return structuredClone(manifest);
}

export function manifestCapabilities(manifest) {
  return manifest.capabilities.map((item) => ({
    unitId: item.unitId,
    kind: item.kind,
    name: item.name,
    capability: item.capability ?? null,
    runtime: item.runtime ?? "extension",
  }));
}
