import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryVault } from "../../src/memory/memory.js";
import {
  createMemoryEmbeddingIndex,
  MEMORY_DOCUMENT_PROJECTION_VERSION,
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_EMBEDDING_MODEL,
} from "../../src/memory/memory-embedding-index.js";

const AGENT = "agt_embed01";

function json(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function vector(seed) {
  const value = Array(MEMORY_EMBEDDING_DIMENSIONS).fill(0);
  value[seed % MEMORY_EMBEDDING_DIMENSIONS] = 1;
  return value;
}

async function snapshot(memory) {
  const value = await memory.snapshotMemories(AGENT);
  return { memories: value.memories, memoryGeneration: value.index.generation };
}

test("embedding sidecar rebuilds, updates one changed Memory, and binds the full model digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "vera-embedding-index-"));
  const memory = createMemoryVault({ vaultPath: join(root, "vault") });
  let digest = "a".repeat(64);
  const embedInputs = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/api/tags")) {
      return json({ models: [{ name: MEMORY_EMBEDDING_MODEL, model: MEMORY_EMBEDDING_MODEL, digest }] });
    }
    const body = JSON.parse(init.body);
    assert.equal(body.model, MEMORY_EMBEDDING_MODEL);
    assert.equal(body.truncate, false);
    assert.equal(body.dimensions, MEMORY_EMBEDDING_DIMENSIONS);
    embedInputs.push(body.input);
    return json({ model: MEMORY_EMBEDDING_MODEL, embeddings: [vector(embedInputs.length)] });
  };
  const index = createMemoryEmbeddingIndex({ memory, fetchImpl, now: () => "2026-07-16T00:00:00.000Z" });
  try {
    await memory.saveMemory(AGENT, {
      slug: "alpha-rule", type: "rule", description: "Alpha", content: "Alpha body.",
    });
    await memory.saveMemory(AGENT, {
      slug: "beta-rule", type: "rule", description: "Beta", content: "Beta body.",
    });

    const firstSnapshot = await snapshot(memory);
    const first = await index.prepare({ agentId: AGENT, ...firstSnapshot, query: "first query" });
    assert.equal(first.vectorsBySlug.size, 0);
    assert.equal(first.embeddingGeneration, null);
    assert.equal(first.degraded, true, "a background rebuild must not block retrieval");
    await index.drain();
    const ready = await index.prepare({ agentId: AGENT, ...firstSnapshot, query: "second query" });
    assert.equal(ready.vectorsBySlug.size, 2);
    assert.equal(ready.embeddingGeneration, 1);
    assert.equal(ready.degraded, false);
    assert.equal(embedInputs.filter((input) => input.startsWith("Type:")).length, 2);

    const beta = await memory.getMemory(AGENT, "beta-rule");
    await memory.updateMemory(AGENT, beta.slug, { ifMatch: beta.version, description: "Beta revised" });
    const changedSnapshot = await snapshot(memory);
    const changed = await index.prepare({ agentId: AGENT, ...changedSnapshot, query: "third query" });
    assert.equal(changed.embeddingGeneration, 1);
    assert.equal(changed.degraded, true);
    await index.drain();
    const updated = await index.prepare({ agentId: AGENT, ...changedSnapshot, query: "updated query" });
    assert.equal(updated.embeddingGeneration, 2);
    assert.equal(embedInputs.filter((input) => input.startsWith("Type:")).length, 3,
      "only one changed document is re-embedded");

    digest = "b".repeat(64);
    const rebuilt = await index.prepare({ agentId: AGENT, ...changedSnapshot, query: "fourth query" });
    assert.equal(rebuilt.embeddingGeneration, null);
    assert.equal(rebuilt.degraded, true);
    await index.drain();
    const rebound = await index.prepare({ agentId: AGENT, ...changedSnapshot, query: "rebound query" });
    assert.equal(rebound.embeddingGeneration, 3);
    assert.equal(embedInputs.filter((input) => input.startsWith("Type:")).length, 5,
      "digest changes rebuild every document");

    const raw = await readFile(join(root, "vault", ".vera-index", `${AGENT}.embedding.json`), "utf8");
    const ignore = await readFile(join(root, "vault", ".vera-index", ".gitignore"), "utf8");
    const sidecar = JSON.parse(raw);
    assert.equal(sidecar.modelDigest, digest);
    assert.equal(sidecar.dimensions, MEMORY_EMBEDDING_DIMENSIONS);
    assert.equal(sidecar.documentProjectionVersion, MEMORY_DOCUMENT_PROJECTION_VERSION);
    assert.equal(sidecar.entries.length, 2);
    assert.equal(ignore, "*\n!.gitignore\n");
    assert.doesNotMatch(raw, /Alpha body|Beta body|first query|Content:|stains|sources/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one failed document or an unavailable Ollama degrades only the vector channel", async () => {
  const root = await mkdtemp(join(tmpdir(), "vera-embedding-degraded-"));
  const memory = createMemoryVault({ vaultPath: join(root, "vault") });
  try {
    await memory.saveMemory(AGENT, {
      slug: "good-rule", type: "rule", description: "Good", content: "Usable content.",
    });
    await memory.saveMemory(AGENT, {
      slug: "long-rule", type: "rule", description: "Long", content: "too-long",
    });
    const current = await snapshot(memory);
    const partial = createMemoryEmbeddingIndex({
      memory,
      fetchImpl: async (url, init) => {
        if (url.endsWith("/api/tags")) {
          return json({ models: [{ name: MEMORY_EMBEDDING_MODEL, digest: "c".repeat(64) }] });
        }
        const input = JSON.parse(init.body).input;
        if (input.includes("too-long")) throw new Error("input exceeds context");
        return json({ model: MEMORY_EMBEDDING_MODEL, embeddings: [vector(1)] });
      },
    });
    const result = await partial.prepare({ agentId: AGENT, ...current, query: "safe query" });
    assert.equal(result.degraded, true);
    assert.equal(result.vectorsBySlug.has("good-rule"), false);
    assert.equal(result.vectorsBySlug.has("long-rule"), false);
    assert.ok(result.queryVector);
    await partial.drain();
    const ready = await partial.prepare({ agentId: AGENT, ...current, query: "safe query again" });
    assert.equal(ready.degraded, true);
    assert.equal(ready.vectorsBySlug.has("good-rule"), true);
    assert.equal(ready.vectorsBySlug.has("long-rule"), false);

    const offline = createMemoryEmbeddingIndex({
      memory,
      fetchImpl: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1"); },
    });
    const fallback = await offline.prepare({ agentId: AGENT, ...current, query: "safe query" });
    assert.deepEqual(fallback, {
      vectorsBySlug: new Map(),
      queryVector: null,
      embeddingGeneration: null,
      degraded: true,
    });
    assert.doesNotMatch(JSON.stringify(fallback), /127\.0\.0\.1|ECONNREFUSED/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opt-in real Ollama qwen3 embedding smoke", {
  skip: process.env.VERA_TEST_OLLAMA_EMBEDDING !== "1"
    ? "set VERA_TEST_OLLAMA_EMBEDDING=1 after installing qwen3-embedding:0.6b"
    : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "vera-embedding-real-"));
  const memory = createMemoryVault({ vaultPath: join(root, "vault") });
  try {
    await memory.saveMemory(AGENT, {
      slug: "semantic-rule", type: "rule", description: "兰花浇水",
      content: "兰花需要控制浇水频率并保持通风。",
    });
    const current = await snapshot(memory);
    const index = createMemoryEmbeddingIndex({ memory });
    const rebuilding = await index.prepare({
      agentId: AGENT, ...current, query: "how often should I water an orchid",
    });
    assert.equal(rebuilding.degraded, true);
    await index.drain();
    const ready = await index.prepare({
      agentId: AGENT, ...current, query: "how often should I water an orchid",
    });
    assert.equal(ready.degraded, false);
    assert.equal(ready.vectorsBySlug.get("semantic-rule")?.length, MEMORY_EMBEDDING_DIMENSIONS);
    assert.equal(ready.queryVector?.length, MEMORY_EMBEDDING_DIMENSIONS);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
