import test from "node:test";
import assert from "node:assert/strict";
import { MEMORY_DREAM_OUTPUT_JSON_SCHEMA } from "../../src/memory/memory-dream-proposals.js";
import { normalizeCodexDreamProposals, projectCodexDreamSchema } from "../../src/adapters/codex-dream-schema.js";

function assertStrictObjects(value) {
  if (!value || typeof value !== "object") return;
  if (value.type === "object") {
    assert.equal(value.additionalProperties, false);
    assert.deepEqual([...value.required].sort(), Object.keys(value.properties).sort());
  }
  for (const child of Object.values(value)) assertStrictObjects(child);
}

test("Codex Dream transport schema closes every object and round-trips merge versions", () => {
  const schema = projectCodexDreamSchema(MEMORY_DREAM_OUTPUT_JSON_SCHEMA);
  assertStrictObjects(schema);
  const merge = schema.properties.proposals.items.anyOf.find((item) => item.properties.action.enum[0] === "merge");
  assert.equal(merge.properties.sourceVersions.type, "array");
  const normalized = normalizeCodexDreamProposals([{
    action: "merge", targetSlug: "alpha", targetVersion: "v1", sourceSlugs: ["alpha", "beta"],
    sourceVersions: [{ slug: "alpha", version: "v1" }, { slug: "beta", version: "v2" }],
    type: "rule", description: "Merged", content: "Merged.",
  }]);
  assert.deepEqual(normalized[0].sourceVersions, { alpha: "v1", beta: "v2" });
});
