// 唯一入口：路由组合与参数读取（AGENTS.md 结构约束）。业务逻辑都在
// core/ / store/ / api/ / agents/ / spaces/ / adapters/ 里。

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./core/config.js";
import { applyBootPathOverrides } from "./core/path-overrides.js";
import { createStore } from "./store/store.js";
import { createRouter } from "./api/router.js";
import { createEventHub, handleSseRequest } from "./api/sse.js";
import { sendJson, sendError } from "./api/http.js";
import { createStaticHandler } from "./api/static.js";
import { createAgentStateTracker } from "./agents/agent-state.js";
import { registerAgentRoutes } from "./agents/routes.js";
import { listSpaces } from "./spaces/spaces.js";
import { registerSpaceRoutes } from "./spaces/routes.js";
import { createMemoryVault } from "./memory/memory.js";
import { createMemoryEmbeddingIndex } from "./memory/memory-embedding-index.js";
import { createMemoryRetrievalService } from "./memory/memory-retrieval.js";
import { registerMemoryRoutes } from "./memory/routes.js";
import { createMemoryDigestService } from "./memory/memory-digest-service.js";
import { createMemoryDigestScheduler } from "./memory/memory-digest-scheduler.js";
import { createMemoryDreamService } from "./memory/memory-dream-service.js";
import { createMemoryDreamScheduler } from "./memory/memory-dream-scheduler.js";
import { createMemoryConfigService } from "./memory/memory-config.js";
import { createMemoryTaskRuntime } from "./memory/memory-task-runtime.js";
import { createSettingsStore } from "./core/settings-store.js";
import { registerSettingsRoutes } from "./api/settings-routes.js";
import { createStatusTracker } from "./core/status.js";
import { registerStatusRoutes } from "./api/status-routes.js";
import { registerPathsRoutes } from "./api/paths-routes.js";
import { registerThemesRoutes } from "./api/themes-routes.js";
import { applyRuntimeSettings } from "./core/runtime-settings.js";
import { listAccounts } from "./agents/accounts.js";
import { listAgents } from "./agents/agents.js";
import { ensureUnitBindings, getUnitBinding } from "./agents/unit-bindings.js";
import { createMockAdapter } from "./adapters/mock-adapter.js";
import { createOllamaAdapter } from "./adapters/ollama-adapter.js";
import { createOpencodeAdapter } from "./adapters/opencode-adapter.js";
import { createCodexAdapter } from "./adapters/codex-adapter.js";
import { createContextCompactionService } from "./spaces/context-compactions.js";
import { recoverInterruptedRuns } from "./spaces/run-controller.js";
import { createFilesService } from "./memory/files-service.js";
import { registerFilesRoutes } from "./memory/files-routes.js";
import { createControlService } from "./agents/control-service.js";
import { recoverAccountPresence } from "./agents/account-presence.js";
import { createDaemonRuntime } from "./agents/daemon-runtime.js";
import { createRequestSecurity } from "./api/request-security.js";
import { createDaemonRunLifecycle } from "./spaces/daemon-run-lifecycle.js";
import { createDaemonRunScheduler } from "./spaces/daemon-run-scheduler.js";
import { createMemoryTaskTransport } from "./memory/memory-task-transport.js";
import { registerMemoryTaskRoutes } from "./memory/memory-task-routes.js";
import { createGatewayUpdateControl } from "./core/gateway-updates.js";
import { registerSystemUpdateRoutes } from "./api/system-update-routes.js";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "frontend", "dist");
const serveStatic = createStaticHandler(frontendRoot);

