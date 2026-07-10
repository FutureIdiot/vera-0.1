// Theme 格式转换：将 vera-json / vera-css / itermcolors / terminal-profile 归一化
// 为 api-contract.md 374-410 定义的 Theme 对象。纯解析模块，无外部依赖。

import { ApiError } from "./errors.js";

const COLOR_KEYS = ["background", "surface", "text", "mutedText", "border", "accent", "success", "warning", "error"];
const TERM_KEYS = ["foreground", "background", "cursor", "selection"];

const NAMED_COLORS = {
  black: "#000000", white: "#ffffff", red: "#ff0000", blue: "#0000ff",
  green: "#008000", yellow: "#ffff00", cyan: "#00ffff", magenta: "#ff00ff",
  gray: "#808080", silver: "#c0c0c0", maroon: "#800000", navy: "#000080",
  teal: "#008080", purple: "#800080", olive: "#808000", lime: "#00ff00",
};

const DEFAULT_COLORS = {
  background: "#000000", surface: "#1a1a1a", text: "#ffffff",
  mutedText: "#cccccc", border: "#444444", accent: "#89b4fa",
  success: "#a6e3a1", warning: "#f9e2af", error: "#f38ba8",
};

function normalizeHex(input) {
  const s = String(input).trim().toLowerCase();
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];
  if (!s.startsWith("#")) throw new ApiError("invalid_request", `invalid color: ${input}`);
  const hex = s.slice(1);
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
  if (/^[0-9a-f]{3}$/.test(hex)) return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  throw new ApiError("invalid_request", `invalid hex color: ${input}`);
}

