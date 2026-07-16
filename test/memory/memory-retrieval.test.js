import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../src/store/store.js";
import { createMemoryVault } from "../../src/memory/memory.js";
import { createMemoryRetrievalService } from "../../src/memory/memory-retrieval.js";
import { estimateMemoryTokens } from "../../src/memory/memory-retrieval-ranking.js";

async function withFixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "vera-retrieval-test-"));
  const dataPath = join(root, "data");
  const store = await createStore({ dataPath, debounceMs: 5 });
  const memory = createMemoryVault({ vaultPath: join(root, "vault") });
  const retrieval = createMemoryRetrievalService({
    store, memory, config: { residentIndexMaxLines: 2, injectionTokenBudget: 128 },
  });
  try { await fn({ root, dataPath, store, memory, retrieval }); }
  finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}

async function save(memory, agentId, slug, overrides = {}) {
  return memory.saveMemory(agentId, {
    slug, type: "project_rule", description: `规则 ${slug} 必须保持稳定且可独立理解`,
    content: `当用户询问检索规则时使用 ${slug}。`, stains: { agt_other1: "#A1B2C3" }, ...overrides,
  });
}

async function session(retrieval, agentId = "agt_alpha1") {
  return retrieval.ensureSession({ agentId, agentSessionId: `ags_${agentId.slice(4)}`, generation: 1 });
}

test("recall sidecar is reused within one generation and frozen on generation change", async () => {
  await withFixture(async ({ store, retrieval }) => {
    const first = await session(retrieval);
    const same = await session(retrieval);
    assert.equal(same.id, first.id);
    const fresh = await retrieval.ensureSession({ agentId: "agt_alpha1", agentSessionId: first.agentSessionId, generation: 2 });
    assert.notEqual(fresh.id, first.id);
    assert.equal(store.find("memoryRecallSessions", first.id).status, "frozen");
    await assert.rejects(
      () => retrieval.search({ context: {
        agentId: "agt_alpha1", agentSessionId: first.agentSessionId, generation: 1,
      }, query: "规则" }),
      (error) => error.code === "memory_cursor_invalid",
    );
    assert.deepEqual(Object.keys(store.find("memoryRecallSessions", fresh.id)).filter((key) =>
      ["accountId", "spaceId", "memorySessionId"].includes(key)), []);
  });
});

