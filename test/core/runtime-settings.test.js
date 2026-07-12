import test from "node:test";
import assert from "node:assert/strict";
import { applyRuntimeSettings } from "../../src/core/runtime-settings.js";

test("runtime settings update the existing bubble and resident-index consumers", () => {
  const config = { bubbles: { boundaryPattern: "old", minLength: 1, maxLength: 2 } };
  let residentLines = null;
  const memory = { setResidentIndexMaxLines(value) { residentLines = value; } };
  applyRuntimeSettings({
    config,
    memory,
    settings: {
      "presentation.bubbleBoundaryPattern": "new",
      "presentation.bubbleMinLength": 3,
      "presentation.bubbleMaxLength": 400,
      "memory.injectionBudgetResidentLines": 12,
    },
  });
  assert.deepEqual(config.bubbles, { boundaryPattern: "new", minLength: 3, maxLength: 400 });
  assert.equal(residentLines, 12);
});
