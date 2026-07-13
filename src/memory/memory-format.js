import { createHash } from "node:crypto";
import { ApiError } from "../core/errors.js";

export const MEMORY_SCHEMA_VERSION = 1;
const FRONTMATTER_KEYS = new Set([
  "schemaVersion", "scope", "sources", "type", "description", "status",
  "stains", "createdAt", "updatedAt",
]);
const LEGACY_KEYS = new Set(["type", "description", "status", "stains", "createdAt", "updatedAt"]);
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;
const TYPE_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const AGENT_ID_PATTERN = /^agt_[a-z0-9]+$/;

function invalid(message) {
  return new ApiError("invalid_request", message);
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "{}") return {};
  if (value === "[]") return [];
  if (value === "null") return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.startsWith('"')) {
      try { return JSON.parse(value); } catch { throw invalid("frontmatter contains invalid quoted scalar"); }
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith("{") || value.startsWith("[")) {
    try { return JSON.parse(value); } catch { throw invalid("frontmatter contains invalid flow value"); }
  }
  return value;
}

function indent(line) {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

// Minimal strict YAML subset for Vera's canonical shape. It accepts canonical
// block maps/lists and JSON-compatible flow values, without executing tags.
function parseFrontmatterLines(lines) {
  const result = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (indent(line) !== 0 || !line.includes(":")) throw invalid(`invalid frontmatter line ${index + 2}`);
    const colon = line.indexOf(":");
    const key = line.slice(0, colon).trim();
    if (!key || Object.prototype.hasOwnProperty.call(result, key)) throw invalid(`duplicate or empty frontmatter key: ${key}`);
    const rest = line.slice(colon + 1).trim();
    if (rest) {
      result[key] = parseScalar(rest);
      index += 1;
      continue;
    }
    const children = [];
    index += 1;
    while (index < lines.length && (lines[index].trim() === "" || indent(lines[index]) > 0)) {
      if (lines[index].trim()) children.push(lines[index]);
      index += 1;
    }
    if (children.length === 0) { result[key] = {}; continue; }
    if (children[0].trimStart().startsWith("- ")) {
      const list = [];
      let current = null;
      for (const child of children) {
        const trimmed = child.trim();
        if (trimmed.startsWith("- ")) {
          current = {};
          list.push(current);
          const first = trimmed.slice(2);
          if (!first.includes(":")) throw invalid(`invalid list item for ${key}`);
          const itemColon = first.indexOf(":");
          current[first.slice(0, itemColon).trim()] = parseScalar(first.slice(itemColon + 1));
        } else {
          if (!current || !trimmed.includes(":")) throw invalid(`invalid list continuation for ${key}`);
          const itemColon = trimmed.indexOf(":");
          const itemKey = trimmed.slice(0, itemColon).trim();
          if (Object.prototype.hasOwnProperty.call(current, itemKey)) throw invalid(`duplicate ${key} item key: ${itemKey}`);
          current[itemKey] = parseScalar(trimmed.slice(itemColon + 1));
        }
      }
      result[key] = list;
    } else {
      const map = {};
      for (const child of children) {
        const trimmed = child.trim();
        if (!trimmed.includes(":")) throw invalid(`invalid map entry for ${key}`);
        const itemColon = trimmed.indexOf(":");
        const itemKey = trimmed.slice(0, itemColon).trim();
        if (Object.prototype.hasOwnProperty.call(map, itemKey)) throw invalid(`duplicate ${key} key: ${itemKey}`);
        map[itemKey] = parseScalar(trimmed.slice(itemColon + 1));
      }
      result[key] = map;
    }
  }
  return result;
}

function yamlScalar(value) {
  const text = String(value ?? "");
  return JSON.stringify(text);
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw invalid(`unknown ${label} key: ${key}`);
}

function assertIso(value, field) {
  if (typeof value !== "string" || !ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) throw invalid(`${field} must be ISO8601 UTC`);
}

export function validateSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) throw invalid("sources must be a non-empty array");
  return sources.map((source, index) => {
    if (source?.kind === "message") {
      assertExactKeys(source, new Set(["kind", "spaceId", "messageId"]), `sources[${index}]`);
      if (typeof source.spaceId !== "string" || !source.spaceId) throw invalid(`sources[${index}].spaceId is required`);
      if (typeof source.messageId !== "string" || !source.messageId) throw invalid(`sources[${index}].messageId is required`);
      return { kind: "message", spaceId: source.spaceId, messageId: source.messageId };
    }
    if (source?.kind === "manual") {
      assertExactKeys(source, new Set(["kind", "actor", "capturedAt"]), `sources[${index}]`);
      if (!["user", "legacy"].includes(source.actor)) throw invalid(`sources[${index}].actor must be user or legacy`);
      assertIso(source.capturedAt, `sources[${index}].capturedAt`);
      return { kind: "manual", actor: source.actor, capturedAt: source.capturedAt };
    }
    throw invalid(`sources[${index}].kind must be message or manual`);
  });
}

