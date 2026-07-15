import { createHash } from "node:crypto";
import {
  buildMemoryProjections, buildMemoryTfidfModel, computeMemoryBm25Scores,
  estimateMemoryTokens, extractMemoryLinks, memoryCosine, memoryTokenJaccard,
  normalizeMemoryText, singularizeMemoryToken, tokenizeMemoryText,
} from "./memory-retrieval-text.js";

export { estimateMemoryTokens } from "./memory-retrieval-text.js";
export const MEMORY_PIPELINE_VERSION = "m4-r1";

const KNOWN_TYPES = new Set(["project_rule", "architecture", "workflow", "preference", "correction", "bug", "decision", "open_question"]);
const DEFAULTS = Object.freeze({
  seedWidth: 24, maxHop: 2, maxCandidates: 128, forwardEdgeStrength: 1, reverseEdgeStrength: 0.85,
  hopDecay: 0.70, bm25K1: 1.2, bm25B: 0.75, semanticCosineThreshold: 0.92,
  semanticJaccardThreshold: 0.75, redundancyStart: 0.75, redundancyCap: 0.20,
  softQuotaScale: 0.25, softQuotaCap: 0.12, bodyProjectionCodePoints: 320,
  explorationCap: 0.02,
  defaultTokenBudget: 1200, minTokenBudget: 64, maxTokenBudget: 1200,
  blockHeader: "Vera Memory recall:\n", cursorHint: "\nMore memories available via memory_fetch_more.",
});
const WEIGHTS = Object.freeze({ queryRelevance: 0.45, graphProximity: 0.20, derivedWeight: 0.15, intersectionConfidence: 0.15, typeFit: 0.05 });
const clamp01 = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
const round6 = (value) => Math.round((Number.isFinite(value) ? value : 0) * 1e6) / 1e6;
const compareText = (a, b) => String(a) === String(b) ? 0 : String(a) < String(b) ? -1 : 1;
const confidence = (size) => round6(Math.log2(1 + Math.min(Math.max(size, 1), 4)) / Math.log2(5));
const directionId = (slug) => `dir_${createHash("sha256").update(slug).digest("hex").slice(0, 12)}`;
const baseScore = (s) => round6(Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + weight * s[key], 0));
const factId = (map, slug) => map instanceof Map ? map.get(slug) : map?.[slug];
const mapValue = (map, slug) => map instanceof Map ? map.get(slug) : map?.[slug];

function explorationValue(seed, slug, cap) {
  if (seed === undefined || seed === null || !Number.isFinite(cap) || cap <= 0) return 0;
  const digest = createHash("sha256").update(`${String(seed)}\0${slug}`).digest();
  return round6((digest.readUInt32BE(0) / 0xffffffff) * cap);
}

function typeInfo(type, queryTokens) {
  const exact = String(type).toLowerCase().split(/[_/-]+/u).filter(Boolean)
    .map(singularizeMemoryToken).some((token) => queryTokens.has(token));
  return { typeFit: exact ? 1 : 0.5, quotaGroup: exact ? String(type) : "other", known: KNOWN_TYPES.has(String(type)) };
}

function makeCandidate(source, keywordSeeds, vectorSeeds, queryTokens, config) {
  const type = typeInfo(source.memory.type, queryTokens);
  const projection = buildMemoryProjections(source.memory, config.bodyProjectionCodePoints);
  const wrapped = (text) => estimateMemoryTokens(`- [[${source.memory.slug}]] (${source.memory.type}) ${text}\n`);
  return {
    memory: source.memory, projections: projection, typeKnown: type.known, quotaGroup: type.quotaGroup,
    compactTokenCost: wrapped(projection.compact), standardTokenCost: wrapped(projection.standard),
    directKeyword: keywordSeeds.has(source.memory.slug), directVector: vectorSeeds.has(source.memory.slug),
    directionEvidence: new Map(), mergedSlugs: [source.memory.slug],
    scores: { queryRelevance: source.queryRelevance, graphProximity: 0, derivedWeight: source.derivedWeight, intersectionConfidence: 0, typeFit: type.typeFit, baseScore: 0 },
  };
}

function buildAdjacency(memories, config) {
  const graph = new Map(memories.map((memory) => [memory.slug, new Map()]));
  for (const memory of memories) for (const linked of extractMemoryLinks(memory)) {
    if (!graph.has(linked) || linked === memory.slug) continue;
    graph.get(memory.slug).set(linked, Math.max(graph.get(memory.slug).get(linked) ?? 0, config.forwardEdgeStrength));
    graph.get(linked).set(memory.slug, Math.max(graph.get(linked).get(memory.slug) ?? 0, config.reverseEdgeStrength));
  }
  return graph;
}

