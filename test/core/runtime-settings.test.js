import test from "node:test";
import assert from "node:assert/strict";
import { applyRuntimeSettings } from "../../src/core/runtime-settings.js";

test("runtime settings update Memory retrieval consumers", () => {
  let residentLines = null;
  let retrievalTokens = null;
  const memoryRetrieval = {
    setResidentIndexMaxLines(value) { residentLines = value; },
    setInjectionTokenBudget(value) { retrievalTokens = value; },
  };
  applyRuntimeSettings({
    memoryRetrieval,
    settings: {
      "memory.injectionBudgetResidentLines": 12,
      "memory.injectionBudgetRetrievalTokens": 384,
    },
  });
  assert.equal(residentLines, 12);
  assert.equal(retrievalTokens, 384);
});
