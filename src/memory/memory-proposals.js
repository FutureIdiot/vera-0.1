import { createHash } from "node:crypto";
import { ApiError } from "../core/errors.js";

const ACTIONS = new Set(["create", "update", "archive", "supersede", "skip"]);
const PROPOSAL_KEYS = new Set([
  "action", "evidenceMessageIds", "fact", "suggestedSlug", "type",
  "description", "content", "stains", "skipReason", "targetFactId", "targetMemorySlug",
]);
const FACT_KEYS = new Set(["subject", "relation", "qualifiers", "value"]);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TYPE_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const AGENT_PATTERN = /^agt_[a-z0-9]+$/;
const HEX_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const CORRECTION_PATTERN = /(?:纠正|更正|修正|改为|应为|不是.{0,40}而是|不再|作废|取代|correction|correct(?:ed|ion)?|instead|no longer|supersed)/iu;
const SKIP_REASONS = new Set(["no_reusable_fact", "unsupported_inference", "ambiguous_match", "duplicate_in_job"]);

const FACT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "relation", "qualifiers", "value"],
  properties: {
    subject: { type: "string", minLength: 1, pattern: "\\S" },
    relation: { type: "string", minLength: 1, pattern: "\\S" },
    qualifiers: { type: "array", items: { type: "string", minLength: 1, pattern: "\\S" } },
    value: { type: "string", minLength: 1, pattern: "\\S" },
  },
};

const EVIDENCE_JSON_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 64,
  uniqueItems: true,
  items: { type: "string", minLength: 1 },
};

const TARGET_JSON_SCHEMA = {
  oneOf: [
    {
      required: ["targetFactId"],
      properties: { targetFactId: { type: "string", pattern: "^fct_[a-f0-9]{16,64}$" } },
    },
    {
      required: ["targetMemorySlug"],
      properties: { targetMemorySlug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" } },
    },
  ],
};

const TARGET_PROPERTIES = {
  targetFactId: { type: "string", pattern: "^fct_[a-f0-9]{16,64}$" },
  targetMemorySlug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
};

const WRITING_PROPERTIES = {
  action: { type: "string" },
  evidenceMessageIds: EVIDENCE_JSON_SCHEMA,
  fact: FACT_JSON_SCHEMA,
  type: { type: "string", pattern: "^[a-z0-9]+(?:[-_][a-z0-9]+)*$" },
  description: { type: "string", minLength: 1, pattern: "^(?=.*\\S)[^\\r\\n]+$" },
  content: { type: "string", minLength: 1, pattern: "\\S" },
  stains: {
    type: "object",
    additionalProperties: false,
    patternProperties: { "^agt_[a-z0-9]+$": { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" } },
  },
};

function writingProposalSchema(action, extra = {}) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action", "evidenceMessageIds", "fact", "type", "description", "content", ...(extra.required ?? [])],
    properties: {
      ...WRITING_PROPERTIES,
      action: { const: action },
      ...(extra.properties ?? {}),
    },
    ...(extra.oneOf ? { oneOf: extra.oneOf } : {}),
  };
}

// Provider structured-output schema. The descriptive schema above remains the
// compact contract shown in prompts/tests; this object is a real JSON Schema and
// is still followed by validateDigestProposals as the authority before writes.
export const MEMORY_DIGEST_OUTPUT_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      maxItems: 32,
      items: {
        oneOf: [
          writingProposalSchema("create", {
            required: ["suggestedSlug"],
            properties: { suggestedSlug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" } },
          }),
          writingProposalSchema("update", { properties: TARGET_PROPERTIES, oneOf: TARGET_JSON_SCHEMA.oneOf }),
          writingProposalSchema("supersede", { properties: TARGET_PROPERTIES, oneOf: TARGET_JSON_SCHEMA.oneOf }),
          {
            type: "object",
            additionalProperties: false,
            required: ["action", "evidenceMessageIds"],
            properties: {
              action: { const: "archive" },
              evidenceMessageIds: EVIDENCE_JSON_SCHEMA,
              targetFactId: { type: "string", pattern: "^fct_[a-f0-9]{16,64}$" },
              targetMemorySlug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
            },
            ...TARGET_JSON_SCHEMA,
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["action", "skipReason"],
            properties: {
              action: { const: "skip" },
              evidenceMessageIds: {
                type: "array",
                uniqueItems: true,
                items: { type: "string", minLength: 1 },
              },
              skipReason: { enum: [...SKIP_REASONS] },
            },
          },
        ],
      },
    },
  },
});

