// Strict M4 Dream maintenance schema and validator. Dream proposes only;
// gateway resolves versions, preserves sources, and creates MemoryOperations.

import { createHash } from "node:crypto";
import { ApiError } from "../core/errors.js";
import { mergeSourceRefs } from "./memory-proposals.js";
import { extractMemoryLinks, normalizeMemoryText } from "./memory-retrieval-text.js";
import { requireDreamProviderCapabilities } from "./memory-provider-capabilities.js";

const SLUG = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
const VERSION = "^sha256:[a-f0-9]{64}$";
const TYPE = "^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$";
const ACTIONS = new Set(["keep", "update", "merge", "archive"]);
const COMMON = new Set(["action", "targetSlug", "targetVersion"]);
const BY_ACTION = Object.freeze({
  keep: new Set(COMMON),
  update: new Set([...COMMON, "type", "description", "content"]),
  merge: new Set([...COMMON, "sourceSlugs", "sourceVersions", "type", "description", "content"]),
  archive: new Set([...COMMON, "replacementSlug"]),
});

const targetProperties = {
  action: { type: "string" },
  targetSlug: { type: "string", pattern: SLUG },
  targetVersion: { type: "string", pattern: VERSION },
};

export const MEMORY_DREAM_OUTPUT_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array", maxItems: 64,
      items: {
        oneOf: [
          { type: "object", additionalProperties: false, required: ["action", "targetSlug", "targetVersion"], properties: { ...targetProperties, action: { const: "keep" } } },
          { type: "object", additionalProperties: false, required: ["action", "targetSlug", "targetVersion"], properties: { ...targetProperties, action: { const: "update" }, type: { type: "string", pattern: TYPE }, description: { type: "string", minLength: 1 }, content: { type: "string", minLength: 1 } }, anyOf: [{ required: ["type"] }, { required: ["description"] }, { required: ["content"] }] },
          { type: "object", additionalProperties: false, required: ["action", "targetSlug", "targetVersion", "sourceSlugs", "sourceVersions", "type", "description", "content"], properties: { ...targetProperties, action: { const: "merge" }, sourceSlugs: { type: "array", minItems: 2, maxItems: 16, uniqueItems: true, items: { type: "string", pattern: SLUG } }, sourceVersions: { type: "object", additionalProperties: { type: "string", pattern: VERSION } }, type: { type: "string", pattern: TYPE }, description: { type: "string", minLength: 1 }, content: { type: "string", minLength: 1 } } },
          { type: "object", additionalProperties: false, required: ["action", "targetSlug", "targetVersion", "replacementSlug"], properties: { ...targetProperties, action: { const: "archive" }, replacementSlug: { type: "string", pattern: SLUG } } },
        ],
      },
    },
  },
});

function invalid(message) { return new ApiError("invalid_request", message); }
function slug(value, field) {
  if (typeof value !== "string" || !new RegExp(SLUG).test(value)) throw invalid(`${field} must be a kebab-case slug`);
}
function version(value, field) {
  if (typeof value !== "string" || !new RegExp(VERSION).test(value)) throw invalid(`${field} must be an opaque Memory version`);
}
function description(value) {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/u.test(value)) throw invalid("Dream description must be one non-empty line");
}
function content(value) {
  if (typeof value !== "string" || !value.trim()) throw invalid("Dream content must be non-empty");
  for (const match of value.matchAll(/\[\[([^\]]+)\]\]/gu)) slug(match[1], "Dream content link");
  if ((value.match(/\[\[/gu)?.length ?? 0) !== (value.match(/\]\]/gu)?.length ?? 0)) throw invalid("Dream content contains an invalid Memory link");
}
function canonical(value) {
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])));
}
function proposalId(jobId, index, proposal) {
  return `dpr_${createHash("sha256").update(`${jobId}|${index}|${canonical(proposal)}`).digest("hex").slice(0, 20)}`;
}

function semanticContent(value) {
  return normalizeMemoryText(String(value ?? "").replace(/\[\[[^\]]+\]\]/gu, " "))
    .replace(/\s+([.,;:!?])/gu, "$1");
}

