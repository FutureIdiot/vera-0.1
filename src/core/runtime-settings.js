// Apply the subset of runtime settings whose consumers already exist before
// Phase 5. Data-isolation and digest workers remain Phase 5 work; this module
// must not pretend those consumers exist.
export function applyRuntimeSettings({ settings, config, memoryRetrieval }) {
  config.bubbles.boundaryPattern = settings["presentation.bubbleBoundaryPattern"];
  config.bubbles.minLength = settings["presentation.bubbleMinLength"];
  config.bubbles.maxLength = settings["presentation.bubbleMaxLength"];
  memoryRetrieval.setResidentIndexMaxLines(settings["memory.injectionBudgetResidentLines"]);
  memoryRetrieval.setInjectionTokenBudget(settings["memory.injectionBudgetRetrievalTokens"]);
}
