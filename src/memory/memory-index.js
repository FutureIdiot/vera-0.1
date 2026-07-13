// Rebuildable Memory index persistence. The markdown vault remains authority;
// malformed or missing index JSON is treated as a cache miss.

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const MEMORY_INDEX_SCHEMA_VERSION = 1;

function indexPath(root, agentId) {
  return join(root, ".vera-index", `${agentId}.json`);
}

export async function readMemoryIndex(root, agentId) {
  try {
    const parsed = JSON.parse(await readFile(indexPath(root, agentId), "utf8"));
    if (
      parsed?.schemaVersion !== MEMORY_INDEX_SCHEMA_VERSION ||
      parsed?.agentId !== agentId ||
      !Number.isInteger(parsed?.generation) ||
      typeof parsed?.builtAt !== "string" ||
      !Array.isArray(parsed?.entries) ||
      !parsed.entries.every((entry) => entry && typeof entry === "object" && typeof entry.slug === "string") ||
      !Array.isArray(parsed?.errors) ||
      !parsed.errors.every((error) => error && typeof error === "object") ||
      !parsed?.fingerprints ||
      typeof parsed.fingerprints !== "object" ||
      Array.isArray(parsed.fingerprints)
    ) return null;
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

export async function writeMemoryIndex(root, agentId, index) {
  const target = indexPath(root, agentId);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.${agentId}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(index, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
