import { access, lstat, readdir, stat, statfs } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const VERA_STORE_FILE = /^(agents|accounts|spaces|messages|activities|approvals|runs|session-states|meta|settings|themes|files)\.json(\.legacy)?$/;

export async function dirSize(dirPath) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) total += await dirSize(fullPath);
    else if (entry.isFile()) {
      try { total += (await stat(fullPath)).size; } catch { /* unreadable files are skipped */ }
    }
  }
  return total;
}

async function writableParent(target) {
  let candidate = target;
  while (true) {
    try {
      const info = await stat(candidate);
      if (!info.isDirectory()) return false;
      await access(candidate, constants.W_OK);
      return true;
    } catch (err) {
      if (err.code !== "ENOENT") return false;
      const parent = dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
}

export async function validatePathTarget({ key, value, config, memory, files }) {
  const normalized = resolve(value);
  const errors = [];
  const warnings = [];
  if (!isAbsolute(value)) warnings.push("relative path was normalized to an absolute path");
  const rel = relative(repoRoot, normalized);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) errors.push("path must not be inside the Vera repository");
  const source = resolve(
    key === "gateway.dataPath"
      ? config.dataPath
      : key === "files.attachmentsPath"
        ? files.getRootPath()
        : memory.getVaultPath(),
  );
  const targetFromSource = relative(source, normalized);
  const sourceFromTarget = relative(normalized, source);
  if (
    normalized !== source &&
    ((!targetFromSource.startsWith("..") && !isAbsolute(targetFromSource)) ||
      (!sourceFromTarget.startsWith("..") && !isAbsolute(sourceFromTarget)))
  ) {
    errors.push("source and target paths must not contain one another");
  }
  if (!(await writableParent(normalized))) errors.push(`path or nearest parent is not writable: ${normalized}`);
  try {
    const info = await lstat(normalized);
    if (info.isSymbolicLink()) errors.push("target path must not be a symbolic link");
  } catch (error) {
    if (error.code !== "ENOENT") errors.push(`cannot inspect target: ${error.message}`);
  }

  if (key === "gateway.dataPath") {
    try {
      const entries = await readdir(normalized, { withFileTypes: true });
      const unknown = entries.filter((entry) => !entry.isFile() || !VERA_STORE_FILE.test(entry.name));
      if (unknown.length > 0) errors.push(`target contains non-Vera entries: ${unknown.slice(0, 5).map((entry) => entry.name).join(", ")}`);
    } catch (err) {
      if (err.code !== "ENOENT") errors.push(`cannot read target: ${err.message}`);
    }
    try {
      const sourceBytes = await dirSize(config.dataPath);
      const fs = await statfs(dirname(normalized));
      const freeBytes = Number(fs.bavail) * Number(fs.bsize);
      if (freeBytes < sourceBytes) errors.push(`insufficient free space: need ${sourceBytes} bytes`);
    } catch {
      warnings.push("free disk space could not be verified");
    }
  } else if (key === "memory.vaultPath") {
    const legacy = await memory.inspect();
    if (legacy.legacyUnscopedCount > 0) {
      errors.push(`vault contains ${legacy.legacyUnscopedCount} unscoped legacy markdown file(s); assign them to agent directories first`);
    }
  } else {
    try {
      const entries = await readdir(normalized);
      if (entries.length > 0) errors.push("Files migration target must be empty");
    } catch (error) {
      if (error.code !== "ENOENT") errors.push(`cannot read target: ${error.message}`);
    }
    try {
      const summary = await files.inspect();
      const fs = await statfs(dirname(normalized));
      const freeBytes = Number(fs.bavail) * Number(fs.bsize);
      if (freeBytes < summary.sizeBytes) errors.push(`insufficient free space: need ${summary.sizeBytes} bytes`);
    } catch {
      warnings.push("free disk space could not be verified");
    }
  }
  return { ok: errors.length === 0, errors, warnings, normalized };
}

export function isVeraStoreFile(name) {
  return VERA_STORE_FILE.test(name);
}
