// M3 retrieval facade: one Agent-scoped ranking pipeline shared by automatic
// prompt injection, Memory MCP search/pagination, and resident-index projection.

import { randomUUID } from "node:crypto";
import { ApiError } from "../core/errors.js";
import {
  estimateMemoryTokens,
  MEMORY_PIPELINE_VERSION,
  rankMemoryCandidates,
} from "./memory-retrieval-ranking.js";
import { calculateMemoryDerivedWeights } from "./memory-derived-weight.js";
import { extractMemoryLinks } from "./memory-retrieval-text.js";
import { createMemoryRetrievalState } from "./memory-retrieval-state.js";

const MCP_DEFAULT_BUDGET = 1200;
const MIN_PAGE_BUDGET = 64;
const MAX_PAGE_BUDGET = 1200;
const AUTO_HEADER = "=== Vera 相关记忆 ===";
const AUTO_FOOTER = "仅在相关时使用；需要正文调用 memory_fetch_detail。";

function opaque(prefix) { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
function fail(code, message) { return new ApiError(code, message); }
function publicNode(item, projectionLevel = item.projectionLevel ?? "standard", rank = item.rank) {
  return {
    rank,
    slug: item.slug,
    version: item.version ?? null,
    type: item.type,
    projection: item.projectionOptions?.[projectionLevel] ?? item.projection,
    projectionLevel,
    reasons: item.reasons ?? [],
    directionIds: item.directionIds ?? [],
    primaryDirectionId: item.primaryDirectionId ?? null,
  };
}
function frozenNode(item) {
  return {
    ...publicNode(item),
    mergedSlugs: [...new Set(item.mergedSlugs ?? [item.slug])],
    projectionOptions: { ...item.projectionOptions },
    compactTokenCost: item.compactTokenCost,
    standardTokenCost: item.standardTokenCost,
  };
}
function nodeLine(node) { return `- [[${node.slug}]] [${node.type}] ${node.projection}`; }
function pageBudget(value, fallback, maximum = MAX_PAGE_BUDGET) {
  const budget = value ?? fallback;
  if (!Number.isInteger(budget) || budget < MIN_PAGE_BUDGET || budget > maximum) {
    throw fail("invalid_request", `tokenBudget must be an integer from ${MIN_PAGE_BUDGET} to ${maximum}`);
  }
  return budget;
}
function validQuery(query) {
  if (typeof query !== "string" || !query.normalize("NFKC").trim()) {
    throw fail("invalid_request", "query must be a non-empty string");
  }
  if ([...query.normalize("NFKC")].length > 4096) {
    throw fail("invalid_request", "query must be at most 4096 Unicode code points");
  }
  return query;
}

export function createMemoryRetrievalService({
  store, memory, embeddingIndex = null, config = {}, isRecallEnabled = () => true, now = () => new Date().toISOString(),
} = {}) {
  if (!store || !memory) throw new Error("createMemoryRetrievalService requires store and memory");
  let residentIndexMaxLines = config.residentIndexMaxLines ?? 25;
  let injectionTokenBudget = config.injectionTokenBudget ?? config.retrievalTokenBudget ?? 384;
  const derivedWeightSeed = config.derivedWeightSeed ?? "vera-m4-v1";
  const state = createMemoryRetrievalState({ store, now });
  const {
    ensureSession, resetSession, findSession, saveCursor, cacheCursor, selectCursor,
    addUsage, addDelivered, hasUsage, getPin, setPinned, recordUserEdit,
  } = state;
  function factIds(agentId) {
    const result = {};
    for (const job of store.list("memoryDigestJobs")) {
      if (job.agentId !== agentId || !["succeeded", "partial"].includes(job.status)) continue;
      for (const fact of job.result?.facts ?? []) if (fact?.slug && fact?.factId) result[fact.slug] = fact.factId;
    }
    return result;
  }
  async function activeMemories(agentId) {
    const listed = await memory.listWithDiagnostics(agentId);
    const active = listed.memories.filter((item) => item.status === "active");
    const hydrated = [];
    for (const item of active) hydrated.push(await memory.getMemory(agentId, item.slug));
    return { memories: hydrated, generation: listed.index.generation };
  }
  function pack(items, tokenBudget) {
    const nodes = [];
    let usedTokens = 0;
    for (const item of items) {
      const standard = publicNode(item, "standard", nodes.length + 1);
      const compact = publicNode(item, "compact", nodes.length + 1);
      const standardCost = estimateMemoryTokens(nodeLine(standard));
      const compactCost = estimateMemoryTokens(nodeLine(compact));
      if (usedTokens + standardCost <= tokenBudget) { nodes.push(standard); usedTokens += standardCost; }
      else if (usedTokens + compactCost <= tokenBudget) { nodes.push(compact); usedTokens += compactCost; }
      else break;
    }
    return { nodes, selectedItems: items.slice(0, nodes.length), usedTokens, remaining: items.slice(nodes.length) };
  }
  async function searchLocked({ context, query, tokenBudget, kind = "search_returned", reservedTokens = 0, maximumBudget = MAX_PAGE_BUDGET, explorationSeed = undefined }) {
    const session = findSession(context);
    validQuery(query);
    const budget = pageBudget(tokenBudget, MCP_DEFAULT_BUDGET, maximumBudget);
    const { memories, generation } = await activeMemories(context.agentId);
    const delivered = new Set(session.deliveredSlugs ?? []);
    const eligible = memories.filter((item) => !delivered.has(item.slug));
    const derivedWeightsBySlug = calculateMemoryDerivedWeights({
      agentId: context.agentId, memories, signals: state.listSignals(), now: now(),
    });
    let embedding = {
      vectorsBySlug: new Map(),
      queryVector: null,
      embeddingGeneration: null,
      degraded: true,
    };
    if (embeddingIndex?.prepare) {
      try {
        embedding = await embeddingIndex.prepare({
          agentId: context.agentId,
          memories,
          memoryGeneration: generation,
          query,
        });
      } catch {}
    }
    const ranked = rankMemoryCandidates({
      query, memories: eligible, factIdsBySlug: factIds(context.agentId), derivedWeightsBySlug,
      embeddingBySlug: embedding.vectorsBySlug, queryEmbedding: embedding.queryVector,
      explorationSeed: explorationSeed ?? derivedWeightSeed,
      tokenBudget: MAX_PAGE_BUDGET,
    });
    const frozen = ranked.orderedCandidates.map(frozenNode);
    const page = pack(frozen, Math.max(0, budget - reservedTokens));
    const retrievalId = opaque("mrt");
    const cursor = page.remaining.length ? saveCursor(session, {
      retrievalId, pipelineVersion: MEMORY_PIPELINE_VERSION,
      memoryIndexGeneration: generation, embeddingGeneration: embedding.embeddingGeneration,
      degradedChannels: embedding.degraded ? ["vector"] : [],
      direction: null, items: page.remaining, directions: ranked.directions, cached: null,
    }) : null;
    const response = {
      retrievalId, nodes: page.nodes, cursor, directions: ranked.directions.map(({ id, seedSlug }) => ({ id, seedSlug })),
      budget: { estimator: "vera-utf8-v1", limitTokens: budget, usedTokens: page.usedTokens,
        omittedCount: page.remaining.length, minimumNextNodeTokens: page.remaining.length ? estimateMemoryTokens(nodeLine(publicNode(page.remaining[0], "compact"))) : 0 },
      degradedChannels: embedding.degraded ? ["vector"] : [],
    };
    addUsage(context, retrievalId, page.nodes, kind);
    addDelivered(session, page.selectedItems.flatMap((item) => item.mergedSlugs ?? [item.slug]));
    return response;
  }
  async function search(args) {
    const session = findSession(args?.context);
    return state.withSessionLock(session.id, () => searchLocked(args));
  }
  async function searchForInjectionLocked({ context, query }) {
    if (!isRecallEnabled(context.agentId)) {
      return { block: null, response: { retrievalId: null, nodes: [], cursor: null, directions: [], budget: { estimator: "vera-utf8-v1", limitTokens: 0, usedTokens: 0, omittedCount: 0, minimumNextNodeTokens: 0 }, degradedChannels: [] } };
    }
    if (!Number.isInteger(injectionTokenBudget) || injectionTokenBudget < MIN_PAGE_BUDGET) {
      return { block: null, response: { retrievalId: null, nodes: [], cursor: null, directions: [], budget: { estimator: "vera-utf8-v1", limitTokens: Math.max(0, injectionTokenBudget), usedTokens: 0, omittedCount: 0, minimumNextNodeTokens: 0 }, degradedChannels: [] } };
    }
    const recall = findSession(context);
    if ((recall.deliveredSlugs ?? []).length === 0) {
      const residentSlugs = (await residentItems(context.agentId)).map((item) => item.slug);
      if (residentSlugs.length) addDelivered(recall, residentSlugs);
    }
    const limit = injectionTokenBudget;
    const cursorLine = `更多：memory_fetch_more(cursor="mrc_${"0".repeat(32)}", direction="all")`;
    const reservedTokens = estimateMemoryTokens(`${AUTO_HEADER}\n${AUTO_FOOTER}\n${cursorLine}`);
    const response = await searchLocked({ context, query, tokenBudget: limit, kind: "auto_injected", reservedTokens, maximumBudget: 4096 });
    if (!response.nodes.length) return { block: null, response };
    const lines = [AUTO_HEADER, ...response.nodes.map(nodeLine), AUTO_FOOTER];
    if (response.cursor) lines.push(`更多：memory_fetch_more(cursor="${response.cursor}", direction="all")`);
    response.budget.usedTokens = estimateMemoryTokens(lines.join("\n"));
    const session = findSession(context);
    addDelivered(session, response.nodes.map((item) => item.slug));
    return { block: lines.join("\n"), response };
  }
  async function searchForInjection(args) {
    const session = findSession(args?.context);
    return state.withSessionLock(session.id, () => searchForInjectionLocked(args));
  }
  async function fetchMoreLocked({ context, cursor, direction, tokenBudget }) {
    const session = findSession(context);
    let saved = (session.cursors ?? []).find((item) => item.id === cursor);
    if (!saved) throw fail("memory_cursor_invalid", "Memory cursor is invalid");
    if (saved.pipelineVersion !== MEMORY_PIPELINE_VERSION) {
      throw fail("memory_cursor_invalid", "Memory cursor pipeline is no longer available");
    }
    if (Date.parse(saved.expiresAt) <= Date.parse(now())) throw fail("memory_cursor_expired", "Memory cursor has expired");
    const allowed = new Set(["all", ...(saved.directions ?? []).map((item) => item.id)]);
    if (!allowed.has(direction) || (saved.direction && saved.direction !== direction)) throw fail("memory_cursor_invalid", "Memory cursor direction is invalid");
    const budget = pageBudget(tokenBudget, MCP_DEFAULT_BUDGET);
    if (saved.selectedBudget !== undefined && saved.selectedBudget !== budget) {
      throw fail("memory_cursor_invalid", "Memory cursor token budget is already fixed");
    }
    if (saved.cached?.response) return saved.cached.response;
    saved = selectCursor(session, saved.id, direction, budget);
    const items = direction === "all" ? saved.items : saved.items.filter((item) => item.directionIds.includes(direction));
    const page = pack(items, budget);
    const authorityNodes = [];
    for (const node of page.nodes) {
      try { await memory.getMemory(context.agentId, node.slug); authorityNodes.push(node); }
      catch (error) {
        if (error?.code === "not_found") authorityNodes.push({ ...node, authorityState: "deleted" });
        else throw error;
      }
    }
    const nextCursor = page.remaining.length ? saveCursor(session, {
      retrievalId: saved.retrievalId, pipelineVersion: saved.pipelineVersion,
      memoryIndexGeneration: saved.memoryIndexGeneration, embeddingGeneration: saved.embeddingGeneration,
      degradedChannels: saved.degradedChannels ?? [],
      direction, items: page.remaining,
      directions: saved.directions, cached: null,
    }) : null;
    const response = {
      retrievalId: saved.retrievalId, nodes: authorityNodes, cursor: nextCursor, directions: [],
      budget: { estimator: "vera-utf8-v1", limitTokens: budget, usedTokens: page.usedTokens,
        omittedCount: page.remaining.length, minimumNextNodeTokens: page.remaining.length ? estimateMemoryTokens(nodeLine(publicNode(page.remaining[0], "compact"))) : 0 },
      degradedChannels: saved.degradedChannels ?? [],
    };
    cacheCursor(session, saved.id, { response });
    addUsage(context, saved.retrievalId, authorityNodes, "fetch_more_returned");
    addDelivered(session, page.selectedItems.flatMap((item) => item.mergedSlugs ?? [item.slug]));
    return response;
  }
  async function fetchMore(args) {
    const session = findSession(args?.context);
    return state.withCursorLock(args?.cursor, () =>
      state.withSessionLock(session.id, () => fetchMoreLocked(args)));
  }
  async function fetchDetailLocked({ context, slug }) {
    const session = findSession(context);
    const full = await memory.getMemory(context.agentId, slug);
    const linkedRecords = [];
    for (const linkedSlug of extractMemoryLinks(full)) {
      try {
        const linked = await memory.getMemory(context.agentId, linkedSlug);
        linkedRecords.push({ slug: linked.slug, version: linked.version, state: linked.status, type: linked.type, description: linked.description });
      } catch (error) {
        if (error?.code === "not_found") linkedRecords.push({ slug: linkedSlug, version: null, state: "missing", type: null, description: null });
        else throw error;
      }
    }
    const links = linkedRecords.slice(0, 32).map(({ version, ...item }) => item);
    const remaining = linkedRecords.slice(32).map((item, index) => {
      const directionId = opaque("dir");
      return frozenNode({
        rank: index + 1, slug: item.slug, version: item.version, type: item.type ?? "unknown",
        projection: item.description ?? "Linked Memory is missing.", projectionLevel: "compact",
        projectionOptions: { compact: item.description ?? "Linked Memory is missing.", standard: item.description ?? "Linked Memory is missing." },
        reasons: [{ kind: "graph", directionId, hop: 1 }], directionIds: [directionId], primaryDirectionId: directionId,
      });
    });
    const linksCursor = remaining.length ? saveCursor(session, {
      retrievalId: opaque("mrt"), pipelineVersion: MEMORY_PIPELINE_VERSION,
      memoryIndexGeneration: null, embeddingGeneration: null, degradedChannels: [],
      direction: "all", items: remaining, directions: [], cached: null,
    }) : null;
    const prior = hasUsage(context, slug, "detail_opened");
    if (!prior) addUsage(context, null, [{ slug }], "detail_opened");
    addDelivered(session, [slug]);
    const { stains, scope, schemaVersion, ...safe } = full;
    return { memory: { ...safe, links, linksCursor }, usageRecorded: !prior };
  }
  async function fetchDetail(args) {
    const session = findSession(args?.context);
    return state.withSessionLock(session.id, () => fetchDetailLocked(args));
  }
  async function residentItems(agentId) {
    const { memories: active } = await activeMemories(agentId);
    const pins = new Map(active.map((item) => [item.slug, getPin(agentId, item.slug)]));
    const derivedWeights = calculateMemoryDerivedWeights({
      agentId, memories: active, signals: state.listSignals(), now: now(),
    });
    active.sort((a, b) => {
      const aPin = pins.get(a.slug), bPin = pins.get(b.slug);
      if (aPin.pinned !== bPin.pinned) return Number(bPin.pinned) - Number(aPin.pinned);
      if (aPin.pinned) {
        return String(aPin.pinnedAt).localeCompare(String(bPin.pinnedAt)) || a.slug.localeCompare(b.slug);
      }
      return (derivedWeights.get(b.slug) ?? 0) - (derivedWeights.get(a.slug) ?? 0) || a.slug.localeCompare(b.slug);
    });
    return active.slice(0, Math.max(0, residentIndexMaxLines));
  }
  async function residentIndex(agentId) {
    if (!isRecallEnabled(agentId)) return null;
    const selected = await residentItems(agentId);
    if (!selected.length) return null;
    return ["Vera 记忆库常驻索引：", "相关时调用 Vera Memory MCP 的 memory_fetch_detail 展开 [[slug]] 查看详情。",
      ...selected.map((item) => `- [[${item.slug}]] — ${item.description}`)].join("\n");
  }
  async function residentIndexForSession(identity) {
    const session = findSession(identity);
    return state.withSessionLock(session.id, async () => {
      const current = findSession(identity);
      if (Object.hasOwn(current, "residentBlock")) return current.residentBlock;
      const selected = isRecallEnabled(identity.agentId) ? await residentItems(identity.agentId) : [];
      const residentBlock = selected.length
        ? ["Vera 记忆库常驻索引：", "相关时调用 Vera Memory MCP 的 memory_fetch_detail 展开 [[slug]] 查看详情。",
            ...selected.map((item) => `- [[${item.slug}]] — ${item.description}`)].join("\n")
        : null;
      store.update("memoryRecallSessions", current.id, {
        residentBlock,
        residentSlugs: selected.map((item) => item.slug),
        deliveredSlugs: [...new Set([...(current.deliveredSlugs ?? []), ...selected.map((item) => item.slug)])],
        updatedAt: now(),
      });
      return residentBlock;
    });
  }
  return {
    ensureSession, resetSession, residentIndex, residentIndexForSession,
    search, searchForInjection, fetchMore, fetchDetail,
    getPin, setPinned, recordUserEdit, listSignals: state.listSignals,
    setResidentIndexMaxLines: (value) => { residentIndexMaxLines = value; },
    setInjectionTokenBudget: (value) => { injectionTokenBudget = value; },
  };
}
