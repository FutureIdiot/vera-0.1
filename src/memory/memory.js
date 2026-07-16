// Agent-scoped markdown Memory authority. Reads remain direct; all gateway
// mutations pass through one FIFO per Agent and use crash-safe same-directory
// replacement. The JSON index under .vera-index is disposable and rebuildable.

import { link, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { ApiError } from "../core/errors.js";
import {
  parseMemoryDocument, serializeMemoryDocument, toIndexEntry, validateSources,
} from "./memory-format.js";
import {
  MEMORY_INDEX_SCHEMA_VERSION, hasMemoryBatchMarker, readMemoryIndex, writeMemoryIndex,
} from "./memory-index.js";
import { createMemoryOperations } from "./memory-operations.js";
import { createMemoryWriteQueue } from "./memory-write-queue.js";

const AGENT_ID_PATTERN = /^agt_[a-z0-9]+$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function invalid(message) { return new ApiError("invalid_request", message); }
function assertAgentId(agentId) {
  if (typeof agentId !== "string" || !AGENT_ID_PATTERN.test(agentId)) throw invalid(`invalid agentId: ${JSON.stringify(agentId)}`);
}
function assertSlug(slug) {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) throw invalid(`slug must be kebab-case: ${JSON.stringify(slug)}`);
}
function sortValue(value) {
  const time = Date.parse(value ?? "");
  return Number.isNaN(time) ? 0 : time;
}
function diagnostic(agentId, slug, error) {
  return {
    code: "invalid_memory_file",
    relativePath: `${agentId}/${slug}.md`,
    slug,
    issues: [{
      field: "frontmatter",
      code: error?.code === "invalid_request" ? "invalid" : "unreadable",
      message: error?.code === "invalid_request" ? error.message : "memory file cannot be read",
    }],
  };
}

