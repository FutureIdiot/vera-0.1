import test from "node:test";
import assert from "node:assert/strict";
import {
  M3_PIPELINE_VERSION,
  estimateMemoryTokens,
  rankMemoryCandidates,
} from "../../src/memory/memory-retrieval-ranking.js";

function memory(slug, overrides = {}) {
  return {
    slug,
    version: `sha256:${slug}`,
    type: "decision",
    description: `${slug} description`,
    content: `${slug} authoritative body`,
    status: "active",
    ...overrides,
  };
}

function bySlug(result, slug) {
  return result.candidates.find((candidate) => candidate.slug === slug);
}

test("m3-r1 token estimator is deterministic over NFKC UTF-8 bytes", () => {
  assert.equal(M3_PIPELINE_VERSION, "m3-r1");
  assert.equal(estimateMemoryTokens("Ａ"), 1, "full-width A normalizes to one ASCII byte");
  assert.equal(estimateMemoryTokens("你好"), 2);
  assert.equal(estimateMemoryTokens(""), 1);
});

test("BM25 and char-trigram channels are equal-width, deterministic, and exclude archived Memory", () => {
  const memories = [
    memory("zeta", { description: "console layout unrelated" }),
    memory("alpha", { description: "project rule keeps mobile first" }),
    memory("archived-hit", { description: "project rule archived", status: "archived" }),
  ];
  const first = rankMemoryCandidates({ query: "project rules", memories });
  const second = rankMemoryCandidates({ query: "project rules", memories: [...memories].reverse() });

  assert.equal(first.candidates[0].slug, "alpha");
  assert.ok(first.candidates[0].reasons.some((reason) => reason.kind === "keyword"));
  assert.ok(first.candidates[0].reasons.some((reason) => reason.kind === "vector"));
  assert.equal(bySlug(first, "archived-hit"), undefined);
  assert.deepEqual(first, second, "input order must not affect ranking or audit");
  assert.ok(first.audit.keywordSeedSlugs.length <= 24);
  assert.ok(first.audit.vectorSeedSlugs.length <= 24);
});

test("multiple seed directions increase confidence once each while repeated paths in one direction do not", () => {
  const result = rankMemoryCandidates({
    query: "orion",
    memories: [
      memory("seed-a", {
        description: "orion alpha",
        content: "[[target]] [[bridge]]",
      }),
      memory("seed-b", {
        description: "orion beta",
        content: "[[target]]",
      }),
      memory("bridge", {
        description: "intermediate connector",
        content: "[[target]]",
      }),
      memory("target", {
        description: "final operating constraint",
        content: "target body",
      }),
    ],
  });
  const target = bySlug(result, "target");
  assert.ok(target);
  assert.equal(target.directionIds.length, 2, "seed-a's direct and two-hop paths remain one direction");
  assert.equal(target.scores.graphProximity, 1, "best same-direction path wins graph proximity");
  assert.equal(target.scores.intersectionConfidence, 0.682606);
  assert.equal(target.reasons.filter((reason) => reason.kind === "graph").length, 2);
});

test("graph expansion crosses Memory types when the linked node has no direct query hit", () => {
  const result = rankMemoryCandidates({
    query: "orion",
    memories: [
      memory("decision-seed", { type: "decision", description: "orion launch choice", content: "[[architecture-target]]" }),
      memory("architecture-target", { type: "architecture", description: "single private gateway boundary", content: "deployment topology" }),
    ],
  });
  const target = bySlug(result, "architecture-target");
  assert.ok(target);
  assert.equal(target.type, "architecture");
  assert.ok(target.reasons.some((reason) => reason.kind === "graph" && reason.hop === 1));
  assert.equal(target.reasons.some((reason) => reason.kind === "keyword"), false);
});

test("fact identity and exact normalized projection deduplicate without transitive duplicate output", () => {
  const result = rankMemoryCandidates({
    query: "deployment boundary",
    memories: [
      memory("fact-old", { description: "deployment boundary old wording" }),
      memory("fact-new", { description: "deployment boundary corrected wording" }),
      memory("same-a", { description: "Use one gateway only", content: "shared deployment boundary authority" }),
      memory("same-b", { description: "  use   one gateway only  ", content: "shared deployment boundary authority" }),
    ],
    factIdsBySlug: {
      "fact-old": "fact_1",
      "fact-new": "fact_1",
    },
  });
  const factRepresentative = result.candidates.find((candidate) => candidate.mergedSlugs.includes("fact-old"));
  const exactRepresentative = result.candidates.find((candidate) => candidate.mergedSlugs.includes("same-a"));
  assert.deepEqual(factRepresentative.mergedSlugs, ["fact-new", "fact-old"]);
  assert.deepEqual(exactRepresentative.mergedSlugs, ["same-a", "same-b"]);
  assert.equal(result.audit.counts.deduplicated, 2);
});

