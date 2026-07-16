import test from "node:test";
import assert from "node:assert/strict";
import { planDreamOperations, validateDreamProposals } from "../../src/memory/memory-dream-proposals.js";
import { VERA_MARKDOWN_CAPABILITIES } from "../../src/memory/memory-provider-capabilities.js";

const VERSION_A = `sha256:${"a".repeat(64)}`;
const VERSION_B = `sha256:${"b".repeat(64)}`;
const memories = [
  {
    slug: "alpha-rule", version: VERSION_A, type: "rule", description: "Alpha",
    status: "active", content: "Use Alpha with [[outside-rule]].",
    sources: [{ kind: "manual", actor: "user", capturedAt: "2026-07-15T00:00:00.000Z" }],
  },
  {
    slug: "beta-rule", version: VERSION_B, type: "rule", description: "Beta",
    status: "active", content: "Use Alpha with.",
    sources: [{ kind: "message", spaceId: "spc_one", messageId: "msg_one" }],
  },
];

test("Dream merge validates frozen versions and preserves outgoing links and sources", () => {
  const proposals = validateDreamProposals({
    jobId: "mdr_one",
    memories,
    proposals: [{
      action: "merge", targetSlug: "alpha-rule", targetVersion: VERSION_A,
      sourceSlugs: ["alpha-rule", "beta-rule"],
      sourceVersions: { "alpha-rule": VERSION_A, "beta-rule": VERSION_B },
      type: "rule", description: "Combined", content: "Use Alpha with [[outside-rule]].",
    }],
  });
  const planned = planDreamOperations({
    agentId: "agt_test01", jobId: "mdr_one", proposals, memories,
    requestedAt: "2026-07-15T00:00:00.000Z",
  });
  assert.equal(planned.length, 2);
  assert.equal(planned[0].operation.kind, "update");
  assert.equal(planned[0].operation.patch.sources.length, 2);
  assert.equal(planned[1].operation.kind, "archive");
  assert.equal(planned[1].operation.slug, "beta-rule");
});

test("Dream rejects the entire proposal set before planning when a merge drops an outgoing link", () => {
  assert.throws(() => validateDreamProposals({
    jobId: "mdr_bad",
    memories,
    proposals: [
      {
        action: "merge", targetSlug: "alpha-rule", targetVersion: VERSION_A,
        sourceSlugs: ["alpha-rule", "beta-rule"],
        sourceVersions: { "alpha-rule": VERSION_A, "beta-rule": VERSION_B },
        type: "rule", description: "Combined", content: "Use Alpha with.",
      },
    ],
  }), (error) => error.code === "invalid_request" && /preserve outgoing link/.test(error.message));
});

test("Dream rejects factual rewrites, unproven merges, and archive without replacement", () => {
  assert.throws(() => validateDreamProposals({
    memories,
    proposals: [{
      action: "update", targetSlug: "alpha-rule", targetVersion: VERSION_A,
      content: "Use a completely different rule.",
    }],
  }), /cannot change factual content/);
  assert.throws(() => validateDreamProposals({
    memories,
    proposals: [{
      action: "merge", targetSlug: "alpha-rule", targetVersion: VERSION_A,
      sourceSlugs: ["alpha-rule", "beta-rule"],
      sourceVersions: { "alpha-rule": VERSION_A, "beta-rule": VERSION_B },
      type: "rule", description: "Combined", content: "Invented replacement.",
    }],
  }), /cannot invent|explicit duplicate/);
  assert.throws(() => validateDreamProposals({
    memories,
    proposals: [{ action: "archive", targetSlug: "alpha-rule", targetVersion: VERSION_A }],
  }), /requires replacementSlug/);
  assert.throws(() => validateDreamProposals({
    memories: [memories[0], { ...memories[1], content: "Unrelated fact." }],
    proposals: [{
      action: "archive", targetSlug: "alpha-rule", targetVersion: VERSION_A,
      replacementSlug: "beta-rule",
    }],
  }), /explicit duplicate/);
});

test("vera.markdown declares separate Digest and Dream operation capabilities", () => {
  assert.deepEqual(
    VERA_MARKDOWN_CAPABILITIES.digest.ingest,
    ["create", "update", "supersede", "archive"],
  );
  assert.deepEqual(
    VERA_MARKDOWN_CAPABILITIES.dream.maintenance,
    ["update", "merge", "archive", "structureRewrite"],
  );
  assert.throws(() => validateDreamProposals({
    memories,
    providerCapabilities: { dream: { maintenance: ["archive"] } },
    proposals: [{
      action: "update", targetSlug: "alpha-rule", targetVersion: VERSION_A,
      description: "Alpha",
    }],
  }), (error) => error.code === "memory_provider_unsupported");
});
