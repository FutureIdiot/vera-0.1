// Rebuildable vera.markdown embedding sidecar. Markdown remains authoritative;
// the sidecar stores only identity metadata and Float32 vectors.

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export const MEMORY_EMBEDDING_SCHEMA_VERSION = 1;
export const MEMORY_EMBEDDING_MODEL = "qwen3-embedding:0.6b";
export const MEMORY_EMBEDDING_DIMENSIONS = 1024;
export const MEMORY_DOCUMENT_PROJECTION_VERSION = "vera-memory-document-v1";
export const MEMORY_QUERY_PROJECTION_VERSION = "vera-memory-query-v1";

const BASE_URL = "http://127.0.0.1:11434";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const REQUEST_TIMEOUT_MS = 5000;

function sidecarPath(root, agentId) {
  return join(root, ".vera-index", `${agentId}.embedding.json`);
}

function documentProjection(memory) {
  return `Type: ${memory.type}\nDescription: ${memory.description}\nContent:\n${memory.content}`;
}

function queryProjection(query) {
  return `${MEMORY_QUERY_PROJECTION_VERSION}: Retrieve Vera Memory relevant to this query.\nQuery:\n${query}`;
}

function validVector(value, dimensions) {
  return Array.isArray(value) && value.length === dimensions &&
    value.every((number) => Number.isFinite(number));
}

