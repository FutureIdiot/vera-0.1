import test from "node:test";
import assert from "node:assert/strict";
import { applyRuntimeSettings } from "../../src/core/runtime-settings.js";

test("runtime settings update bubble and Memory retrieval consumers", () => {
  const config = { bubbles: { boundaryPattern: "old", minLength: 1, maxLength: 2 } };
  let residentLines = null;
  let retrievalTokens = null;
  const memoryRetrieval = {
    setResidentIndexMaxLines(value) { residentLines = value; },
    setInjectionTokenBudget(value) { retrievalTokens = value; },
  };
  applyRuntimeSettings({
    config,
    memoryRetrieval,
    settings: {
      "presentation.bubbleBoundaryPattern": "new",
      "presentation.bubbleMinLength": 3,
      "presentation.bubbleMaxLength": 400,
      "memory.injectionBudgetResidentLines": 12,
      "memory.injectionBudgetRetrievalTokens": 384,
    },
  });
  assert.deepEqual(config.bubbles, { boundaryPattern: "new", minLength: 3, maxLength: 400 });
  assert.equal(residentLines, 12);
  assert.equal(retrievalTokens, 384);
});
