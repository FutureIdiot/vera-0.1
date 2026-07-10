// Theme + Appearance Profile HTTP 路由（api-contract.md「Theme与Appearance Profile交换」[P4.6/F1]）。
//
// Theme Palette 与个人布局配置是两个独立对象。切换或导入 Theme 不得覆盖
// 字体、字号、气泡或窗口边距（ground truth 4.3 三层分离）。
// 导入原文不直接持久化或执行——先返回 preview + warnings，确认后走 POST /api/themes。

import { asHandler, readJsonBody, sendJson } from "./http.js";
import { ApiError } from "../core/errors.js";
import { listThemes, getTheme, createTheme, updateTheme, deleteTheme } from "../core/themes.js";
import { parseTheme } from "../core/theme-converter.js";

// Appearance Profile 导出时排除的字段（这些属于 Theme Palette 层）
const THEME_PALETTE_KEYS = new Set(["appearance.theme", "appearance.themeId", "appearance.themeColor", "appearance.accentColor"]);

// Appearance Profile 导出/导入的字段白名单（非 Theme 的个人布局配置）
const PROFILE_KEYS = [
  "appearance.fontFamily",
  "appearance.fontSize.phone.chat",
  "appearance.fontSize.phone.management",
  "appearance.fontSize.desktop.chat",
  "appearance.fontSize.desktop.management",
  "appearance.bubbleRadius.phone",
  "appearance.bubbleRadius.desktop",
  "appearance.bubbleGap.phone",
  "appearance.bubbleGap.desktop",
  "appearance.windowMargin.phone.chat",
  "appearance.windowMargin.phone.management",
  "appearance.windowMargin.desktop.chat",
  "appearance.windowMargin.desktop.management",
];

export function registerThemesRoutes(router, { store, settingsStore }) {
  // ---- Theme CRUD ----

  router.get(
    "/api/themes",
    asHandler(async ({ res }) => {
      sendJson(res, 200, { themes: listThemes(store) });
    }),
  );

  router.get(
    "/api/themes/:id",
    asHandler(async ({ res, params }) => {
      const theme = getTheme(store, params.id);
      sendJson(res, 200, { theme });
    }),
  );

  router.post(
    "/api/themes",
    asHandler(async ({ req, res }) => {
      const body = await readJsonBody(req);
      if (!body.theme) throw new ApiError("invalid_request", "request body must be { theme: <Theme> }");
      const theme = createTheme(store, body.theme);
      sendJson(res, 201, { theme });
    }),
  );

  router.patch(
    "/api/themes/:id",
    asHandler(async ({ req, res, params }) => {
      const body = await readJsonBody(req);
      const theme = updateTheme(store, params.id, body);
      sendJson(res, 200, { theme });
    }),
  );

  router.delete(
    "/api/themes/:id",
    asHandler(async ({ res, params }) => {
      deleteTheme(store, params.id, settingsStore);
      sendJson(res, 204);
    }),
  );

  // ---- Theme import (preview only, no persist) ----

  router.post(
    "/api/themes/import",
    asHandler(async ({ req, res }) => {
      const body = await readJsonBody(req);
      if (!["vera-json", "vera-css", "itermcolors", "terminal-profile"].includes(body.format)) {
        throw new ApiError("invalid_request", `unsupported format: ${body.format}`);
      }
      if (typeof body.content !== "string") {
        throw new ApiError("invalid_request", "content must be a string");
      }
      const { theme, warnings } = parseTheme({ format: body.format, content: body.content, name: body.name });
      sendJson(res, 200, { preview: theme, warnings });
    }),
  );

  // ---- Theme export ----

  router.get(
    "/api/themes/:id/export",
    asHandler(async ({ res, params, query }) => {
      const theme = getTheme(store, params.id);
      const format = query.get("format") || "vera-json";
      if (format === "vera-json") {
        sendJson(res, 200, theme);
      } else if (format === "vera-css") {
        const css = themeToCss(theme);
        res.writeHead(200, { "Content-Type": "text/css" });
        res.end(css);
      } else {
        throw new ApiError("invalid_request", `unsupported export format: ${format} (supported: vera-json, vera-css)`);
      }
    }),
  );

  // ---- Appearance Profile export/import (non-Theme personal layout) ----

  router.get(
    "/api/settings/appearance-profile/export",
    asHandler(async ({ res }) => {
      const all = settingsStore.getAll();
      const appearance = {};
      for (const key of PROFILE_KEYS) {
        if (all[key] !== undefined) appearance[key] = all[key];
      }
      sendJson(res, 200, {
        schemaVersion: 1,
        kind: "vera-appearance-profile",
        appearance,
      });
    }),
  );

  router.post(
    "/api/settings/appearance-profile/import",
    asHandler(async ({ req, res }) => {
      const body = await readJsonBody(req);
      if (body.schemaVersion !== 1 || body.kind !== "vera-appearance-profile") {
        throw new ApiError("invalid_request", 'body must have schemaVersion: 1 and kind: "vera-appearance-profile"');
      }
      if (!body.appearance || typeof body.appearance !== "object") {
        throw new ApiError("invalid_request", "body.appearance must be an object");
      }
      const warnings = [];
      const preview = {};
      for (const [key, value] of Object.entries(body.appearance)) {
        if (!PROFILE_KEYS.includes(key)) {
          warnings.push(`unknown key ignored: ${key}`);
          continue;
        }
        preview[key] = value;
      }
      // 检查是否混入了 Theme Palette 字段
      for (const key of THEME_PALETTE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(body.appearance, key)) {
          warnings.push(`Theme Palette field ignored in Appearance Profile: ${key}`);
        }
      }
      sendJson(res, 200, { preview, warnings });
    }),
  );
}

function themeToCss(theme) {
  const lines = [":root {"];
  const colorMap = {
    background: "--vera-color-background",
    surface: "--vera-color-surface",
    text: "--vera-color-text",
    mutedText: "--vera-color-muted-text",
    border: "--vera-color-border",
    accent: "--vera-color-accent",
    success: "--vera-color-success",
    warning: "--vera-color-warning",
    error: "--vera-color-error",
  };
  for (const [src, dst] of Object.entries(colorMap)) {
    if (theme.colors?.[src]) lines.push(`  ${dst}: ${theme.colors[src]};`);
  }
  if (theme.terminal) {
    lines.push(`  --vera-terminal-foreground: ${theme.terminal.foreground};`);
    lines.push(`  --vera-terminal-background: ${theme.terminal.background};`);
    lines.push(`  --vera-terminal-cursor: ${theme.terminal.cursor};`);
    lines.push(`  --vera-terminal-selection: ${theme.terminal.selection};`);
    for (let i = 0; i < 16; i++) {
      if (theme.terminal.ansi?.[i]) lines.push(`  --vera-terminal-ansi-${i}: ${theme.terminal.ansi[i]};`);
    }
  }
  lines.push("}");
  return lines.join("\n");
}
