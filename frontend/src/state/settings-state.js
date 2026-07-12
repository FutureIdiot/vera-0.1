const TOKEN_MAP = {
  "appearance.fontSize.phone.chat": "--vera-font-size-phone-chat",
  "appearance.fontSize.phone.management": "--vera-font-size-phone-management",
  "appearance.fontSize.desktop.chat": "--vera-font-size-desktop-chat",
  "appearance.fontSize.desktop.management": "--vera-font-size-desktop-management",
  "appearance.bubbleRadius.phone": "--vera-bubble-radius-phone",
  "appearance.bubbleRadius.desktop": "--vera-bubble-radius-desktop",
  "appearance.bubbleGap.phone": "--vera-bubble-gap-phone",
  "appearance.bubbleGap.desktop": "--vera-bubble-gap-desktop",
  "appearance.windowMargin.phone.chat": "--vera-window-margin-phone-chat",
  "appearance.windowMargin.phone.management": "--vera-window-margin-phone-management",
  "appearance.windowMargin.desktop.chat": "--vera-window-margin-desktop-chat",
  "appearance.windowMargin.desktop.management": "--vera-window-margin-desktop-management",
};

const COLOR_SETTING_MAP = {
  "appearance.themeColor": "--vera-color-theme",
  "appearance.accentColor": "--vera-color-accent",
};

const THEME_COLOR_MAP = {
  background: "--vera-color-bg",
  surface: "--vera-color-surface",
  text: "--vera-color-text",
  mutedText: "--vera-color-text-muted",
  border: "--vera-color-border",
  accent: "--vera-color-accent",
  success: "--vera-color-success",
  error: "--vera-color-danger",
};

const SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

function cssValue(key, value) {
  if (key.includes("fontSize") || key.includes("Radius") || key.includes("Gap") || key.includes("Margin")) {
    return `${value}px`;
  }
  return String(value);
}

export function applyAppearanceSettings(settings, root = document.documentElement, { preservePalette = false } = {}) {
  const theme = settings?.["appearance.theme"];
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;

  const font = settings?.["appearance.fontFamily"];
  if (font) root.style.setProperty("--vera-font-family", font === "system" ? SYSTEM_FONT : font);
  else root.style.removeProperty("--vera-font-family");

  for (const [key, property] of Object.entries(TOKEN_MAP)) {
    const value = settings?.[key];
    if (value !== undefined && value !== null && value !== "") root.style.setProperty(property, cssValue(key, value));
    else root.style.removeProperty(property);
  }
  for (const [key, property] of Object.entries(COLOR_SETTING_MAP)) {
    const value = settings?.[key];
    if (value !== undefined && value !== null && value !== "") root.style.setProperty(property, String(value));
    else if (!preservePalette) root.style.removeProperty(property);
  }
}

export function applyThemePalette(theme, root = document.documentElement) {
  for (const [key, property] of Object.entries(THEME_COLOR_MAP)) {
    const value = theme?.colors?.[key];
    if (value) root.style.setProperty(property, value);
    else root.style.removeProperty(property);
  }
}

export function applyResolvedAppearance(settings, theme = null, root = document.documentElement) {
  applyThemePalette(theme, root);
  applyAppearanceSettings(settings, root, { preservePalette: Boolean(theme) });
}
