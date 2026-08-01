import { ApiError } from "../core/errors.js";

function unavailable() {
  throw new ApiError("memory_provider_unavailable", "Memory extension is not loaded for this Agent");
}

/** Gateway facade: storage remains inside the external extension worker. */
export function createExternalMemoryRuntime({ loader }) {
  if (!loader) throw new TypeError("external memory runtime requires an extension loader");
  function provider(agentId) { return loader.getAgentCapability(agentId, "memory-provider"); }
  function requireProvider(agentId) {
    const current = provider(agentId);
    if (!current) unavailable();
    return current;
  }
  async function call(agentId, name, arguments_) {
    const current = requireProvider(agentId);
    return loader.callMcp(current.extension.extensionId, agentId, { name, arguments: arguments_ });
  }
  function summaryResult(agentId, result) {
    return { agentId, memories: Array.isArray(result?.memories) ? result.memories : [], errors: [], index: { generation: null, status: "external" } };
  }
  return {
    isAvailable: (agentId) => Boolean(provider(agentId)),
    setResidentIndexMaxLines: () => {},
    setInjectionTokenBudget: () => {},
    getVaultPath: () => null,
    inspect: async () => ({ exists: true, memoryCount: null, agentDirectoryCount: null, legacyUnscopedCount: 0 }),
    listWithDiagnostics: async (agentId) => summaryResult(agentId, await call(agentId, "memory_list", {})),
    listMemories: async (agentId) => (await call(agentId, "memory_list", {})).memories ?? [],
    snapshotMemories: async (agentId) => summaryResult(agentId, await call(agentId, "memory_list", {})),
    getMemory: async (agentId, slug) => (await call(agentId, "memory_fetch_detail", { slug })).memory,
    saveMemory: async (agentId, value) => (await call(agentId, "memory_create", value)).memory,
    updateMemory: async (agentId, slug, value) => (await call(agentId, "memory_update", { ...value, slug })).memory,
    deleteMemory: async (agentId, slug) => { await call(agentId, "memory_delete", { slug }); },
    searchForInjection: async ({ context, query }) => {
      const current = provider(context.agentId);
      if (!current) return { block: null, response: { retrievalId: null, nodes: [], degradedChannels: ["memory-extension"] } };
      return loader.callHook(current.extension.extensionId, context.agentId, {
        unitId: "vera.memory.recall",
        event: { query, limit: 6, context: { spaceId: context.spaceId, triggerMessageId: context.triggerMessageId } },
      });
    },
    residentIndex: async () => null,
    residentIndexForSession: async () => null,
    ensureSession: async () => {},
    fetchMore: async () => ({ block: null, response: { retrievalId: null, nodes: [] } }),
    getPin: () => ({ pinned: false }),
    setPin: unavailable,
    recordUserEdit: () => {},
    listSignals: () => [],
    drain: async () => {},
    withExclusiveMutation: async (task) => task({ snapshotMemories: async (agentId) => summaryResult(agentId, await call(agentId, "memory_list", {})), applyMultiAgentBatch: unavailable }),
    withExclusive: async (task) => task(),
    reopen: () => {},
    applyOperation: unavailable,
    applyBatch: unavailable,
    applyMultiAgentBatch: unavailable,
    finalizeBatch: unavailable,
  };
}