function expandGraph({ seeds, bySlug, keywordSeeds, vectorSeeds, queryTokens, memories, config }) {
  const graph = buildAdjacency(memories, config);
  const expanded = new Map();
  const ensure = (slug) => {
    if (!expanded.has(slug) && expanded.size < config.maxCandidates) {
      expanded.set(slug, makeCandidate(bySlug.get(slug), keywordSeeds, vectorSeeds, queryTokens, config));
    }
    return expanded.get(slug);
  };
  for (const seedSlug of seeds) {
    const id = directionId(seedSlug);
    const seed = ensure(seedSlug);
    if (!seed) break;
    seed.directionEvidence.set(id, { seedSlug, hop: 0, pathStrength: 0.5, path: [seedSlug] });
    const queue = [{ slug: seedSlug, hop: 0, product: 1, path: [seedSlug] }];
    while (queue.length) {
      const current = queue.shift();
      if (current.hop >= config.maxHop) continue;
      for (const [nextSlug, edge] of [...graph.get(current.slug)].sort(([a], [b]) => compareText(a, b))) {
        if (current.path.includes(nextSlug)) continue;
        const hop = current.hop + 1, product = current.product * edge;
        const strength = round6(product * config.hopDecay ** (hop - 1));
        const next = ensure(nextSlug);
        if (!next) continue;
        const prior = next.directionEvidence.get(id);
        if (!prior || strength > prior.pathStrength || (strength === prior.pathStrength && hop < prior.hop)) {
          next.directionEvidence.set(id, { seedSlug, hop, pathStrength: strength, path: [...current.path, nextSlug] });
        }
        queue.push({ slug: nextSlug, hop, product, path: [...current.path, nextSlug] });
      }
    }
  }
  for (const candidate of expanded.values()) {
    const paths = [...candidate.directionEvidence.values()].filter((item) => item.hop > 0);
    candidate.scores.graphProximity = round6(paths.length ? Math.max(...paths.map((item) => item.pathStrength)) : 0.5);
    candidate.scores.intersectionConfidence = confidence(candidate.directionEvidence.size);
    candidate.scores.baseScore = baseScore(candidate.scores);
  }
  return expanded;
}

function sameCluster(left, right, facts, vectors, config) {
  const a = factId(facts, left.memory.slug), b = factId(facts, right.memory.slug);
  if (a && b && a === b) return true;
  if (normalizeMemoryText(left.projections.standard) === normalizeMemoryText(right.projections.standard)) return true;
  const compatible = left.memory.type === right.memory.type || !left.typeKnown || !right.typeKnown;
  return compatible && memoryCosine(vectors.get(left.memory.slug), vectors.get(right.memory.slug)) >= config.semanticCosineThreshold
    && memoryTokenJaccard(left.projections.standard, right.projections.standard) >= config.semanticJaccardThreshold;
}

function deduplicate(candidates, facts, vectors, config) {
  const leaders = [];
  const ordered = [...candidates].sort((a, b) => b.scores.baseScore - a.scores.baseScore || compareText(a.memory.slug, b.memory.slug));
  for (const candidate of ordered) {
    const cluster = leaders.find((item) => sameCluster(item.leader, candidate, facts, vectors, config));
    if (cluster) cluster.members.push(candidate); else leaders.push({ leader: candidate, members: [candidate] });
  }
  return leaders.map(({ members }) => {
    const representative = [...members].sort((a, b) => b.scores.typeFit - a.scores.typeFit
      || b.scores.baseScore - a.scores.baseScore || a.standardTokenCost - b.standardTokenCost || compareText(a.memory.slug, b.memory.slug))[0];
    const evidence = new Map();
    for (const member of members) for (const [id, item] of member.directionEvidence) {
      const prior = evidence.get(id);
      if (!prior || item.pathStrength > prior.pathStrength || (item.pathStrength === prior.pathStrength && item.hop < prior.hop)) evidence.set(id, item);
    }
    const scores = { ...representative.scores, intersectionConfidence: confidence(evidence.size) };
    scores.baseScore = baseScore(scores);
    return { ...representative, directKeyword: members.some((item) => item.directKeyword), directVector: members.some((item) => item.directVector),
      directionEvidence: evidence, scores, mergedSlugs: members.map((item) => item.memory.slug).sort(compareText) };
  });
}

function redundancy(candidate, selected, vectors, config) {
  const similarity = selected.reduce((max, item) => Math.max(max, memoryCosine(vectors.get(candidate.memory.slug), vectors.get(item.memory.slug))), 0);
  if (similarity <= config.redundancyStart) return 0;
  const scaled = (similarity - config.redundancyStart) / (config.semanticCosineThreshold - config.redundancyStart);
  return round6(Math.min(config.redundancyCap, config.redundancyCap * scaled ** 2));
}

