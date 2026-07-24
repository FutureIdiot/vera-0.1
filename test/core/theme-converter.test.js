import test from "node:test";
import assert from "node:assert/strict";

import { parseTheme } from "../../src/core/theme-converter.js";

test("Vera CSS uses the same canonical palette names as the frontend", () => {
  const { theme } = parseTheme({
    format: "vera-css",
    content: `:root {
      --vera-color-background: #020617;
      --vera-color-surface: #0f172a;
      --vera-color-text: #e2e8f0;
      --vera-color-muted-text: #64748b;
      --vera-color-border: #334155;
      --vera-color-accent: #6366f1;
      --vera-color-success: #34d399;
      --vera-color-warning: #f59e0b;
      --vera-color-error: #f87171;
    }`,
  });

  assert.deepEqual(theme.colors, {
    background: "#020617",
    surface: "#0f172a",
    text: "#e2e8f0",
    mutedText: "#64748b",
    border: "#334155",
    accent: "#6366f1",
    success: "#34d399",
    warning: "#f59e0b",
    error: "#f87171",
  });
});