function invalid(message) { return new ApiError("invalid_request", message); }
function hash(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

export function normalizeFactText(value) {
  if (typeof value !== "string" || !value.trim()) throw invalid("fact slots must be non-empty strings");
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

function normalizeQualifiers(value) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw invalid("fact.qualifiers must be an array of non-empty strings");
  }
  return [...new Set(value.map(normalizeFactText))].sort();
}

export function deriveFactHashes(agentId, fact) {
  if (!fact || typeof fact !== "object" || Array.isArray(fact)) throw invalid("fact must be an object");
  for (const key of Object.keys(fact)) if (!FACT_KEYS.has(key)) throw invalid(`unknown fact field: ${key}`);
  for (const key of FACT_KEYS) if (!(key in fact)) throw invalid(`fact.${key} is required`);
  const normalized = {
    subject: normalizeFactText(fact.subject),
    relation: normalizeFactText(fact.relation),
    qualifiers: normalizeQualifiers(fact.qualifiers),
    value: normalizeFactText(fact.value),
  };
  return {
    fact: normalized,
    factAddressHash: hash(JSON.stringify([normalizeFactText(agentId), normalized.subject, normalized.relation, normalized.qualifiers])),
    factValueHash: hash(normalized.value),
  };
}

function assertSlug(value, field) {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value)) throw invalid(`${field} must be a kebab-case slug`);
}

function validateContent(value) {
  if (typeof value !== "string" || !value.trim()) throw invalid("proposal content must have reusable content");
  for (const match of value.matchAll(/\[\[([^\]]+)\]\]/g)) assertSlug(match[1], "Memory link");
  if ((value.match(/\[\[/g)?.length ?? 0) !== (value.match(/\]\]/g)?.length ?? 0)) throw invalid("proposal content contains an invalid Memory link");
}

function validateStains(value) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("proposal stains must be an object");
  for (const [agentId, color] of Object.entries(value)) {
    if (!AGENT_PATTERN.test(agentId) || typeof color !== "string" || !HEX_PATTERN.test(color)) throw invalid("proposal stains must contain only Agent bare hex metadata");
  }
}

function requireEvidence(proposal, evidenceById) {
  if (!Array.isArray(proposal.evidenceMessageIds) || proposal.evidenceMessageIds.length === 0) throw invalid("proposal evidenceMessageIds must be non-empty");
  const unique = [...new Set(proposal.evidenceMessageIds)];
  if (unique.length !== proposal.evidenceMessageIds.length) throw invalid("proposal evidenceMessageIds must not contain duplicates");
  const evidence = unique.map((id) => evidenceById.get(id));
  if (evidence.some((message) => !message)) throw invalid("proposal evidence must stay inside the frozen Message range");
  return evidence;
}

function canonicalProposal(proposal) {
  const ordered = {};
  for (const key of [...PROPOSAL_KEYS].sort()) if (proposal[key] !== undefined) ordered[key] = proposal[key];
  return JSON.stringify(ordered);
}