const compToHex = (v) => Math.min(255, Math.max(0, Math.round(v * 255))).toString(16).padStart(2, "0");
const floatRgbToHex = (r, g, b) => `#${compToHex(r)}${compToHex(g)}${compToHex(b)}`;
const parseHexChannels = (hex) => {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
const shiftHex = (hex, amount) => {
  const [r, g, b] = parseHexChannels(hex);
  const adj = Math.round(255 * amount);
  return floatRgbToHex((r + adj) / 255, (g + adj) / 255, (b + adj) / 255);
};
const lighten = (hex, amount) => shiftHex(hex, amount);
const darken = (hex, amount) => shiftHex(hex, -amount);
const baseTheme = (name) => ({ schemaVersion: 1, kind: "vera-theme", name, colors: {} });

function parseVeraJson({ content, name }) {
  let obj;
  try {
    obj = JSON.parse(content);
  } catch (err) {
    throw new ApiError("invalid_request", `invalid JSON: ${err.message}`);
  }
  if (obj.schemaVersion !== 1) throw new ApiError("invalid_request", `unsupported schemaVersion: ${obj.schemaVersion}`);
  if (obj.kind !== "vera-theme") throw new ApiError("invalid_request", `unsupported kind: ${obj.kind}`);
  const warnings = [];
  const theme = baseTheme(name || obj.name || "Imported Theme");
  theme.colors = {};
  for (const key of COLOR_KEYS) {
    if (obj.colors && obj.colors[key] != null) theme.colors[key] = normalizeHex(obj.colors[key]);
    else throw new ApiError("invalid_request", `missing required color: ${key}`);
  }
  if (obj.terminal) {
    const term = {};
    for (const key of TERM_KEYS) {
      if (obj.terminal[key] == null) throw new ApiError("invalid_request", `terminal missing key: ${key}`);
      term[key] = normalizeHex(obj.terminal[key]);
    }
    if (!Array.isArray(obj.terminal.ansi) || obj.terminal.ansi.length !== 16) {
      throw new ApiError("invalid_request", "terminal.ansi must be array of 16");
    }
    term.ansi = obj.terminal.ansi.map(normalizeHex);
    theme.terminal = term;
  } else {
    warnings.push("theme has no terminal palette");
  }
  return { theme, warnings };
}

function parseVeraCss({ content, name }) {
  const warnings = [];
  if (/@import|@font-face|url\(|<script|expression\s*\(/i.test(content)) {
    throw new ApiError("invalid_request", "vera-css rejects @import, url(), scripts or external resources");
  }
  const themeName = name || "Imported CSS Theme";
  const theme = baseTheme(themeName);
  theme.colors = { ...DEFAULT_COLORS };
  const terminal = {};
  let foundColor = false;
  let foundTerm = false;
  // 每个规则块：selector { decls }
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(content)) !== null) {
    const selector = m[1].trim();
    const body = m[2];
    // 仅允许 :root 或 [data-theme="..."]
    const rootOk = selector === ":root";
    const dataTheme = selector.match(/^\[data-theme\s*=\s*"([^"]*)"\]$/);
    if (!rootOk && !dataTheme) {
      throw new ApiError("invalid_request", `unsupported selector: ${selector}`);
    }
    if (dataTheme && !name) theme.name = dataTheme[1];
    const declRe = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
    let dm;
    while ((dm = declRe.exec(body)) !== null) {
      const prop = dm[1].toLowerCase();
      const value = dm[2].trim();
      if (prop.startsWith("--vera-color-")) {
        const key = prop.slice("--vera-color-".length);
        if (!COLOR_KEYS.includes(key)) {
          throw new ApiError("invalid_request", `unknown --vera-color-* var: ${prop}`);
        }
        theme.colors[key] = normalizeHex(value);
        foundColor = true;
      } else if (prop.startsWith("--vera-terminal-")) {
        const rest = prop.slice("--vera-terminal-".length);
        const ansiMatch = rest.match(/^ansi-(\d+)$/);
        if (ansiMatch) {
          const i = Number(ansiMatch[1]);
          if (i < 0 || i > 15) {
            throw new ApiError("invalid_request", `ansi index out of range: ${i}`);
          }
          terminal.ansi = terminal.ansi || new Array(16);
          terminal.ansi[i] = normalizeHex(value);
          foundTerm = true;
        } else if (TERM_KEYS.includes(rest)) {
          terminal[rest] = normalizeHex(value);
          foundTerm = true;
        } else {
          throw new ApiError("invalid_request", `unknown --vera-terminal-* var: ${prop}`);
        }
      } else if (!prop.startsWith("--")) {
        throw new ApiError("invalid_request", `non-custom-property declaration: ${prop}`);
      }
    }
  }
  if (!foundColor) {
    throw new ApiError("invalid_request", "no valid --vera-color-* declarations found");
  }
  const setKeys = new Set();
  const declRe2 = /--vera-color-([a-z]+)\s*:/gi;
  let d2;
  while ((d2 = declRe2.exec(content)) !== null) setKeys.add(d2[1]);
  for (const key of COLOR_KEYS) {
    if (!setKeys.has(key)) warnings.push(`color '${key}' missing, using default ${DEFAULT_COLORS[key]}`);
  }
  if (foundTerm) {
    const term = {};
    for (const key of TERM_KEYS) {
      term[key] = terminal[key] || DEFAULT_COLORS.background;
    }
    term.ansi = (terminal.ansi || []).map((v, i) => v || DEFAULT_COLORS[["border", "error", "success", "warning", "accent", "text", "text", "mutedText"][i] || "border"]);
    theme.terminal = term;
  }
  return { theme, warnings };
}

// 从 plist XML 抽取颜色成分表：{ "Background Color": "#1e1e2e", ... }
// 简单 tokenizer：区分 key、open tag、close tag、inline value tag。
function parsePlistColors(xml, keyNames) {
  const result = {};
  const tokRe = /<key>([^<]*)<\/key>|<(real|integer|string)>([^<]*)<\/(\2)>|<\s*(dict|array)\s*>|<\s*\/(dict|array)\s*>/g;
  const toks = [];
  let tm;
  while ((tm = tokRe.exec(xml)) !== null) {
    if (tm[1] !== undefined) toks.push({ t: "key", n: tm[1] });
    else if (tm[2] !== undefined) toks.push({ t: "val", tag: tm[2], v: tm[3] });
    else if (tm[5] !== undefined) toks.push({ t: "open", tag: tm[5] });
    else if (tm[6] !== undefined) toks.push({ t: "close", tag: tm[6] });
  }
  let i = 0;
  while (i < toks.length) {
    const tk = toks[i];
    if (tk.t === "key" && keyNames.includes(tk.n)) {
      const keyName = tk.n;
      i++;
      if (toks[i] && toks[i].t === "open" && toks[i].tag === "dict") {
        i++;
        const inner = {};
        let depth = 1;
        while (i < toks.length && depth > 0) {
          const cur = toks[i];
          if (cur.t === "open") depth++;
          else if (cur.t === "close") depth--;
          if (depth === 0) { i++; break; }
          if (cur.t === "key") {
            const prop = cur.n;
            i++;
            const v = toks[i];
            if (v && v.t === "val") {
              if (v.tag === "real" || v.tag === "integer") inner[prop] = parseFloat(v.v);
              else if (v.tag === "string") inner[prop] = v.v;
              i++;
            } else {
              i++;
            }
          } else {
            i++;
          }
        }
        if (inner["Red Component"] != null && inner["Green Component"] != null && inner["Blue Component"] != null) {
          result[keyName] = floatRgbToHex(
            inner["Red Component"], inner["Green Component"], inner["Blue Component"],
          );
        }
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return result;
}

function buildFromTerminalColors(named, fallbackName, name) {
  const warnings = [];
  const colors = {};
  const terminal = {};
  const bg = named["Background Color"] || named["BackgroundColor"] || "#000000";
  const fg = named["Foreground Color"] || named["TextColor"] || named["Foreground"] || "#ffffff";
  colors.background = bg;
  colors.text = fg;
  terminal.background = bg;
  terminal.foreground = fg;
  if (named["Cursor Color"] || named["CursorColor"]) {
    terminal.cursor = named["Cursor Color"] || named["CursorColor"];
  }
  if (named["Selection Color"] || named["SelectionColor"]) {
    terminal.selection = named["Selection Color"] || named["SelectionColor"];
  }
  const ansi = new Array(16);
  for (let i = 0; i < 16; i++) {
    const k = `Ansi ${i} Color` in named ? `Ansi ${i} Color` : null;
    const alt = `ANSIBrightColor${i}` in named ? `ANSIBrightColor${i}` : null;
    const key = k || alt;
    if (key) ansi[i] = named[key];
  }
  terminal.ansi = ansi;
  // best-effort 语义色映射
  colors.border = ansi[0] || DEFAULT_COLORS.border;
  colors.error = ansi[1] || DEFAULT_COLORS.error;
  colors.success = ansi[2] || DEFAULT_COLORS.success;
  colors.warning = ansi[3] || DEFAULT_COLORS.warning;
  colors.accent = ansi[4] || DEFAULT_COLORS.accent;
  // surface/mutedText 派生
  colors.surface = lighten(bg, 0.1);
  warnings.push("color 'surface' derived from background");
  colors.mutedText = darken(fg, 0.2);
  warnings.push("color 'mutedText' derived from text");
  const theme = baseTheme(name || fallbackName);
  theme.colors = colors;
  theme.terminal = terminal;
  return { theme, warnings };
}

function parseItermColors({ content, name }) {
  const keyNames = [
    "Background Color", "Foreground Color", "Cursor Color", "Selection Color", "Link Color",
    ...Array.from({ length: 16 }, (_, i) => `Ansi ${i} Color`),
  ];
  const named = parsePlistColors(content, keyNames);
  return buildFromTerminalColors(named, "Imported iTerm2 Theme", name);
}

function parseTerminalProfile({ content, name }) {
  const keyNames = [
    "BackgroundColor", "TextColor", "CursorColor", "SelectionColor",
    ...Array.from({ length: 16 }, (_, i) => `ANSIBrightColor${i}`),
    ...Array.from({ length: 16 }, (_, i) => `Ansi ${i} Color`),
  ];
  const named = parsePlistColors(content, keyNames);
  return buildFromTerminalColors(named, "Imported Terminal.app Theme", name);
}

export function parseTheme({ format, content, name }) {
  if (format === "vera-json") return parseVeraJson({ content, name });
  if (format === "vera-css") return parseVeraCss({ content, name });
  if (format === "itermcolors") return parseItermColors({ content, name });
  if (format === "terminal-profile") return parseTerminalProfile({ content, name });
  throw new ApiError("invalid_request", `unsupported format: ${format}`);
}