function invalidMemoryFile(agentId, slug, error) {
  const apiError = new ApiError("invalid_memory_file", `memory ${slug} is invalid`);
  apiError.details = { file: diagnostic(agentId, slug, error) };
  return apiError;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicReplace(path, content, { createOnly = false } = {}) {
  const parent = join(path, "..");
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.${path.split("/").at(-1)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (createOnly) {
      await link(temporary, path);
      await unlink(temporary);
    } else {
      await rename(temporary, path);
    }
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export function createMemoryVault({ vaultPath, resolveSource, onExternalEdit = null, writeMemoryFile = atomicReplace } = {}) {
  let activeRoot = resolve(vaultPath);
  let epoch = 0;
  const queue = createMemoryWriteQueue();

  const agentPathFor = (root, agentId) => { assertAgentId(agentId); return join(root, agentId); };
  const filePathFor = (root, agentId, slug) => { assertSlug(slug); return join(agentPathFor(root, agentId), `${slug}.md`); };
  const rootSnapshot = () => ({ root: activeRoot, epoch });

  async function validateSourceRefs(sources) {
    const normalized = validateSources(sources);
    for (const source of normalized) {
      if (source.kind !== "message") continue;
      if (typeof resolveSource !== "function") throw invalid("message sources require a resolveSource callback");
      const resolved = await resolveSource(source);
      if (!resolved) throw invalid(`source message ${source.messageId} does not exist`);
      if (resolved.spaceId !== source.spaceId) throw invalid(`source message ${source.messageId} does not belong to space ${source.spaceId}`);
    }
    return normalized;
  }

  async function readCanonical(root, agentId, slug, { upgradeLegacy = true, queueHeld = false } = {}) {
    let raw;
    const path = filePathFor(root, agentId, slug);
    try { raw = await readFile(path, "utf8"); }
    catch (error) {
      if (error.code === "ENOENT") throw new ApiError("not_found", `memory ${slug} does not exist for agent ${agentId}`);
      throw error;
    }
    const parsed = parseMemoryDocument(raw, { slug, agentId });
    if (parsed.legacy && upgradeLegacy) {
      if (queueHeld) {
        await writeMemoryFile(path, serializeMemoryDocument(parsed.memory));
        return readCanonical(root, agentId, slug, { upgradeLegacy: false });
      }
      await queue.enqueue(agentId, async () => {
        const latestRaw = await readFile(path, "utf8");
        const latest = parseMemoryDocument(latestRaw, { slug, agentId });
        if (latest.legacy) await writeMemoryFile(path, serializeMemoryDocument(latest.memory));
      });
      return readCanonical(root, agentId, slug, { upgradeLegacy: false });
    }
    return parsed.memory;
  }

  async function scanAt(root, agentId, { force = false, queueHeld = false, external = false, allowPendingBatch = false } = {}) {
    if (!allowPendingBatch && await hasMemoryBatchMarker(root, agentId)) {
      throw new ApiError("memory_provider_unavailable", "Memory maintenance recovery is in progress");
    }
    const agentPath = agentPathFor(root, agentId);
    let dirents;
    try { dirents = await readdir(agentPath, { withFileTypes: true }); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      dirents = [];
    }
    const files = dirents.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name));
    let previous;
    try { previous = await readMemoryIndex(root, agentId); }
    catch {
      previous = null;
    }
    const fingerprints = {};
    const entries = [];
    const ownerMemories = [];
    const errors = [];
    const previousEntries = new Map((previous?.entries ?? []).map((entry) => [entry.slug, entry]));
    const previousErrors = new Map((previous?.errors ?? []).map((error) => [error.slug, error]));
    let changed = force || !previous || Object.keys(previous.fingerprints).length !== files.length;

    for (const file of files) {
      const slug = file.name.slice(0, -3);
      const path = join(agentPath, file.name);
      let info;
      let raw;
      try {
        info = await stat(path);
        raw = await readFile(path, "utf8");
      } catch (error) {
        changed = true;
        if (error.code === "ENOENT") continue;
        errors.push(diagnostic(agentId, slug, error));
        continue;
      }
      const fingerprint = raw === null
        ? `unreadable:${info.size}:${info.mtimeMs}`
        : createHash("sha256").update(raw).digest("hex");
      fingerprints[slug] = fingerprint;
      if (!force && previous?.fingerprints?.[slug] === fingerprint) {
        const cached = previousEntries.get(slug);
        const cachedError = previousErrors.get(slug);
        if (cached) {
          entries.push(cached);
          // The disposable index is deliberately stain-free. Owner-facing
          // list reads recover stains from the authoritative markdown bytes.
          const parsed = parseMemoryDocument(raw, { slug, agentId });
          ownerMemories.push({ ...cached, stains: parsed.memory.stains ?? {} });
        }
        else if (cachedError) errors.push(cachedError);
        else changed = true;
        continue;
      }
      changed = true;
      try {
        assertSlug(slug);
        if (raw === null) throw new Error("memory file is unreadable");
        const parsed = parseMemoryDocument(raw, { slug, agentId });
        let memory = parsed.memory;
        if (parsed.legacy && queueHeld) {
          const canonical = serializeMemoryDocument(memory);
          await writeMemoryFile(path, canonical);
          fingerprints[slug] = createHash("sha256").update(canonical).digest("hex");
        } else if (parsed.legacy) {
          memory = await readCanonical(root, agentId, slug);
        }
        await validateSourceRefs(memory.sources);
        const indexEntry = toIndexEntry(memory);
        entries.push(indexEntry);
        ownerMemories.push({ ...indexEntry, stains: memory.stains ?? {} });
      } catch (error) {
        errors.push(diagnostic(agentId, slug, error));
      }
    }
    entries.sort((a, b) => sortValue(b.updatedAt) - sortValue(a.updatedAt) || a.slug.localeCompare(b.slug));
    ownerMemories.sort((a, b) => sortValue(b.updatedAt) - sortValue(a.updatedAt) || a.slug.localeCompare(b.slug));
    errors.sort((a, b) => String(a.slug ?? "").localeCompare(String(b.slug ?? "")));
    if (!changed && previous) return {
      agentId, scannedAt: new Date().toISOString(), created: [], updated: [], removed: [],
      unchangedCount: files.length, invalid: previous.errors.length,
      memories: ownerMemories, errors: previous.errors,
      index: { generation: previous.generation, builtAt: previous.builtAt, status: "current" },
    };
    const priorFingerprints = previous?.fingerprints ?? {};
    const created = Object.keys(fingerprints).filter((slug) => !(slug in priorFingerprints));
    const updated = Object.keys(fingerprints).filter((slug) => slug in priorFingerprints && fingerprints[slug] !== priorFingerprints[slug]);
    const removed = Object.keys(priorFingerprints).filter((slug) => !(slug in fingerprints));
    const index = {
      schemaVersion: MEMORY_INDEX_SCHEMA_VERSION,
      agentId,
      generation: (previous?.generation ?? 0) + 1,
      builtAt: new Date().toISOString(),
      fingerprints,
      entries,
      errors,
    };
    let indexWriteFailed = false;
    try { await writeMemoryIndex(root, agentId, index); }
    catch (error) {
      indexWriteFailed = true;
    }
    if (external && previous && typeof onExternalEdit === "function") {
      for (const slug of [...created, ...updated]) {
        try { onExternalEdit({ agentId, slug }); } catch {}
      }
    }
    return {
      agentId, scannedAt: new Date().toISOString(), created, updated, removed,
      unchangedCount: files.length - created.length - updated.length,
      invalid: errors.filter((error) => error.code === "invalid_memory_file").length,
      memories: ownerMemories, errors,
      index: {
        generation: index.generation,
        builtAt: index.builtAt,
        status: indexWriteFailed ? "degraded" : "rebuilt",
      },
    };
  }

  async function listWithDiagnostics(agentId) {
    return queue.enqueue(agentId, () => scanAt(rootSnapshot().root, agentId, { queueHeld: true, external: true }));
  }
  async function listMemories(agentId) { return (await listWithDiagnostics(agentId)).memories; }
  async function snapshotMemoriesHeld(agentId) {
    const root = rootSnapshot().root;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const listed = await scanAt(root, agentId, { queueHeld: true, external: true });
      const memories = [];
      for (const item of listed.memories) {
        const full = await readCanonical(root, agentId, item.slug, { queueHeld: true });
        full.sources = await validateSourceRefs(full.sources);
        memories.push(full);
      }
      const confirmed = await scanAt(root, agentId, { queueHeld: true, external: true });
      if (confirmed.index.generation === listed.index.generation) {
        return { memories, errors: confirmed.errors, index: confirmed.index };
      }
    }
    throw new ApiError("memory_provider_unavailable", "Memory snapshot changed while it was being frozen");
  }
  async function snapshotMemories(agentId) {
    return queue.enqueue(agentId, () => snapshotMemoriesHeld(agentId));
  }
  async function rebuildIndex(agentId) {
    return queue.enqueue(agentId, () => scanAt(rootSnapshot().root, agentId, { force: true, queueHeld: true }));
  }
  const {
    applyOperation,
    applyBatch,
    applyMultiAgentBatch,
    applyMultiAgentBatchHeld,
    finalizeBatch,
    saveMemory,
    getMemory,
    updateMemory,
    deleteMemory,
  } = createMemoryOperations({
    queue, rootSnapshot, getActiveRoot: () => activeRoot, assertAgentId, assertSlug,
    filePathFor, agentPathFor, readCanonical, scanAt, validateSourceRefs,
    atomicReplace: writeMemoryFile, syncDirectory, invalidMemoryFile,
  });

  async function inspect() {
    let entries;
    try { entries = await readdir(activeRoot, { withFileTypes: true }); }
    catch (error) {
      if (error.code === "ENOENT") return { exists: false, memoryCount: 0, agentDirectoryCount: 0, legacyUnscopedCount: 0 };
      throw error;
    }
    let memoryCount = 0;
    let agentDirectoryCount = 0;
    let legacyUnscopedCount = 0;
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) legacyUnscopedCount += 1;
      if (!entry.isDirectory() || !AGENT_ID_PATTERN.test(entry.name)) continue;
      agentDirectoryCount += 1;
      const files = await readdir(join(activeRoot, entry.name), { withFileTypes: true });
      memoryCount += files.filter((file) => file.isFile() && file.name.endsWith(".md")).length;
    }
    return { exists: (await stat(activeRoot)).isDirectory(), memoryCount, agentDirectoryCount, legacyUnscopedCount };
  }

  // Existing callers may keep the synchronous signature. Each queued operation
  // captures one immutable root snapshot, so it can never switch roots midway.
  // Migration code can await drain() before moving files and then call reopen().
  function reopen({ vaultPath: nextVaultPath }) {
    if (typeof nextVaultPath !== "string" || !nextVaultPath.trim()) throw new Error("reopen requires vaultPath");
    activeRoot = resolve(nextVaultPath);
    epoch += 1;
    return activeRoot;
  }
  async function withExclusiveMutation(task) {
    return queue.withExclusive(() => task({
      snapshotMemories: snapshotMemoriesHeld,
      applyMultiAgentBatch: applyMultiAgentBatchHeld,
    }));
  }
  return {
    applyOperation, applyBatch, applyMultiAgentBatch, finalizeBatch,
    listMemories, listWithDiagnostics, snapshotMemories, rebuildIndex, saveMemory,
    getMemory, updateMemory, deleteMemory, inspect, reopen,
    drain: queue.drain, withExclusive: queue.withExclusive, withExclusiveMutation,
    getVaultPath: () => activeRoot,
  };
}
