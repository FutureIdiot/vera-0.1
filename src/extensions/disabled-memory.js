import { ApiError } from "../core/errors.js";

function unavailable() { throw new ApiError("memory_provider_unavailable", "Memory extension is not loaded for this Gateway"); }

export function createDisabledMemoryVault() {
  return {
    getVaultPath: () => null,
    inspect: async () => ({ exists: false, memoryCount: 0, agentDirectoryCount: 0, legacyUnscopedCount: 0 }),
    listMemories: async () => [],
    listWithDiagnostics: async (agentId) => ({ agentId, memories: [], errors: [], index: { generation: 0, status: "unavailable" } }),
    snapshotMemories: async () => ({ memories: [], errors: [], index: { generation: 0, status: "unavailable" } }),
    withExclusiveMutation: async (task) => task(),
    withExclusive: async (task) => task(),
    reopen: () => {},
    applyOperation: unavailable,
    applyBatch: unavailable,
    applyMultiAgentBatch: unavailable,
    applyMultiAgentBatchHeld: unavailable,
    finalizeBatch: unavailable,
    saveMemory: unavailable,
    getMemory: unavailable,
    updateMemory: unavailable,
    deleteMemory: unavailable,
  };
}

export function createDisabledMemoryRetrieval() {
  return {
    setResidentIndexMaxLines: () => {},
    setInjectionTokenBudget: () => {},
    residentIndex: async () => null,
    residentIndexForSession: async () => null,
    searchForInjection: async () => ({ block: null, response: { retrievalId: null, nodes: [], cursor: null, directions: [], budget: { estimator: "vera-utf8-v1", limitTokens: 0, usedTokens: 0, omittedCount: 0, minimumNextNodeTokens: 0 }, degradedChannels: ["memory-extension"] } }),
  };
}

export function createDisabledMemoryConfig() {
  const fail = () => { throw new ApiError("memory_provider_unavailable", "Memory extension is not loaded for this Gateway"); };
  return { initializeExistingAgents: async () => {}, ensureAgentConfig: () => {}, getConfig: fail, getProviderSnapshot: fail, listAll: () => [], patchConfig: fail };
}

export function createDisabledMemoryTaskRuntime() {
  const fail = () => { throw new ApiError("memory_task_unavailable", "Memory extension is not loaded for this Gateway"); };
  return { resolveTaskSnapshot: fail, validateSnapshot: fail, listOptions: () => ({ digest: { executors: [] }, dream: { executors: [] } }), recordVerification: fail, connectionFingerprint: () => null };
}

export function createDisabledMemoryTaskTransport() {
  return { dispatch: async () => { throw new ApiError("memory_task_unavailable", "Memory extension is not loaded for this Gateway"); }, close: () => {} };
}

export function createDisabledMemoryDigestService() {
  return { start: () => {}, close: async () => {}, listJobs: () => [], getJob: () => null, enqueue: async () => { throw new ApiError("memory_provider_unavailable", "Memory extension is not loaded for this Gateway"); }, enqueueIncremental: async () => {}, getIncrementalWindow: () => null };
}

export function createDisabledMemoryDigestScheduler() {
  return { start: () => {}, close: () => {}, onMessageCommitted: () => {}, getPendingContext: () => ({ messageCount: 0, charCount: 0, estimatedTokens: { estimator: "vera-utf8-v1", value: 0 }, spaces: [] }), refreshSettings: () => {}, refreshAgent: () => {}, nextRunAt: () => null };
}

export function createDisabledMemoryDreamService() {
  return { start: () => {}, close: async () => {}, enqueue: async () => { throw new ApiError("memory_provider_unavailable", "Memory extension is not loaded for this Gateway"); }, listJobs: () => [], getJob: () => null, latestJob: () => null, cancel: async () => {}, retry: async () => {} };
}

export function createDisabledMemoryDreamScheduler() {
  return { start: () => {}, close: () => {}, refresh: () => {}, nextRunAt: () => null };
}

export function createDisabledMemoryEmbeddingIndex() { return { drain: async () => {} }; }