function rerank(candidates, vectors, config) {
  const groups = [...new Set(candidates.map((item) => item.quotaGroup))].sort(compareText);
  const totalTarget = groups.reduce((sum, group) => sum + (group === "other" ? 1 : 3), 0);
  const targets = new Map(groups.map((group) => [group, (group === "other" ? 1 : 3) / totalTarget]));
  const ordered = [], remaining = new Set(candidates), groupTokens = new Map();
  let used = 0;
  const compare = (a, b) => b.marginal - a.marginal || b.item.scores.baseScore - a.item.scores.baseScore
    || b.item.scores.queryRelevance - a.item.scores.queryRelevance || b.item.scores.graphProximity - a.item.scores.graphProximity
    || a.item.compactTokenCost - b.item.compactTokenCost || compareText(a.item.memory.slug, b.item.memory.slug);
  while (remaining.size) {
    const choices = [];
    for (const item of remaining) {
      const cost = item.standardTokenCost, projected = used + cost;
      const excess = Math.max(0, ((groupTokens.get(item.quotaGroup) ?? 0) + cost) / projected - targets.get(item.quotaGroup));
      const quota = round6(Math.min(config.softQuotaCap, config.softQuotaScale * excess));
      const duplicate = redundancy(item, ordered, vectors, config);
      choices.push({ item, cost, quota, duplicate, marginal: round6(item.scores.baseScore - duplicate - quota) });
    }
    if (!choices.length) break;
    const winner = choices.sort(compare)[0];
    remaining.delete(winner.item); used += winner.cost;
    groupTokens.set(winner.item.quotaGroup, (groupTokens.get(winner.item.quotaGroup) ?? 0) + winner.cost);
    winner.item.scores = { ...winner.item.scores, redundancyPenalty: winner.duplicate, softQuotaPenalty: winner.quota, marginalScore: winner.marginal };
    ordered.push(winner.item);
  }
  return { ordered, targets };
}

function packPage(ordered, budget, config) {
  const selected = [];
  let contentTokens = 0;
  const overhead = estimateMemoryTokens(config.blockHeader) + estimateMemoryTokens(config.cursorHint);
  for (const item of ordered) {
    const level = overhead + contentTokens + item.standardTokenCost <= budget ? "standard"
      : overhead + contentTokens + item.compactTokenCost <= budget ? "compact" : null;
    if (!level) break;
    selected.push({ item, level, tokenCost: item[`${level}TokenCost`] });
    contentTokens += item[`${level}TokenCost`];
  }
  return { selected, selectedCount: selected.length, remaining: ordered.slice(selected.length), contentTokens };
}

function publicCandidate(item, rank, level = "standard", tokenCost = item.standardTokenCost) {
  const directions = [...item.directionEvidence].sort(([a], [b]) => compareText(a, b));
  const reasons = [];
  if (item.directKeyword) reasons.push({ kind: "keyword" });
  if (item.directVector) reasons.push({ kind: "vector" });
  for (const [id, evidence] of directions) if (evidence.hop > 0) reasons.push({ kind: "graph", directionId: id, hop: evidence.hop });
  const primary = [...directions].sort(([aId, a], [bId, b]) => a.hop - b.hop || b.pathStrength - a.pathStrength || compareText(aId, bId))[0]?.[0] ?? null;
  return { rank, slug: item.memory.slug, version: item.memory.version ?? null, type: item.memory.type,
    projection: item.projections[level], projectionLevel: level, projectionOptions: { ...item.projections },
    reasons, directionIds: directions.map(([id]) => id), primaryDirectionId: primary, mergedSlugs: item.mergedSlugs,
    compactTokenCost: item.compactTokenCost, standardTokenCost: item.standardTokenCost, tokenCost,
    quotaGroup: item.quotaGroup, scores: Object.fromEntries(Object.entries(item.scores).map(([key, value]) => [key, round6(value)])) };
}

