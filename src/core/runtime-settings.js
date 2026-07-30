// Apply the subset of runtime settings whose consumers already exist before
// Phase 5. Data-isolation and digest workers remain Phase 5 work; this module
// must not pretend those consumers exist.
export function applyRuntimeSettings({ settings, memoryRetrieval }) {
  memoryRetrieval.setResidentIndexMaxLines(settings["memory.injectionBudgetResidentLines"]);
  memoryRetrieval.setInjectionTokenBudget(settings["memory.injectionBudgetRetrievalTokens"]);
}
