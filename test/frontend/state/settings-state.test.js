import test from "node:test";
import assert from "node:assert/strict";

import { applyAppearanceSettings } from "../../../frontend/src/state/settings-state.js";

function createRoot() {
  const properties = new Map();
  return {
    dataset: {},
    style: {
      setProperty(name, value) { properties.set(name, value); },
      removeProperty(name) { properties.delete(name); },
    },
  };
}

test("custom Theme keeps its own selector scope instead of inheriting built-in dark derivations", () => {
  const root = createRoot();

  applyAppearanceSettings({ "appearance.theme": "custom" }, root);

  assert.equal(root.dataset.theme, "custom");
});

test("system Theme leaves media queries in control", () => {
  const root = createRoot();
  root.dataset.theme = "dark";

  applyAppearanceSettings({ "appearance.theme": "system" }, root);

  assert.equal("theme" in root.dataset, false);
});