test("soft quota never hard-caps five independent requested rule Memories", () => {
  const rules = ["alpha", "bravo", "charlie", "delta", "echo"].map((name) => memory(`rule-${name}`, {
    type: "project_rule",
    description: `project rule ${name} independent requirement`,
    content: `${name} has a distinct operational consequence`,
  }));
  const result = rankMemoryCandidates({
    query: "project rules needed now",
    memories: [
      ...rules,
      memory("other-note", { type: "preference", description: "project background preference" }),
    ],
  });
  const returnedRules = result.candidates.filter((candidate) => candidate.type === "project_rule");
  assert.equal(returnedRules.length, 5);
  assert.ok(returnedRules.every((candidate) => candidate.quotaGroup === "project_rule"));
  assert.ok(returnedRules.every((candidate) => candidate.scores.softQuotaPenalty <= 0.12));
  assert.equal(result.audit.targetShares.project_rule, 0.75);
});

test("unknown extension type remains eligible with neutral type fit and other quota group", () => {
  const result = rankMemoryCandidates({
    query: "nebula routing",
    memories: [memory("future-memory", {
      type: "future_signal",
      description: "nebula routing requirement",
    })],
  });
  const candidate = bySlug(result, "future-memory");
  assert.ok(candidate);
  assert.equal(candidate.scores.typeFit, 0.5);
  assert.equal(candidate.quotaGroup, "other");
});

test("stain A/B changes neither candidates, scores, directions, nor audit", () => {
  const base = [
    memory("seed", { description: "orion rule", content: "[[linked]]" }),
    memory("linked", { description: "linked constraint" }),
  ];
  const a = rankMemoryCandidates({
    query: "orion",
    memories: base.map((item) => ({ ...item, stains: { agt_a: "#112233" } })),
  });
  const b = rankMemoryCandidates({
    query: "orion",
    memories: base.map((item) => ({ ...item, stains: { agt_b: "#FFEEDD" } })),
  });
  assert.deepEqual(a, b);
  assert.doesNotMatch(JSON.stringify(a), /112233|FFEEDD|stain/iu);
});

test("budget falls back from standard to complete compact projection without truncating it", () => {
  const description = "short independent rule";
  const result = rankMemoryCandidates({
    query: "independent rule",
    tokenBudget: 64,
    memories: [memory("compact-only", {
      type: "project_rule",
      description,
      content: "x".repeat(320),
    })],
  });
  const candidate = bySlug(result, "compact-only");
  assert.ok(candidate);
  assert.equal(candidate.projectionLevel, "compact");
  assert.equal(candidate.projection, description);
  assert.ok(result.audit.usedTokens <= 64);
});

test("orderedCandidates freezes cursor-ready safe projections beyond the selected page", () => {
  const memories = ["a", "b", "c"].map((suffix) => memory(`rule-${suffix}`, {
    type: "project_rule",
    description: `project rule ${suffix} independent requirement`,
    content: `${suffix} body `.repeat(30),
    stains: { agt_hidden: "#123456" },
  }));
  const result = rankMemoryCandidates({ query: "project rules", memories, tokenBudget: 64 });
  const wide = rankMemoryCandidates({ query: "project rules", memories, tokenBudget: 1200 });
  assert.equal(result.selectedCount, 1);
  assert.equal(result.orderedCandidates.length, 3);
  assert.deepEqual(
    result.orderedCandidates,
    wide.orderedCandidates,
    "page budget changes only selectedCount, never the frozen marginal order",
  );
  assert.deepEqual(
    result.audit.omittedSlugs,
    result.orderedCandidates.slice(result.selectedCount).map((candidate) => candidate.slug),
  );
  for (const candidate of result.orderedCandidates) {
    assert.equal(typeof candidate.projectionOptions.compact, "string");
    assert.equal(typeof candidate.projectionOptions.standard, "string");
    assert.match(candidate.version, /^sha256:/u);
  }
  const frozenSnapshot = JSON.stringify(result.orderedCandidates);
  memories[1].description = "edited after ranking";
  memories[1].content = "edited authority";
  assert.equal(JSON.stringify(result.orderedCandidates), frozenSnapshot);
  assert.doesNotMatch(frozenSnapshot, /123456|stain/iu);
});