function mapValue(map, key) {
  return map instanceof Map ? map.get(key) : map?.[key];
}

export function validateDreamProposals({
  proposals,
  memories,
  factIdsBySlug = null,
  providerCapabilities = null,
  jobId = "dream",
} = {}) {
  if (!Array.isArray(proposals) || proposals.length > 64) throw invalid("Dream proposals must be an array of at most 64 items");
  const bySlug = new Map((memories ?? []).map((memory) => [memory.slug, memory]));
  const claimed = new Set();
  return proposals.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid(`Dream proposal ${index} must be an object`);
    if (!ACTIONS.has(raw.action)) throw invalid(`Dream proposal ${index} has an unsupported action`);
    if (providerCapabilities) {
      try { requireDreamProviderCapabilities(providerCapabilities, raw.action); }
      catch { throw new ApiError("memory_provider_unsupported", `Memory Provider does not support Dream ${raw.action}`); }
    }
    for (const key of Object.keys(raw)) if (!BY_ACTION[raw.action].has(key)) throw invalid(`unknown Dream ${raw.action} field: ${key}`);
    slug(raw.targetSlug, "targetSlug");
    version(raw.targetVersion, "targetVersion");
    const target = bySlug.get(raw.targetSlug);
    if (!target || target.version !== raw.targetVersion) throw invalid("Dream target must match the frozen Memory snapshot");

    if (raw.action === "keep") return { ...raw, proposalId: proposalId(jobId, index, raw), canonical: canonical(raw) };
    if (claimed.has(raw.targetSlug)) throw invalid(`Dream writes ${raw.targetSlug} more than once`);
    claimed.add(raw.targetSlug);

    if (raw.action === "update") {
      if (raw.type === undefined && raw.description === undefined && raw.content === undefined) throw invalid("Dream update requires at least one writable field");
      if (raw.type !== undefined && (typeof raw.type !== "string" || !new RegExp(TYPE).test(raw.type))) throw invalid("Dream type must be a lowercase token");
      if (raw.description !== undefined) description(raw.description);
      if (raw.content !== undefined) content(raw.content);
      if (raw.content !== undefined && semanticContent(raw.content) !== semanticContent(target.content)) {
        throw invalid("Dream update cannot change factual content without Message evidence");
      }
    }
    if (raw.action === "archive") {
      if (raw.replacementSlug === undefined) throw invalid("Dream archive requires replacementSlug");
      slug(raw.replacementSlug, "replacementSlug");
      const replacement = bySlug.get(raw.replacementSlug);
      if (!replacement || replacement.status !== "active" || replacement.slug === target.slug) {
        throw invalid("Dream replacementSlug must identify another frozen active Memory");
      }
      const targetFactId = mapValue(factIdsBySlug, target.slug);
      const replacementFactId = mapValue(factIdsBySlug, replacement.slug);
      const sameFact = targetFactId && replacementFactId && targetFactId === replacementFactId;
      if (!sameFact && semanticContent(target.content) !== semanticContent(replacement.content)) {
        throw invalid("Dream archive replacement must be an explicit duplicate");
      }
    }
    if (raw.action === "merge") {
      if (!Array.isArray(raw.sourceSlugs) || raw.sourceSlugs.length < 2 || raw.sourceSlugs.length > 16 || new Set(raw.sourceSlugs).size !== raw.sourceSlugs.length) throw invalid("Dream merge sourceSlugs must contain 2..16 unique slugs");
      if (!raw.sourceSlugs.includes(raw.targetSlug)) throw invalid("Dream merge sourceSlugs must include targetSlug");
      if (!raw.sourceVersions || typeof raw.sourceVersions !== "object" || Array.isArray(raw.sourceVersions) || Object.keys(raw.sourceVersions).length !== raw.sourceSlugs.length) throw invalid("Dream merge sourceVersions must cover every source slug");
      const group = new Set(raw.sourceSlugs);
      const requiredLinks = new Set();
      const sourceSemantics = new Set();
      const sourceFactIds = new Set();
      for (const sourceSlug of raw.sourceSlugs) {
        slug(sourceSlug, "sourceSlug");
        const source = bySlug.get(sourceSlug);
        if (!source || source.status !== "active" || raw.sourceVersions[sourceSlug] !== source.version) throw invalid("Dream merge source must match a frozen active Memory");
        if (claimed.has(sourceSlug) && sourceSlug !== raw.targetSlug) throw invalid(`Dream writes ${sourceSlug} more than once`);
        claimed.add(sourceSlug);
        sourceSemantics.add(semanticContent(source.content));
        const sourceFactId = mapValue(factIdsBySlug, sourceSlug);
        if (sourceFactId) sourceFactIds.add(sourceFactId);
        for (const link of extractMemoryLinks(source)) if (!group.has(link)) requiredLinks.add(link);
      }
      if (Object.keys(raw.sourceVersions).some((sourceSlug) => !group.has(sourceSlug))) throw invalid("Dream merge sourceVersions contains an unknown source");
      if (typeof raw.type !== "string" || !new RegExp(TYPE).test(raw.type)) throw invalid("Dream merge type must be a lowercase token");
      description(raw.description);
      content(raw.content);
      const sameFact = sourceFactIds.size === 1 &&
        raw.sourceSlugs.every((sourceSlug) => mapValue(factIdsBySlug, sourceSlug));
      if (!sameFact && sourceSemantics.size !== 1) {
        throw invalid("Dream merge requires explicit duplicate identity");
      }
      if (!sourceSemantics.has(semanticContent(raw.content))) {
        throw invalid("Dream merge cannot invent or change factual content");
      }
      const proposedLinks = new Set(extractMemoryLinks({ content: raw.content }));
      for (const link of requiredLinks) if (!proposedLinks.has(link)) throw invalid(`Dream merge must preserve outgoing link ${link}`);
    }
    return { ...raw, proposalId: proposalId(jobId, index, raw), canonical: canonical(raw) };
  });
}

