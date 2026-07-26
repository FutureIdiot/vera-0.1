import test from "node:test";
import assert from "node:assert/strict";

import { parseTheme } from "../../src/core/theme-converter.js";

test("Vera CSS uses the same canonical palette names as the frontend", () => {
  const { theme } = parseTheme({
    format: "vera-css",
    content: `:root {
      --vera-color-background: #181818;
      --vera-color-surface: #181818;
      --vera-color-text: #ffffff;
      --vera-color-muted-text: #bababa;
      --vera-color-border: #2b2b2b;
      --vera-color-accent: #339cff;
      --vera-color-success: #40c977;
      --vera-color-warning: #ff8549;
      --vera-color-error: #ff6764;
    }`,
  });

  assert.deepEqual(theme.colors, {
    background: "#181818",
    surface: "#181818",
    text: "#ffffff",
    mutedText: "#bababa",
    border: "#2b2b2b",
    accent: "#339cff",
    success: "#40c977",
    warning: "#ff8549",
    error: "#ff6764",
  });
});
