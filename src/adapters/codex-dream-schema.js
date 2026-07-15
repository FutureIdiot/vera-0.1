import { AdapterError } from "../core/errors.js";

const string = () => ({ type: "string" });
const action = (value) => ({ type: "string", enum: [value] });
function object(properties) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}
function target(kind, extra = {}) {
  return object({ action: action(kind), targetSlug: string(), targetVersion: string(), ...extra });
}

export function projectCodexDreamSchema(source) {
  if (!source || source.type !== "object" || !source.properties?.proposals) {
    throw new AdapterError("executor_unavailable", "Codex memory Dream schema is unavailable");
  }
  const variants = [target("keep")];
  for (let mask = 1; mask < 8; mask += 1) {
    const extra = {};
    if (mask & 1) extra.type = string();
    if (mask & 2) extra.description = string();
    if (mask & 4) extra.content = string();
    variants.push(target("update", extra));
  }
  variants.push(target("merge", {
    sourceSlugs: { type: "array", items: string() },
    sourceVersions: {
      type: "array",
      items: object({ slug: string(), version: string() }),
    },
    type: string(), description: string(), content: string(),
  }));
  variants.push(target("archive"));
  variants.push(target("archive", { replacementSlug: string() }));
  return object({ proposals: { type: "array", items: { anyOf: variants } } });
}

export function normalizeCodexDreamProposals(proposals) {
  if (!Array.isArray(proposals)) return proposals;
  return proposals.map((proposal) => {
    if (proposal?.action !== "merge" || !Array.isArray(proposal.sourceVersions)) return proposal;
    return {
      ...proposal,
      sourceVersions: Object.fromEntries(proposal.sourceVersions.map((item) => [item.slug, item.version])),
    };
  });
}