export function validateMemoryFields(memory, { agentId }) {
  if (memory.schemaVersion !== MEMORY_SCHEMA_VERSION) throw invalid(`schemaVersion must be ${MEMORY_SCHEMA_VERSION}`);
  assertExactKeys(memory.scope, new Set(["type", "agentId"]), "scope");
  if (memory.scope.type !== "agent" || memory.scope.agentId !== agentId) throw invalid(`scope must target agent ${agentId}`);
  if (typeof memory.type !== "string" || !TYPE_PATTERN.test(memory.type)) throw invalid("type must be a lowercase token");
  if (typeof memory.description !== "string" || !memory.description.trim() || /[\r\n]/.test(memory.description)) throw invalid("description must be one non-empty line");
  if (!["active", "archived"].includes(memory.status)) throw invalid('status must be "active" or "archived"');
  if (!memory.stains || typeof memory.stains !== "object" || Array.isArray(memory.stains)) throw invalid("stains must be an object");
  for (const [owner, color] of Object.entries(memory.stains)) {
    if (!AGENT_ID_PATTERN.test(owner) || typeof color !== "string" || !HEX_PATTERN.test(color)) {
      throw invalid(`invalid stain for ${owner || "unknown"}`);
    }
  }
  assertIso(memory.createdAt, "createdAt");
  assertIso(memory.updatedAt, "updatedAt");
  if (Date.parse(memory.updatedAt) < Date.parse(memory.createdAt)) throw invalid("updatedAt cannot precede createdAt");
  memory.sources = validateSources(memory.sources);
  if (typeof memory.content !== "string") throw invalid("content must be a string");
  return memory;
}

export function computeMemoryVersion(memory) {
  return computeMemoryByteVersion(serializeMemoryDocument(memory));
}

export function computeMemoryByteVersion(raw) {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

export function serializeFrontmatter(memory) {
  const lines = ["---", `schemaVersion: ${MEMORY_SCHEMA_VERSION}`, "scope:", "  type: agent", `  agentId: ${memory.scope.agentId}`, "sources:"];
  for (const source of memory.sources) {
    lines.push(`  - kind: ${source.kind}`);
    if (source.kind === "message") {
      lines.push(`    spaceId: ${source.spaceId}`, `    messageId: ${source.messageId}`);
    } else {
      lines.push(`    actor: ${source.actor}`, `    capturedAt: ${source.capturedAt}`);
    }
  }
  lines.push(`type: ${memory.type}`, `description: ${yamlScalar(memory.description)}`, `status: ${memory.status}`);
  const stains = Object.entries(memory.stains ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (stains.length === 0) lines.push("stains: {}");
  else {
    lines.push("stains:");
    for (const [owner, color] of stains) lines.push(`  ${owner}: ${yamlScalar(color)}`);
  }
  lines.push(`createdAt: ${memory.createdAt}`, `updatedAt: ${memory.updatedAt}`, "---");
  return lines.join("\n");
}

export function splitFrontmatter(raw) {
  if (typeof raw !== "string") throw invalid("memory document must be text");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") throw invalid("memory document is missing frontmatter start marker");
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end === -1) throw invalid("memory document is missing frontmatter end marker");
  return { frontmatter: parseFrontmatterLines(lines.slice(1, end)), body: lines.slice(end + 1).join("\n").replace(/^\n/, "").replace(/\n$/, "") };
}

export function parseMemoryDocument(raw, { slug, agentId }) {
  const byteVersion = computeMemoryByteVersion(raw);
  const { frontmatter, body } = splitFrontmatter(raw);
  const keys = new Set(Object.keys(frontmatter));
  const isLegacy = !keys.has("schemaVersion") && [...keys].every((key) => LEGACY_KEYS.has(key)) && [...LEGACY_KEYS].every((key) => keys.has(key));
  if (isLegacy) {
    const legacy = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      scope: { type: "agent", agentId },
      sources: [{ kind: "manual", actor: "legacy", capturedAt: frontmatter.createdAt }],
      type: frontmatter.type,
      description: frontmatter.description,
      status: frontmatter.status,
      stains: frontmatter.stains,
      createdAt: frontmatter.createdAt,
      updatedAt: frontmatter.updatedAt,
      content: body,
    };
    validateMemoryFields(legacy, { agentId });
    legacy.version = computeMemoryVersion(legacy);
    return { memory: { slug, ...legacy }, legacy: true };
  }
  for (const key of keys) if (!FRONTMATTER_KEYS.has(key)) throw invalid(`unknown frontmatter key: ${key}`);
  for (const key of FRONTMATTER_KEYS) if (!keys.has(key)) throw invalid(`missing frontmatter key: ${key}`);
  const memory = { slug, ...frontmatter, content: body };
  validateMemoryFields(memory, { agentId });
  memory.version = byteVersion;
  return { memory, legacy: false };
}

export function serializeMemoryDocument(memory) {
  return `${serializeFrontmatter(memory)}\n\n${memory.content}\n`;
}

export function toIndexEntry(memoryOrSlug, legacyFrontmatter) {
  const memory = typeof memoryOrSlug === "string" ? { slug: memoryOrSlug, ...legacyFrontmatter } : memoryOrSlug;
  const links = [...new Set([...String(memory.content ?? "").matchAll(/\[\[([a-z0-9]+(?:-[a-z0-9]+)*)\]\]/g)].map((match) => match[1]))].sort();
  return {
    slug: memory.slug,
    schemaVersion: memory.schemaVersion ?? null,
    scope: memory.scope ?? null,
    sourceRefs: memory.sources ?? [],
    sourceCount: memory.sources?.length ?? 0,
    links,
    type: memory.type,
    description: memory.description,
    status: memory.status,
    stains: memory.stains ?? {},
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    version: memory.version ?? null,
  };
}