export function validateDigestProposals({ proposals, messages, agentId, spaceId, jobId = "job" }) {
  if (!Array.isArray(proposals)) throw invalid("digest executor must return a proposal array");
  if (proposals.length > 32) throw invalid("digest executor returned more than 32 proposals");
  const evidenceById = new Map(messages.map((message) => [message.id, message]));
  return proposals.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid(`proposal ${index} must be an object`);
    for (const key of Object.keys(raw)) if (!PROPOSAL_KEYS.has(key)) throw invalid(`unknown proposal field: ${key}`);
    if (!ACTIONS.has(raw.action)) throw invalid(`proposal ${index} has an unsupported action`);
    const evidence = raw.action === "skip" && (!raw.evidenceMessageIds || raw.evidenceMessageIds.length === 0)
      ? [] : requireEvidence(raw, evidenceById);
    if (evidence.some((message) => message.spaceId !== spaceId || message.status !== "completed")) throw invalid("proposal evidence has invalid scope or status");

    if (raw.action !== "skip" && raw.evidenceMessageIds.length > 64) throw invalid("proposal evidenceMessageIds exceeds 64");
    if (raw.action === "skip") {
      if (!SKIP_REASONS.has(raw.skipReason)) throw invalid("skip proposal has an unsupported skipReason");
      for (const field of ["fact", "suggestedSlug", "targetFactId", "targetMemorySlug", "type", "description", "content", "stains"]) {
        if (raw[field] !== undefined) throw invalid(`skip proposal cannot include ${field}`);
      }
    } else {
      if (raw.skipReason !== undefined) throw invalid(`${raw.action} proposal cannot include skipReason`);
      if (raw.action !== "archive") deriveFactHashes(agentId, raw.fact);
      if (raw.action === "create") assertSlug(raw.suggestedSlug, "suggestedSlug");
      if (raw.action === "create" && (raw.targetFactId !== undefined || raw.targetMemorySlug !== undefined)) {
        throw invalid("create proposal cannot include an existing target");
      }
      if (raw.targetFactId !== undefined && (typeof raw.targetFactId !== "string" || !/^fct_[a-f0-9]{16,64}$/.test(raw.targetFactId))) {
        throw invalid("targetFactId must identify a persisted fact catalog entry");
      }
      if (raw.targetMemorySlug !== undefined) assertSlug(raw.targetMemorySlug, "targetMemorySlug");
      if (raw.action !== "create" && (raw.targetFactId === undefined) === (raw.targetMemorySlug === undefined)) {
        throw invalid(`${raw.action} proposal requires exactly one targetFactId or targetMemorySlug`);
      }
      if (["create", "update", "supersede"].includes(raw.action) && (typeof raw.description !== "string" || !raw.description.trim())) throw invalid(`${raw.action} proposal requires description`);
      if (raw.description !== undefined && (typeof raw.description !== "string" || !raw.description.trim() || /[\r\n]/.test(raw.description))) throw invalid("description must be one non-empty line");
      if (raw.type !== undefined && !TYPE_PATTERN.test(raw.type)) throw invalid("proposal type must be a lowercase token");
      if (["create", "update", "supersede"].includes(raw.action) && raw.type === undefined) throw invalid(`${raw.action} proposal requires type`);
      if (["create", "update", "supersede"].includes(raw.action)) validateContent(raw.content);
      if (raw.content !== undefined) validateContent(raw.content);
      validateStains(raw.stains);
      if (raw.action === "archive") {
        for (const field of ["fact", "suggestedSlug", "type", "description", "content", "stains"]) {
          if (raw[field] !== undefined) throw invalid(`archive proposal cannot include ${field}`);
        }
      }
      if (raw.action === "supersede" && !evidence.some((message) => CORRECTION_PATTERN.test(String(message.content ?? "")))) {
        throw invalid("supersede requires explicit correction evidence");
      }
    }
    const hashes = raw.fact ? deriveFactHashes(agentId, raw.fact) : {};
    const canonical = canonicalProposal({ ...raw, ...(hashes.fact ? { fact: hashes.fact } : {}) });
    return {
      ...raw,
      ...hashes,
      evidence,
      sources: evidence.map((message) => ({ kind: "message", spaceId, messageId: message.id })),
      proposalId: `mpr_${hash(`${jobId}|${index}|${canonical}`).slice(7, 23)}`,
      canonical,
    };
  });
}

export function mergeSourceRefs(current = [], additions = []) {
  const seen = new Set();
  return [...current, ...additions].filter((source) => {
    const key = source.kind === "message"
      ? `message:${source.spaceId}:${source.messageId}`
      : `manual:${source.actor}:${source.capturedAt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function stableMemoryOperationId(jobId, index, proposal) {
  return `mop_${hash(`${jobId}|${index}|${proposal.canonical ?? canonicalProposal(proposal)}`).slice(7, 27)}`;
}