export function rankMemoryCandidates({
  query, memories, factIdsBySlug = null, derivedWeightsBySlug = null,
  explorationSeed = null, tokenBudget, config: overrides = {},
} = {}) {
  if (typeof query !== "string" || !normalizeMemoryText(query)) throw new TypeError("query must be a non-empty string");
  if (!Array.isArray(memories)) throw new TypeError("memories must be an array");
  const config = { ...DEFAULTS, ...overrides }, budget = tokenBudget ?? config.defaultTokenBudget;
  if (!Number.isInteger(budget) || budget < config.minTokenBudget || budget > config.maxTokenBudget) throw new RangeError(`tokenBudget must be an integer from ${config.minTokenBudget} to ${config.maxTokenBudget}`);
  const active = memories.filter((item) => item && typeof item.slug === "string" && (item.status ?? "active") === "active")
    .map((item) => ({ ...item, type: String(item.type ?? "unknown"), description: String(item.description ?? "") })).sort((a, b) => compareText(a.slug, b.slug));
  const emptyAudit = { pipelineVersion: MEMORY_PIPELINE_VERSION, estimator: "vera-utf8-v1", tokenBudget: budget, usedTokens: 0, seedSlugs: [], omittedSlugs: [], counts: { active: 0, seeds: 0, expanded: 0, deduplicated: 0, selected: 0 } };
  if (!active.length) return { candidates: [], orderedCandidates: [], selectedCount: 0, directions: [], audit: emptyAudit };
  const texts = active.map((item) => `${item.description}\n${item.content ?? ""}`), tokens = texts.map((text) => tokenizeMemoryText(text));
  const rawKeyword = computeMemoryBm25Scores(tokens, tokenizeMemoryText(query), config), maxKeyword = Math.max(0, ...rawKeyword);
  const keyword = rawKeyword.map((score) => round6(maxKeyword ? score / maxKeyword : 0));
  const tfidf = buildMemoryTfidfModel(texts), queryVector = tfidf.vectorFor(query);
  const vector = tfidf.documentVectors.map((item) => round6(memoryCosine(queryVector, item)));
  const bySlug = new Map(active.map((memory, index) => {
    const stableWeight = clamp01(Number(mapValue(derivedWeightsBySlug, memory.slug)));
    const derivedWeight = round6(clamp01(stableWeight + explorationValue(explorationSeed, memory.slug, config.explorationCap)));
    return [memory.slug, { memory, queryRelevance: round6(Math.max(keyword[index], vector[index])), derivedWeight }];
  }));
  const top = (scores) => active.map((item, index) => ({ slug: item.slug, score: scores[index] })).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || compareText(a.slug, b.slug)).slice(0, config.seedWidth);
  const keywordTop = top(keyword), vectorTop = top(vector), keywordSeeds = new Set(keywordTop.map((item) => item.slug)), vectorSeeds = new Set(vectorTop.map((item) => item.slug));
  const seeds = [...new Set([...keywordSeeds, ...vectorSeeds])].sort((a, b) => bySlug.get(b).queryRelevance - bySlug.get(a).queryRelevance || compareText(a, b));
  const expanded = expandGraph({ seeds, bySlug, keywordSeeds, vectorSeeds, queryTokens: new Set(tokenizeMemoryText(query, { singular: true })), memories: active, config });
  const projectionModel = buildMemoryTfidfModel([...expanded.values()].map((item) => item.projections.standard));
  const vectors = new Map([...expanded.values()].map((item, index) => [item.memory.slug, projectionModel.documentVectors[index]]));
  const deduped = deduplicate([...expanded.values()], factIdsBySlug, vectors, config);
  const ranked = rerank(deduped, vectors, config), page = packPage(ranked.ordered, budget, config);
  const usedTokens = page.selectedCount ? estimateMemoryTokens(config.blockHeader) + page.contentTokens + (page.remaining.length ? estimateMemoryTokens(config.cursorHint) : 0) : 0;
  const directionMap = new Map();
  for (const item of deduped) for (const [id, evidence] of item.directionEvidence) {
    const direction = directionMap.get(id) ?? { id, seedSlug: evidence.seedSlug, candidateSlugs: [] };
    direction.candidateSlugs.push(item.memory.slug); directionMap.set(id, direction);
  }
  const directions = [...directionMap.values()].map((item) => ({ ...item, candidateSlugs: [...new Set(item.candidateSlugs)].sort(compareText) })).sort((a, b) => compareText(a.id, b.id));
  const orderedCandidates = ranked.ordered.map((item, index) => publicCandidate(item, index + 1));
  const candidates = page.selected.map(({ item, level, tokenCost }, index) => publicCandidate(item, index + 1, level, tokenCost));
  return { candidates, orderedCandidates, selectedCount: page.selectedCount, directions,
    audit: { pipelineVersion: MEMORY_PIPELINE_VERSION, estimator: "vera-utf8-v1", tokenBudget: budget, usedTokens, weights: { ...WEIGHTS }, seedSlugs: seeds,
      keywordSeedSlugs: keywordTop.map((item) => item.slug), vectorSeedSlugs: vectorTop.map((item) => item.slug),
      targetShares: Object.fromEntries([...ranked.targets].map(([key, value]) => [key, round6(value)])), omittedSlugs: page.remaining.map((item) => item.memory.slug),
      counts: { active: active.length, seeds: seeds.length, expanded: expanded.size, deduplicated: deduped.length, selected: page.selectedCount } } };
}