function toFloat32(value) {
  return Array.from(Float32Array.from(value));
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readSidecar(root, agentId) {
  try {
    const parsed = JSON.parse(await readFile(sidecarPath(root, agentId), "utf8"));
    if (
      parsed?.schemaVersion !== MEMORY_EMBEDDING_SCHEMA_VERSION ||
      parsed?.agentId !== agentId ||
      !Number.isInteger(parsed?.memoryGeneration) ||
      !Number.isInteger(parsed?.embeddingGeneration) ||
      typeof parsed?.modelName !== "string" ||
      !DIGEST_PATTERN.test(parsed?.modelDigest ?? "") ||
      !Number.isInteger(parsed?.dimensions) ||
      typeof parsed?.documentProjectionVersion !== "string" ||
      !Array.isArray(parsed?.entries) ||
      !parsed.entries.every((entry) => (
        typeof entry?.slug === "string" &&
        typeof entry?.memoryVersion === "string" &&
        validVector(entry?.vector, parsed.dimensions)
      ))
    ) return null;
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeSidecar(root, agentId, sidecar) {
  const target = sidecarPath(root, agentId);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const ignorePath = join(parent, ".gitignore");
  let ignoreHandle;
  try {
    ignoreHandle = await open(ignorePath, "wx", 0o600);
    await ignoreHandle.writeFile("*\n!.gitignore\n", "utf8");
    await ignoreHandle.sync();
    await ignoreHandle.close();
    ignoreHandle = null;
    await syncDirectory(parent);
  } catch (error) {
    await ignoreHandle?.close().catch(() => {});
    if (error?.code !== "EEXIST") throw error;
  }
  const temporary = join(parent, `.${agentId}.embedding.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(sidecar)}\n`, "utf8");
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

export function createMemoryEmbeddingIndex({
  memory,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  baseUrl = BASE_URL,
  modelName = MEMORY_EMBEDDING_MODEL,
  dimensions = MEMORY_EMBEDDING_DIMENSIONS,
} = {}) {
  if (!memory?.getVaultPath || typeof fetchImpl !== "function") {
    throw new Error("createMemoryEmbeddingIndex requires Memory and fetch");
  }
  const builds = new Map();
  const failedDocuments = new Map();

  async function requestJson(path, init) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response?.ok) throw new Error("embedding request failed");
    return response.json();
  }

  async function resolveModelDigest() {
    const payload = await requestJson("/api/tags");
    const model = payload?.models?.find((item) => item?.name === modelName || item?.model === modelName);
    if (!model || !DIGEST_PATTERN.test(model.digest ?? "")) throw new Error("embedding model is unavailable");
    return model.digest;
  }

  async function embed(input) {
    const payload = await requestJson("/api/embed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelName, input, truncate: false, dimensions }),
    });
    const vector = payload?.embeddings?.[0];
    if (payload?.model !== modelName || !validVector(vector, dimensions)) {
      throw new Error("embedding response is invalid");
    }
    return toFloat32(vector);
  }

  function identityMatches(sidecar, modelDigest) {
    return sidecar &&
      sidecar.modelName === modelName &&
      sidecar.modelDigest === modelDigest &&
      sidecar.dimensions === dimensions &&
      sidecar.documentProjectionVersion === MEMORY_DOCUMENT_PROJECTION_VERSION;
  }

  function failureKey(modelDigest, memory) {
    return `${modelDigest}\0${memory.slug}\0${memory.version}`;
  }

  async function buildSidecar({ agentId, memories, memoryGeneration, modelDigest, root }) {
    let prior;
    try { prior = await readSidecar(root, agentId); }
    catch { prior = null; }
    const fullRebuild = !identityMatches(prior, modelDigest);
    const priorEntries = new Map((fullRebuild ? [] : prior.entries).map((entry) => [entry.slug, entry]));
    const failures = failedDocuments.get(agentId) ?? new Set();
    failedDocuments.set(agentId, failures);
    const entries = [];
    for (const item of memories) {
      const cached = priorEntries.get(item.slug);
      if (cached?.memoryVersion === item.version && validVector(cached.vector, dimensions)) {
        entries.push(cached);
        continue;
      }
      const key = failureKey(modelDigest, item);
      if (failures.has(key)) continue;
      try {
        entries.push({ slug: item.slug, memoryVersion: item.version, vector: await embed(documentProjection(item)) });
      } catch {
        failures.add(key);
      }
    }
    await writeSidecar(root, agentId, {
      schemaVersion: MEMORY_EMBEDDING_SCHEMA_VERSION,
      agentId,
      memoryGeneration,
      embeddingGeneration: (prior?.embeddingGeneration ?? 0) + 1,
      modelName,
      modelDigest,
      dimensions,
      documentProjectionVersion: MEMORY_DOCUMENT_PROJECTION_VERSION,
      builtAt: now(),
      entries,
    });
  }

  function scheduleBuild(input) {
    if (builds.has(input.agentId)) return builds.get(input.agentId);
    const task = buildSidecar(input).catch(() => {});
    builds.set(input.agentId, task);
    task.finally(() => { if (builds.get(input.agentId) === task) builds.delete(input.agentId); });
    return task;
  }

  async function prepare({ agentId, memories, memoryGeneration, query }) {
    const root = memory.getVaultPath();
    let modelDigest;
    try { modelDigest = await resolveModelDigest(); }
    catch {
      return { vectorsBySlug: new Map(), queryVector: null, embeddingGeneration: null, degraded: true };
    }
    const active = memories.filter((candidate) => candidate.status === "active")
      .sort((a, b) => a.slug.localeCompare(b.slug));
    let prior;
    try { prior = await readSidecar(root, agentId); }
    catch { prior = null; }
    const compatible = identityMatches(prior, modelDigest);
    const currentBySlug = new Map(active.map((item) => [item.slug, item]));
    const entries = compatible
      ? prior.entries.filter((entry) => currentBySlug.get(entry.slug)?.version === entry.memoryVersion)
      : [];
    const failures = failedDocuments.get(agentId) ?? new Set();
    const expectedCount = active.filter((item) => !failures.has(failureKey(modelDigest, item))).length;
    const needsBuild = !compatible ||
      prior.memoryGeneration !== memoryGeneration ||
      entries.length !== expectedCount;
    if (needsBuild) scheduleBuild({ agentId, memories: active, memoryGeneration, modelDigest, root });
    let degraded = needsBuild || entries.length !== active.length;
    let queryVector = null;
    try { queryVector = await embed(queryProjection(query)); }
    catch { degraded = true; }
    return {
      vectorsBySlug: new Map(entries.map((entry) => [entry.slug, entry.vector])),
      queryVector,
      embeddingGeneration: compatible ? prior.embeddingGeneration : null,
      degraded,
    };
  }

  return {
    prepare,
    drain: async () => { await Promise.allSettled([...builds.values()]); },
  };
}
