// Memory markdown frontmatter formatter/parser. Supports only the contract's
// scalar fields plus the one-level stains map; malformed frontmatter degrades
// to an empty metadata object instead of taking down the whole vault listing.

const YAML_INDICATOR_FIRST = /^[-?:,[\]{}#&*!|>'"%@`]/;
const YAML_AMBIGUOUS_LITERAL = /^(?:true|false|null|yes|no|~)$/i;

function needsQuoting(value) {
  return (
    value === "" ||
    /[:"'#{}[\]]/.test(value) ||
    /[\n\r\t]/.test(value) ||
    value.trim() !== value ||
    YAML_INDICATOR_FIRST.test(value) ||
    YAML_AMBIGUOUS_LITERAL.test(value) ||
    !Number.isNaN(Number(value))
  );
}

function scalarToYaml(value) {
  const str = value === null || value === undefined ? "" : String(value);
  return needsQuoting(str) ? JSON.stringify(str) : str;
}

function unquote(raw) {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function indentOf(line) {
  return line.match(/^\s*/)[0].length;
}

function parseFrontmatterLines(lines) {
  const result = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || indentOf(line) > 0) {
      i += 1;
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      i += 1;
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();
    if (rest === "{}") {
      result[key] = {};
      i += 1;
      continue;
    }
    if (rest === "") {
      const map = {};
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "" && indentOf(lines[j]) > 0) {
        const subLine = lines[j];
        const subColonIdx = subLine.indexOf(":");
        if (subColonIdx !== -1) {
          const subKey = subLine.slice(0, subColonIdx).trim();
          map[subKey] = unquote(subLine.slice(subColonIdx + 1));
        }
        j += 1;
      }
      result[key] = map;
      i = j;
      continue;
    }
    result[key] = unquote(rest);
    i += 1;
  }
  return result;
}

export function serializeFrontmatter({ type, description, status, stains, createdAt, updatedAt }) {
  const lines = ["---"];
  lines.push(`type: ${scalarToYaml(type)}`);
  lines.push(`description: ${scalarToYaml(description)}`);
  lines.push(`status: ${scalarToYaml(status)}`);
  const stainEntries = Object.entries(stains ?? {});
  if (stainEntries.length > 0) {
    lines.push("stains:");
    for (const [agentId, hex] of stainEntries) lines.push(`  ${agentId}: ${scalarToYaml(hex)}`);
  } else {
    lines.push("stains: {}");
  }
  lines.push(`createdAt: ${createdAt}`);
  lines.push(`updatedAt: ${updatedAt}`);
  lines.push("---");
  return lines.join("\n");
}

export function splitFrontmatter(raw) {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: raw };
  const endIdx = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIdx === -1) return { frontmatter: {}, body: raw };
  return {
    frontmatter: parseFrontmatterLines(lines.slice(1, endIdx)),
    body: lines.slice(endIdx + 1).join("\n").replace(/^\n+/, ""),
  };
}

export function toIndexEntry(slug, frontmatter) {
  return {
    slug,
    type: frontmatter.type ?? "",
    description: frontmatter.description ?? "",
    status: frontmatter.status ?? "active",
    stains: frontmatter.stains ?? {},
    createdAt: frontmatter.createdAt ?? null,
    updatedAt: frontmatter.updatedAt ?? null,
  };
}
