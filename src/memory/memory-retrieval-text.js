export function normalizeMemoryText(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

export function singularizeMemoryToken(token) {
  if (!/^[a-z0-9]+$/u.test(token) || token.length <= 3) return token;
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (/(?:xes|zes|ches|shes)$/u.test(token)) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function tokenizeMemoryText(value, { singular = false } = {}) {
  const tokens = [];
  let ascii = "";
  let unicode = [];
  const flushAscii = () => {
    if (ascii) tokens.push(singular ? singularizeMemoryToken(ascii) : ascii);
    ascii = "";
  };
  const flushUnicode = () => {
    if (unicode.length) {
      tokens.push(...unicode);
      for (let i = 0; i + 1 < unicode.length; i += 1) tokens.push(`${unicode[i]}${unicode[i + 1]}`);
    }
    unicode = [];
  };
  for (const char of normalizeMemoryText(value)) {
    if (/^[A-Za-z0-9]$/u.test(char)) {
      flushUnicode(); ascii += char;
    } else if (/^[\p{L}\p{N}]$/u.test(char)) {
      flushAscii(); unicode.push(char);
    } else {
      flushAscii(); flushUnicode();
    }
  }
  flushAscii(); flushUnicode();
  return tokens;
}

function charTrigrams(value) {
  const chars = [...normalizeMemoryText(value)];
  if (!chars.length) return [];
  if (chars.length < 3) return [chars.join("")];
  return Array.from({ length: chars.length - 2 }, (_, index) => chars.slice(index, index + 3).join(""));
}

function counts(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

export function buildMemoryTfidfModel(texts) {
  const documents = texts.map((text) => counts(charTrigrams(text)));
  const documentFrequency = new Map();
  for (const document of documents) {
    for (const term of document.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const vectorFor = (textOrCounts) => {
    const termCounts = textOrCounts instanceof Map ? textOrCounts : counts(charTrigrams(textOrCounts));
    const values = new Map();
    let normSquared = 0;
    for (const [term, frequency] of termCounts) {
      const weight = frequency * (Math.log((documents.length + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1);
      values.set(term, weight); normSquared += weight * weight;
    }
    return { values, norm: Math.sqrt(normSquared) };
  };
  return { documentVectors: documents.map(vectorFor), vectorFor };
}

export function memoryCosine(left, right) {
  if (!left?.norm || !right?.norm) return 0;
  const [small, large] = left.values.size <= right.values.size
    ? [left.values, right.values] : [right.values, left.values];
  let dot = 0;
  for (const [term, value] of small) dot += value * (large.get(term) ?? 0);
  return Math.min(1, Math.max(0, dot / (left.norm * right.norm)));
}

export function computeMemoryBm25Scores(documents, queryTokens, { bm25K1, bm25B }) {
  const averageLength = documents.length
    ? documents.reduce((sum, document) => sum + document.length, 0) / documents.length : 0;
  const queryTerms = [...new Set(queryTokens)];
  const documentFrequency = new Map(queryTerms.map((term) => [
    term, documents.reduce((sum, document) => sum + Number(document.includes(term)), 0),
  ]));
  return documents.map((document) => {
    const frequencies = counts(document);
    return queryTerms.reduce((score, term) => {
      const frequency = frequencies.get(term) ?? 0;
      if (!frequency) return score;
      const df = documentFrequency.get(term);
      const idf = Math.log(1 + ((documents.length - df + 0.5) / (df + 0.5)));
      const ratio = averageLength ? document.length / averageLength : 0;
      const denominator = frequency + bm25K1 * (1 - bm25B + bm25B * ratio);
      return score + idf * ((frequency * (bm25K1 + 1)) / denominator);
    }, 0);
  });
}

function firstBodyParagraph(content, maxCodePoints) {
  const paragraph = [];
  let started = false;
  for (const line of String(content ?? "").replace(/\r\n?/gu, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!started && (!trimmed || /^#{1,6}(?:\s|$)/u.test(trimmed))) continue;
    if (started && !trimmed) break;
    if (trimmed) { started = true; paragraph.push(trimmed); }
  }
  return [...paragraph.join(" ")].slice(0, maxCodePoints).join("").trim();
}

export function buildMemoryProjections(memory, maxCodePoints) {
  const compact = String(memory.description ?? "").trim();
  const body = firstBodyParagraph(memory.content, maxCodePoints);
  return { compact, standard: body && normalizeMemoryText(body) !== normalizeMemoryText(compact) ? `${compact}\n${body}` : compact };
}

export function extractMemoryLinks(memory) {
  const links = new Set();
  for (const link of Array.isArray(memory.links) ? memory.links : []) {
    const slug = typeof link === "string" ? link : link?.slug;
    if (typeof slug === "string" && slug) links.add(slug);
  }
  for (const match of String(memory.content ?? "").matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/gu)) {
    if (match[1].trim()) links.add(match[1].trim());
  }
  return [...links].sort();
}

export function memoryTokenJaccard(left, right) {
  const a = new Set(tokenizeMemoryText(left));
  const b = new Set(tokenizeMemoryText(right));
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function estimateMemoryTokens(text) {
  return Math.max(1, Math.ceil(Buffer.byteLength(String(text ?? "").normalize("NFKC"), "utf8") / 3));
}