export function planDreamOperations({ agentId, jobId, proposals, memories, requestedAt } = {}) {
  const bySlug = new Map(memories.map((memory) => [memory.slug, memory]));
  const operations = [];
  for (const proposal of proposals) {
    if (proposal.action === "keep") continue;
    const target = bySlug.get(proposal.targetSlug);
    if (proposal.action === "update") {
      operations.push({
        proposalId: proposal.proposalId,
        operation: { operationId: `mop_${proposal.proposalId.slice(4)}_update`, agentId, origin: "memory-dream", kind: "update", slug: target.slug, ifMatch: target.version, requestedAt, patch: {
          ...(proposal.type === undefined ? {} : { type: proposal.type }),
          ...(proposal.description === undefined ? {} : { description: proposal.description }),
          ...(proposal.content === undefined ? {} : { content: proposal.content }),
        } },
      });
    } else if (proposal.action === "archive") {
      operations.push({ proposalId: proposal.proposalId, operation: { operationId: `mop_${proposal.proposalId.slice(4)}_archive`, agentId, origin: "memory-dream", kind: "archive", slug: target.slug, ifMatch: target.version, requestedAt, patch: {} } });
    } else if (proposal.action === "merge") {
      const members = proposal.sourceSlugs.map((sourceSlug) => bySlug.get(sourceSlug));
      const sources = mergeSourceRefs([], members.flatMap((memory) => memory.sources ?? []));
      operations.push({ proposalId: proposal.proposalId, operation: { operationId: `mop_${proposal.proposalId.slice(4)}_merge`, agentId, origin: "memory-dream", kind: "update", slug: target.slug, ifMatch: target.version, requestedAt, patch: { type: proposal.type, description: proposal.description, content: proposal.content, sources } } });
      for (const member of members.filter((memory) => memory.slug !== target.slug).sort((a, b) => a.slug.localeCompare(b.slug))) {
        operations.push({ proposalId: proposal.proposalId, operation: { operationId: `mop_${proposal.proposalId.slice(4)}_${member.slug}`, agentId, origin: "memory-dream", kind: "archive", slug: member.slug, ifMatch: member.version, requestedAt, patch: {} } });
      }
    }
  }
  return operations;
}
