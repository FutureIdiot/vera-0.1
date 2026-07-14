import { AdapterError } from "../core/errors.js";

function singleEnum(value) {
  return { type: "string", enum: [value] };
}

function factSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["subject", "relation", "qualifiers", "value"],
    properties: {
      subject: { type: "string" },
      relation: { type: "string" },
      qualifiers: { type: "array", items: { type: "string" } },
      value: { type: "string" },
    },
  };
}

function writingVariant(action, targetKey) {
  const properties = {
    action: singleEnum(action),
    evidenceMessageIds: { type: "array", items: { type: "string" } },
    fact: factSchema(),
    type: { type: "string" },
    description: { type: "string" },
    content: { type: "string" },
  };
  if (action === "create") properties.suggestedSlug = { type: "string" };
  if (targetKey) properties[targetKey] = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

function archiveVariant(targetKey) {
  const properties = {
    action: singleEnum("archive"),
    evidenceMessageIds: { type: "array", items: { type: "string" } },
    [targetKey]: { type: "string" },
  };
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

// Codex structured output uses the strict Responses schema subset. Keep every
// object closed and every listed property required; split optional targets into
// variants. The source schema is still checked so a missing gateway contract
// cannot silently fall back to this projection.
export function projectCodexDigestSchema(source) {
  if (!source || source.type !== "object" || !source.properties?.proposals) {
    throw new AdapterError("executor_unavailable", "Codex memory digest schema is unavailable");
  }
  const variants = [writingVariant("create")];
  for (const action of ["update", "supersede"]) {
    variants.push(writingVariant(action, "targetFactId"), writingVariant(action, "targetMemorySlug"));
  }
  variants.push(archiveVariant("targetFactId"), archiveVariant("targetMemorySlug"));
  variants.push({
    type: "object",
    additionalProperties: false,
    required: ["action", "evidenceMessageIds", "skipReason"],
    properties: {
      action: singleEnum("skip"),
      evidenceMessageIds: { type: "array", items: { type: "string" } },
      skipReason: {
        type: "string",
        enum: ["no_reusable_fact", "unsupported_inference", "ambiguous_match", "duplicate_in_job"],
      },
    },
  });
  return {
    type: "object",
    additionalProperties: false,
    required: ["proposals"],
    properties: {
      proposals: { type: "array", items: { anyOf: variants } },
    },
  };
}