const config = loadConfig(process.env);
const enforceRequestSecurity = createRequestSecurity({ config });
const updateControl = createGatewayUpdateControl({ config: config.updates });
const bootPaths = await applyBootPathOverrides(config);
const store = await createStore({ dataPath: config.dataPath, debounceMs: config.store.debounceMs });
recoverAccountPresence(store);
recoverInterruptedRuns(store);
// seq 跨重启单调（api-contract.md）：从持久化水位 + 缓冲长度跳跃续增，
// 保证客户端带上一世的 since 重连必然触发 stream.reset 而不是静默漏事件。
const seqWatermark = store.getEventSeqWatermark();
const hub = createEventHub({
  bufferSize: config.sse.bufferSize,
  pingIntervalMs: config.sse.pingIntervalMs,
  initialSeq: seqWatermark > 0 ? seqWatermark + config.sse.bufferSize : 0,
  onSeqAdvance: (seq) => store.setEventSeqWatermark(seq),
});
const agentStates = createAgentStateTracker({ hub });
const settingsStore = await createSettingsStore({ dataPath: config.dataPath, config });
const files = await createFilesService({
  store,
  settingsStore,
  rootPath: config.files.attachmentsPath,
  maxUploadBytes: config.files.maxUploadBytes,
  maxAttachmentsPerMessage: config.files.maxAttachmentsPerMessage,
});
const memoryTaskRuntime = createMemoryTaskRuntime({ store });
const memoryTaskTransport = createMemoryTaskTransport({
  taskRuntime: memoryTaskRuntime,
  timeoutMs: config.memory.taskDaemonTimeoutMs,
});
const memoryConfig = createMemoryConfigService({
  store,
  settingsStore,
  config,
  validateTaskSelection: ({ ownerAgentId, taskKind, taskConfig }) =>
    memoryTaskRuntime.resolveTaskSnapshot({ ownerAgentId, taskKind, taskConfig }),
});
await memoryConfig.initializeExistingAgents();
for (const agent of store.list("agents")) ensureUnitBindings(store, agent.id);
const controlService = createControlService({
  store,
  config,
  agentStates,
  memoryConfigService: memoryConfig,
  hub,
});
const memory = createMemoryVault({
  vaultPath: config.memory.vaultPath,
  resolveSource: ({ messageId }) => store.find("messages", messageId),
  onExternalEdit: ({ agentId, slug }) => {
    const id = `edit:${agentId}:${slug}`;
    const signal = { id, agentId, slug, kind: "user_edited", createdAt: new Date().toISOString() };
    if (store.find("memorySignals", id)) store.update("memorySignals", id, signal);
    else store.insert("memorySignals", signal);
  },
});
const memoryEmbeddingIndex = createMemoryEmbeddingIndex({ memory });
const memoryRetrieval = createMemoryRetrievalService({
  store,
  memory,
  embeddingIndex: memoryEmbeddingIndex,
  config: {
    residentIndexMaxLines: config.memory.residentIndexMaxLines,
    injectionTokenBudget: config.memory.retrievalTokenBudget,
    derivedWeightSeed: config.memory.derivedWeightSeed,
  },
  isRecallEnabled: (agentId) => getUnitBinding(store, agentId, "vera.memory.recall").enabled,
});

// provider -> adapter：显式的普通map，不做注册表抽象
// （AGENTS.md「可配置 ≠ 抽象层」）。
const adapters = {
  mock: createMockAdapter({ chunkDelayMs: config.mock.delayMs }),
  ollama: createOllamaAdapter({ config: config.ollama }),
  opencode: createOpencodeAdapter({ config: config.opencode }),
  codex: createCodexAdapter({ config: config.codex }),
};
const memoryDigestAdapters = {
  ollama: adapters.ollama,
  codex: adapters.codex,
};

const contextCompaction = createContextCompactionService({
  store,
  hub,
  config,
  dispatchDaemonCompaction: (request) => daemonRuntime.dispatchEvent(request),
});

function freezeMemoryTask({ ownerAgentId, kind }) {
  const record = memoryConfig.getConfig(ownerAgentId);
  const memoryTaskSnapshot = memoryTaskRuntime.resolveTaskSnapshot({
    ownerAgentId,
    taskKind: kind,
    taskConfig: record.config[kind],
  });
  return { memoryTaskSnapshot, memoryProviderSnapshot: memoryConfig.getProviderSnapshot(ownerAgentId) };
}

