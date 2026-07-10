// Theme CRUD（api-contract.md「Theme与Appearance Profile交换」[P4.6/F1]）。
// Theme = 归一化的色板对象，存在 store 的 themes 集合（themes.json）。
// 切换/导入 Theme 不得覆盖字体、字号、气泡或窗口边距（ground truth 4.3 三层）。

import { newThemeId } from "./id.js";
import { ApiError } from "./errors.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

const REQUIRED_COLOR_KEYS = ["background", "surface", "text", "mutedText", "border", "accent", "success", "warning", "error"];

function validateTheme(theme) {
  if (!theme || typeof theme !== "object") {
    throw new ApiError("invalid_request", "theme must be an object");
  }
  if (theme.schemaVersion !== 1) {
    throw new ApiError("invalid_request", "theme.schemaVersion must be 1");
  }
  if (theme.kind !== "vera-theme") {
    throw new ApiError("invalid_request", 'theme.kind must be "vera-theme"');
  }
  if (typeof theme.name !== "string" || !theme.name.trim()) {
    throw new ApiError("invalid_request", "theme.name must be a non-empty string");
  }
  if (!theme.colors || typeof theme.colors !== "object") {
    throw new ApiError("invalid_request", "theme.colors must be an object");
  }
  for (const key of REQUIRED_COLOR_KEYS) {
    if (typeof theme.colors[key] !== "string") {
      throw new ApiError("invalid_request", `theme.colors.${key} must be a string`);
    }
  }
  if (theme.terminal !== undefined && theme.terminal !== null) {
    if (typeof theme.terminal !== "object") {
      throw new ApiError("invalid_request", "theme.terminal must be an object or null");
    }
  }
}

// 列表摘要（不含 colors/terminal 正文，减少传输量）
export function listThemes(store) {
  return store.list("themes").map((t) => ({
    id: t.id,
    name: t.name,
    schemaVersion: t.schemaVersion,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));
}

export function getTheme(store, id) {
  const theme = store.find("themes", id);
  if (!theme) throw new ApiError("not_found", `theme ${id} does not exist`);
  return stripInternal(theme);
}

export function createTheme(store, themeInput) {
  validateTheme(themeInput);
  const now = new Date().toISOString();
  const record = {
    id: newThemeId(),
    schemaVersion: 1,
    kind: "vera-theme",
    name: themeInput.name,
    colors: themeInput.colors,
    terminal: themeInput.terminal ?? null,
    createdAt: now,
    updatedAt: now,
  };
  return stripInternal(store.insert("themes", record));
}

export function updateTheme(store, id, patch) {
  const theme = store.find("themes", id);
  if (!theme) throw new ApiError("not_found", `theme ${id} does not exist`);
  const next = { updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) {
    if (typeof patch.name !== "string" || !patch.name.trim()) {
      throw new ApiError("invalid_request", "name must be a non-empty string");
    }
    next.name = patch.name;
  }
  if (patch.colors !== undefined) {
    const merged = { ...theme.colors, ...patch.colors };
    for (const key of REQUIRED_COLOR_KEYS) {
      if (typeof merged[key] !== "string") {
        throw new ApiError("invalid_request", `colors.${key} must be a string`);
      }
    }
    next.colors = merged;
  }
  if (patch.terminal !== undefined) {
    next.terminal = patch.terminal;
  }
  const updated = store.update("themes", id, next);
  return stripInternal(updated);
}

export function deleteTheme(store, id, settingsStore) {
  const theme = store.find("themes", id);
  if (!theme) throw new ApiError("not_found", `theme ${id} does not exist`);
  // 被当前 appearance.themeId 引用时拒绝
  if (settingsStore) {
    const themeId = settingsStore.getAll()["appearance.themeId"];
    if (themeId === id) {
      throw new ApiError("conflict", `theme ${id} is currently in use by appearance.themeId`);
    }
  }
  store.remove("themes", id);
}