test("resident index is Agent-scoped, pin-first, active-only, and hot-budgeted", async () => {
  await withFixture(async ({ memory, retrieval }) => {
    const old = await save(memory, "agt_alpha1", "alpha-old");
    await save(memory, "agt_alpha1", "alpha-pinned");
    await save(memory, "agt_alpha1", "alpha-extra");
    await save(memory, "agt_beta2", "beta-secret");
    await memory.updateMemory("agt_alpha1", old.slug, { ifMatch: old.version, status: "archived" });
    retrieval.setPinned("agt_alpha1", "alpha-pinned", true);
    const block = await retrieval.residentIndex("agt_alpha1");
    assert.match(block, /alpha-pinned/u);
    assert.match(block, /alpha-extra/u);
    assert.doesNotMatch(block, /alpha-old|beta-secret/u);
    assert.equal(block.split("\n").filter((line) => line.startsWith("- [[")).length, 2);
    retrieval.setResidentIndexMaxLines(1);
    assert.equal((await retrieval.residentIndex("agt_alpha1")).match(/^- \[\[/gmu)?.length, 1);
  });
});

test("resident index is frozen for one AgentSession generation", async () => {
  await withFixture(async ({ memory, retrieval }) => {
    await save(memory, "agt_alpha1", "alpha-first");
    const recall = await session(retrieval);
    const identity = {
      agentId: "agt_alpha1",
      agentSessionId: recall.agentSessionId,
      generation: recall.generation,
    };
    const first = await retrieval.residentIndexForSession(identity);
    await save(memory, "agt_alpha1", "alpha-later");
    assert.equal(await retrieval.residentIndexForSession(identity), first);
    assert.doesNotMatch(first, /alpha-later/u);

    await retrieval.ensureSession({ ...identity, generation: 2 });
    assert.match(await retrieval.residentIndexForSession({ ...identity, generation: 2 }), /alpha-later/u);
  });
});

test("resident index orders non-pinned Memory by derived weight before slug", async () => {
  await withFixture(async ({ store, memory, retrieval }) => {
    await save(memory, "agt_alpha1", "alpha-cold");
    await save(memory, "agt_alpha1", "zeta-hot");
    store.insert("memorySignals", {
      id: "signal-hot", agentId: "agt_alpha1", agentSessionId: "ags_old", generation: 1,
      slug: "zeta-hot", kind: "detail_opened", createdAt: new Date().toISOString(),
    });
    retrieval.setResidentIndexMaxLines(1);
    assert.match(await retrieval.residentIndex("agt_alpha1"), /zeta-hot/u);
    retrieval.setPinned("agt_alpha1", "alpha-cold", true);
    assert.match(await retrieval.residentIndex("agt_alpha1"), /alpha-cold/u);
  });
});

test("default exploration seed stays stable across runs and recall sessions", async () => {
  await withFixture(async ({ memory, retrieval }) => {
    const fixtures = [
      ["alpha", "project_rule"], ["bravo", "architecture"], ["charlie", "workflow"],
      ["delta", "preference"], ["echo", "correction"],
    ];
    for (const [slug, type] of fixtures) await save(memory, "agt_alpha1", slug, {
      type, description: "orion shared constraint", content: `${slug} unique body`,
    });
    const firstSession = await retrieval.ensureSession({ agentId: "agt_alpha1", agentSessionId: "ags_seed_a", generation: 1 });
    const secondSession = await retrieval.ensureSession({ agentId: "agt_alpha1", agentSessionId: "ags_seed_b", generation: 1 });
    const first = await retrieval.search({
      context: { agentId: "agt_alpha1", agentSessionId: firstSession.agentSessionId, generation: 1, runId: "run_one" },
      query: "orion shared constraint",
    });
    const second = await retrieval.search({
      context: { agentId: "agt_alpha1", agentSessionId: secondSession.agentSessionId, generation: 1, runId: "run_two" },
      query: "orion shared constraint",
    });
    assert.deepEqual(first.nodes.map((item) => item.slug), second.nodes.map((item) => item.slug));
  });
});

test("automatic retrieval obeys its total token budget and never reinjects a delivered slug", async () => {
  await withFixture(async ({ memory, retrieval }) => {
    for (let index = 0; index < 7; index += 1) await save(memory, "agt_alpha1", `rule-${index}`);
    const recall = await session(retrieval);
    const context = { agentId: "agt_alpha1", agentSessionId: recall.agentSessionId, generation: recall.generation, runId: "run_one" };
    const first = await retrieval.searchForInjection({ context, query: "规则 检索 稳定" });
    assert.ok(first.block);
    assert.ok(estimateMemoryTokens(first.block) <= 128);
    assert.doesNotMatch(JSON.stringify(first), /#A1B2C3|stains/u);
    const firstSlugs = first.response.nodes.map((item) => item.slug);
    const second = await retrieval.searchForInjection({ context: { ...context, runId: "run_two" }, query: "规则 检索 稳定" });
    assert.ok(second.response.nodes.every((item) => !firstSlugs.includes(item.slug)));
  });
});

test("concurrent channels serialize delivered-slug eligibility and validate query bounds", async () => {
  await withFixture(async ({ memory, retrieval }) => {
    for (let index = 0; index < 6; index += 1) await save(memory, "agt_alpha1", `parallel-rule-${index}`);
    const recall = await session(retrieval);
    const context = { agentId: "agt_alpha1", agentSessionId: recall.agentSessionId, generation: recall.generation };
    const [left, right] = await Promise.all([
      retrieval.search({ context, query: "规则 检索 稳定", tokenBudget: 64 }),
      retrieval.search({ context, query: "规则 检索 稳定", tokenBudget: 64 }),
    ]);
    const leftSlugs = new Set(left.nodes.map((item) => item.slug));
    assert.ok(right.nodes.every((item) => !leftSlugs.has(item.slug)));
    await assert.rejects(
      () => retrieval.search({ context, query: "   " }),
      (error) => error.code === "invalid_request",
    );
    await assert.rejects(
      () => retrieval.search({ context, query: "界".repeat(4097) }),
      (error) => error.code === "invalid_request",
    );
  });
});

test("frozen cursors paginate idempotently without leaking unsafe state", async () => {
  await withFixture(async ({ dataPath, store, memory, retrieval }) => {
    for (let index = 0; index < 10; index += 1) await save(memory, "agt_alpha1", `cursor-rule-${index}`);
    const recall = await session(retrieval);
    const context = { agentId: "agt_alpha1", agentSessionId: recall.agentSessionId, generation: recall.generation, runId: "run_cursor" };
    const result = await retrieval.search({ context, query: "规则 检索 稳定", tokenBudget: 64 });
    assert.ok(result.cursor);
    const storedSession = store.find("memoryRecallSessions", recall.id);
    assert.equal(storedSession.cursors.find((item) => item.id === result.cursor).pipelineVersion, "m4-r2");
    const frozenSlug = storedSession.cursors.find((item) => item.id === result.cursor).items[0].slug;
    const authority = await memory.getMemory("agt_alpha1", frozenSlug);
    await memory.deleteMemory("agt_alpha1", frozenSlug, authority.version);
    const concurrentPages = await Promise.allSettled([
      retrieval.fetchMore({ context, cursor: result.cursor, direction: "all", tokenBudget: 64 }),
      retrieval.fetchMore({ context, cursor: result.cursor, direction: "all", tokenBudget: 64 }),
    ]);
    assert.ok(concurrentPages.every((item) => item.status === "fulfilled"), JSON.stringify({
      concurrentPages, cursor: store.find("memoryRecallSessions", recall.id).cursors.find((item) => item.id === result.cursor),
    }));
    const [page, replay] = concurrentPages.map((item) => item.value);
    assert.deepEqual(replay, page);
    assert.ok(page.cursor, "fixture must span at least three pages to exercise cursor state preservation");
    assert.equal(page.nodes[0].authorityState, "deleted");
    await assert.rejects(
      () => retrieval.fetchMore({ context, cursor: result.cursor, direction: "all", tokenBudget: 65 }),
      (error) => error.code === "memory_cursor_invalid",
    );
    if (result.directions[0]) await assert.rejects(
      () => retrieval.fetchMore({ context, cursor: result.cursor, direction: result.directions[0].id, tokenBudget: 64 }),
      (error) => error.code === "memory_cursor_invalid",
    );
    assert.equal(new Set([...result.nodes, ...page.nodes].map((item) => item.slug)).size, result.nodes.length + page.nodes.length);
    const usageCount = retrieval.listSignals().filter((item) => item.kind === "fetch_more_returned").length;
    assert.equal(usageCount, page.nodes.length);
    await store.flush();
    const persisted = [
      await readFile(join(dataPath, "memoryRecallSessions.json"), "utf8"),
      await readFile(join(dataPath, "memorySignals.json"), "utf8"),
    ].join("\n");
    assert.doesNotMatch(persisted, /#A1B2C3|stains|provider|sessionState|memorySessionId|accountId|spaceId|规则 检索/u);
  });
});

test("delivering one semantic-cluster representative marks every merged slug across calls", async () => {
  await withFixture(async ({ store, memory, retrieval }) => {
    for (const slug of ["duplicate-a", "duplicate-b"]) {
      await save(memory, "agt_alpha1", slug, {
        description: "Use one private gateway",
        content: "The gateway is the single authority.",
      });
    }
    const recall = await session(retrieval);
    const context = { agentId: "agt_alpha1", agentSessionId: recall.agentSessionId, generation: 1 };
    const first = await retrieval.search({ context, query: "private gateway authority" });
    assert.equal(first.nodes.length, 1);
    assert.deepEqual(
      [...store.find("memoryRecallSessions", recall.id).deliveredSlugs].sort(),
      ["duplicate-a", "duplicate-b"],
    );
    const second = await retrieval.search({ context, query: "private gateway authority" });
    assert.deepEqual(second.nodes, []);
  });
});

test("retrieval uses injected real embedding results and reports vector degradation safely", async () => {
  await withFixture(async ({ memory, store }) => {
    await save(memory, "agt_alpha1", "orchid-care", {
      description: "兰花养护要点",
      content: "保持散射光并控制浇水频率。",
    });
    await save(memory, "agt_alpha1", "deploy-rule", {
      description: "部署边界",
      content: "只使用一个本地gateway。",
    });
    let degraded = false;
    const embeddingIndex = {
      async prepare({ memories }) {
        return {
          vectorsBySlug: new Map(memories.map((item) => [
            item.slug,
            item.slug === "orchid-care" ? [1, 0] : [0, 1],
          ])),
          queryVector: [1, 0],
          embeddingGeneration: 3,
          degraded,
        };
      },
    };
    const retrieval = createMemoryRetrievalService({ store, memory, embeddingIndex });
    const recall = await retrieval.ensureSession({
      agentId: "agt_alpha1", agentSessionId: "ags_embedding", generation: 1,
    });
    const context = { agentId: "agt_alpha1", agentSessionId: recall.agentSessionId, generation: 1 };
    const result = await retrieval.search({ context, query: "how should I water this plant" });
    assert.equal(result.nodes[0].slug, "orchid-care");
    assert.ok(result.nodes[0].reasons.some((reason) => reason.kind === "vector"));
    assert.deepEqual(result.degradedChannels, []);

    degraded = true;
    const next = await retrieval.ensureSession({
      agentId: "agt_alpha1", agentSessionId: "ags_embedding_degraded", generation: 1,
    });
    const fallback = await retrieval.search({
      context: { agentId: "agt_alpha1", agentSessionId: next.agentSessionId, generation: 1 },
      query: "gateway",
    });
    assert.deepEqual(fallback.degradedChannels, ["vector"]);
  });
});

test("fetch_detail is Agent-safe, one-hop, stain-free, and records one usage per session", async () => {
  await withFixture(async ({ memory, retrieval }) => {
    await save(memory, "agt_alpha1", "linked-rule", { description: "关联规则", content: "关联正文" });
    await save(memory, "agt_alpha1", "root-rule", { description: "根规则", content: "根正文 [[linked-rule]]" });
    await save(memory, "agt_beta2", "root-rule", { description: "另一个Agent秘密", content: "不得读取" });
    const recall = await session(retrieval);
    const context = { agentId: "agt_alpha1", agentSessionId: recall.agentSessionId, generation: recall.generation };
    const first = await retrieval.fetchDetail({ context, slug: "root-rule" });
    assert.equal(first.memory.content, "根正文 [[linked-rule]]");
    assert.deepEqual(first.memory.links, [{ slug: "linked-rule", state: "active", type: "project_rule", description: "关联规则" }]);
    assert.equal(first.usageRecorded, true);
    assert.doesNotMatch(JSON.stringify(first), /stains|#A1B2C3|另一个Agent秘密/u);
    assert.equal((await retrieval.fetchDetail({ context, slug: "root-rule" })).usageRecorded, false);
    assert.equal(retrieval.listSignals().filter((item) => item.kind === "detail_opened").length, 1);
  });
});

test("fetch_detail paginates links beyond 32 through the same frozen cursor", async () => {
  await withFixture(async ({ memory, retrieval }) => {
    const slugs = [];
    for (let index = 0; index < 33; index += 1) {
      const slug = `linked-${String(index).padStart(2, "0")}`;
      slugs.push(slug);
      const saved = await save(memory, "agt_alpha1", slug, { description: `关联节点 ${index}`, content: `正文 ${index}` });
      if (index === 0) await memory.updateMemory("agt_alpha1", slug, { ifMatch: saved.version, status: "archived" });
    }
    await save(memory, "agt_alpha1", "many-links", {
      description: "大量一跳关联", content: [...slugs, "missing-linked"].map((slug) => `[[${slug}]]`).join(" "),
    });
    const recall = await session(retrieval);
    const context = { agentId: "agt_alpha1", agentSessionId: recall.agentSessionId, generation: recall.generation };
    const detail = await retrieval.fetchDetail({ context, slug: "many-links" });
    assert.equal(detail.memory.links.length, 32);
    assert.equal(detail.memory.links.find((item) => item.slug === "linked-00").state, "archived");
    assert.ok(detail.memory.linksCursor);
    const more = await retrieval.fetchMore({ context, cursor: detail.memory.linksCursor, direction: "all", tokenBudget: 1200 });
    assert.deepEqual(more.nodes.map((item) => item.slug), ["linked-32", "missing-linked"]);
    assert.equal(more.nodes.find((item) => item.slug === "missing-linked").authorityState, "deleted");
    assert.equal(more.cursor, null);
    assert.equal(new Set([...detail.memory.links.map((item) => item.slug), ...more.nodes.map((item) => item.slug)]).size, 34);
  });
});