function validateMemoryTask({ memoryTaskSnapshot, memoryProviderSnapshot }) {
  const currentProvider = memoryConfig.getProviderSnapshot(memoryTaskSnapshot?.ownerAgentId);
  if (!memoryProviderSnapshot || currentProvider.providerId !== memoryProviderSnapshot.providerId ||
      currentProvider.bindingVersion !== memoryProviderSnapshot.bindingVersion ||
      currentProvider.configVersion !== memoryProviderSnapshot.configVersion) {
    throw Object.assign(new Error("Memory Provider binding changed after enqueue"), { code: "memory_provider_unavailable" });
  }
  return memoryTaskRuntime.validateSnapshot(memoryTaskSnapshot);
}

async function executeMemoryDigest({ job, chunks, facts, proposalSchema, signal }) {
  const agent = store.find("agents", job.agentId);
  const { runtime, taskModel } = validateMemoryTask(job);
  const payload = { agent: { id: agent?.id, name: agent?.name }, chunks, facts, proposalSchema };
  if (config.memory.taskTransport === "daemon") {
    return memoryTaskTransport.dispatch({
      jobId: job.id,
      kind: "digest",
      memoryTaskSnapshot: job.memoryTaskSnapshot,
      payload,
      signal,
    });
  }
  const adapter = memoryDigestAdapters[runtime.provider] ?? null;
  if (!agent || !adapter?.digestMemory) {
    throw Object.assign(new Error("Memory digest executor is unavailable"), { code: "memory_task_unavailable" });
  }
  return adapter.digestMemory({
    runtime,
    taskModel,
    payload,
    signal,
  });
}

async function executeMemoryDream({ job, payload, signal }) {
  const { runtime, taskModel } = validateMemoryTask(job);
  if (config.memory.taskTransport === "daemon") {
    return memoryTaskTransport.dispatch({
      jobId: job.id,
      kind: "dream",
      memoryTaskSnapshot: job.memoryTaskSnapshot,
      payload,
      signal,
    });
  }
  const adapter = memoryDigestAdapters[runtime.provider] ?? null;
  if (!adapter?.dreamMemory) {
    throw Object.assign(new Error("Memory Dream executor is unavailable"), { code: "memory_task_unavailable" });
  }
  return adapter.dreamMemory({ runtime, taskModel, payload, signal });
}

applyRuntimeSettings({ settings: settingsStore.getAll(), config, memoryRetrieval });
const memoryDigestService = createMemoryDigestService({
  store,
  memory,
  freezeTask: freezeMemoryTask,
  validateTaskSnapshot: validateMemoryTask,
  proposalExecutor: executeMemoryDigest,
  onJobUpdated: (job) => hub.publish("memory.digest-job.updated", { job }),
});
const memoryDigestScheduler = createMemoryDigestScheduler({
  store,
  digestService: memoryDigestService,
  configService: memoryConfig,
  isWriteEnabled: (agentId) => getUnitBinding(store, agentId, "vera.memory.write").enabled,
});
const memoryDreamService = createMemoryDreamService({
  store,
  memory,
  freezeTask: freezeMemoryTask,
  validateTaskSnapshot: validateMemoryTask,
  proposalExecutor: executeMemoryDream,
  batchSize: config.memory.dreamBatchSize,
  onJobUpdated: (job) => hub.publish("memory.dream-job.updated", { agentId: job.agentId, job }),
});
const memoryDreamScheduler = createMemoryDreamScheduler({ configService: memoryConfig, dreamService: memoryDreamService });
memoryDigestService.start();
memoryDigestScheduler.start();
memoryDreamService.start();
memoryDreamScheduler.start();

