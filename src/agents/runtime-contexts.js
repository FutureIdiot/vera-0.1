// Safe model-context capabilities reported by one concrete Agent runtime.

export function modelContextFromCapabilities(capabilities, model) {
  if (typeof model !== "string" || !model) return null;
  const contexts = capabilities?.modelContexts;
  if (!Array.isArray(contexts)) return null;
  const context = contexts.find((item) => item?.model === model);
  if (!context || !Number.isInteger(context.contextWindowTokens) ||
      context.contextWindowTokens <= 0 ||
      !["provider_reported", "verified_config"].includes(context.measurement)) {
    return null;
  }
  return structuredClone(context);
}

export function agentModelContext(agent, model) {
  return modelContextFromCapabilities(
    agent?.runtimeBinding?.runtimeSnapshot?.runtimeCapabilities,
    model,
  );
}