const daemonRunLifecycle = createDaemonRunLifecycle({
  store,
  hub,
  config,
  agentStates,
  memoryDigestScheduler,
  contextCompaction,
});
const daemonRuntime = createDaemonRuntime({
  store,
  hub,
  agentStates,
  controlService,
  config,
  runLifecycle: daemonRunLifecycle,
});
const daemonScheduler = createDaemonRunScheduler({
  store,
  hub,
  config,
  controlService,
  daemonRuntime,
  agentStates,
  memoryRetrieval,
  memoryDigestScheduler,
  contextCompaction,
});

const router = createRouter();

router.get("/api/health", ({ res }) => sendJson(res, 200, { app: "vera", ok: true }));

router.get("/api/bootstrap", ({ res }) => {
  sendJson(res, 200, {
    agents: listAgents(store),
    accounts: listAccounts(store),
    spaces: listSpaces(store), // 默认只返活跃（api-contract.md 260）
    agentStates: agentStates.list(),
    seq: hub.currentSeq(),
  });
});

router.get("/api/events", ({ req, res }) => {
  handleSseRequest(hub, req, res, { pingIntervalMs: config.sse.pingIntervalMs });
});

registerAgentRoutes(router, {
  store,
  agentStates,
  memoryConfigService: memoryConfig,
  controlService,
  daemonRuntime,
});
registerMemoryTaskRoutes(router, {
  controlService,
  transport: memoryTaskTransport,
  heartbeatIntervalMs: config.agentDaemon.heartbeatIntervalMs,
});
registerSpaceRoutes(router, {
  store, hub, config, daemonScheduler, daemonRuntime, daemonRunLifecycle,
  memoryDigestScheduler, contextCompaction, memory, files,
});
registerFilesRoutes(router, { files, hub });
registerMemoryRoutes(router, {
  memory,
  retrieval: memoryRetrieval,
  store,
  digestService: memoryDigestService,
  dreamService: memoryDreamService,
  configService: memoryConfig,
  taskRuntime: memoryTaskRuntime,
  digestScheduler: memoryDigestScheduler,
  dreamScheduler: memoryDreamScheduler,
});
// 系统设置（Phase 4.5）：独立 settings.json 模块，不进 store.js（避免与 4.3+4.4 并行分支冲突）。
// boot 顺序：store → hub/agentStates/memory → settingsStore → 路由注册。
registerSettingsRoutes(router, {
  settingsStore,
  onSettingsChanged: (settings) => {
    applyRuntimeSettings({ settings, config, memoryRetrieval });
  },
});
registerSystemUpdateRoutes(router, { updateControl });

const statusTracker = createStatusTracker({ config });
registerStatusRoutes(router, { statusTracker, store, hub, config, memory, settingsStore });
registerPathsRoutes(router, { config, settingsStore, memory, files, store, bootPaths });
registerThemesRoutes(router, { store, settingsStore });

const server = createServer(async (req, res) => {
  try {
    if (enforceRequestSecurity(req, res)) return;
    const handled = await router.handle(req, res);
    if (handled) return;
    // 非 /api/ 路径回退到 production build（frontend/dist/）。
    if (!req.url.startsWith("/api/")) {
      const served = await serveStatic(req, res);
      if (served) return;
    }
    sendError(res, 404, "not_found", `no route for ${req.method} ${req.url}`);
  } catch (err) {
    sendError(res, 500, "internal", err?.message || "internal error");
  }
});

server.listen(config.port, config.host, () => {
  console.log(`vera gateway listening on ${config.host}:${config.port}`);
});

async function shutdown() {
  memoryDigestScheduler.close();
  memoryDreamScheduler.close();
  await memoryDreamService.close();
  await memoryDigestService.close();
  await memoryEmbeddingIndex.drain();
  for (const adapter of Object.values(adapters)) {
    try {
      await adapter.shutdown?.();
    } catch {
      // 尽力而为，不阻塞退出
    }
  }
  await store.close();
  await settingsStore?.close();
  server.close(() => process.exit(0));
  // SSE 长连接不主动断，server.close 会永远等；强制掐掉存量连接
  server.closeAllConnections?.();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
