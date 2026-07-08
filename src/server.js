// 唯一入口：路由组合与参数读取（AGENTS.md 结构约束）。业务逻辑都在
// core/ / store/ / api/ / agents/ / spaces/ / adapters/ 里。

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./core/config.js";
import { createStore } from "./store/store.js";
import { createRouter } from "./api/router.js";
import { createEventHub, handleSseRequest } from "./api/sse.js";
import { sendJson, sendError } from "./api/http.js";
import { createStaticHandler } from "./api/static.js";
import { createAgentStateTracker } from "./agents/agent-state.js";
import { registerAgentRoutes } from "./agents/routes.js";
import { registerSpaceRoutes } from "./spaces/routes.js";
import { createMemoryVault } from "./memory/memory.js";
import { registerMemoryRoutes } from "./memory/routes.js";
import { createSettingsStore } from "./core/settings-store.js";
import { registerSettingsRoutes } from "./api/settings-routes.js";
import { createMockAdapter } from "./adapters/mock-adapter.js";
import { createOpencodeAdapter } from "./adapters/opencode-adapter.js";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "frontend");
const serveStatic = createStaticHandler(frontendRoot);

const config = loadConfig(process.env);
const store = await createStore({ dataPath: config.dataPath, debounceMs: config.store.debounceMs });
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
const memory = createMemoryVault({
  vaultPath: config.memory.vaultPath,
  residentIndexMaxLines: config.memory.residentIndexMaxLines,
});

// provider -> adapter：普通的两成员 map，不做注册表抽象
// （AGENTS.md「可配置 ≠ 抽象层」）。
const adapters = {
  mock: createMockAdapter({ chunkDelayMs: config.mock.delayMs }),
  opencode: createOpencodeAdapter({ config: config.opencode }),
};

function resolveAdapter(account) {
  return adapters[account.provider] ?? null;
}

const router = createRouter();

router.get("/api/health", ({ res }) => sendJson(res, 200, { app: "vera", ok: true }));

router.get("/api/bootstrap", ({ res }) => {
  sendJson(res, 200, {
    agents: store.list("agents").map(({ _seq, ...rest }) => rest),
    accounts: store.list("accounts").map(({ _seq, ...rest }) => rest),
    spaces: store.list("spaces").map(({ _seq, ...rest }) => rest),
    agentStates: agentStates.list(),
    seq: hub.currentSeq(),
  });
});

router.get("/api/events", ({ req, res }) => {
  handleSseRequest(hub, req, res, { pingIntervalMs: config.sse.pingIntervalMs });
});

registerAgentRoutes(router, { store, agentStates });
registerSpaceRoutes(router, { store, hub, config, resolveAdapter, agentStates, memory });
registerMemoryRoutes(router, { memory });
// 系统设置（Phase 4.5）：独立 settings.json 模块，不进 store.js（避免与 4.3+4.4 并行分支冲突）。
// boot 顺序：store → hub/agentStates/memory → settingsStore → 路由注册。
const settingsStore = await createSettingsStore({ dataPath: config.dataPath, config });
registerSettingsRoutes(router, { settingsStore });

const server = createServer(async (req, res) => {
  try {
    const handled = await router.handle(req, res);
    if (handled) return;
    // 非 /api/ 路径回退到 frontend/ 静态文件（api-contract.md 系统表）。
    if (!req.url.startsWith("/api/")) {
      const served = await serveStatic(req, res);
      if (served) return;
    }
    sendError(res, 404, "not_found", `no route for ${req.method} ${req.url}`);
  } catch (err) {
    sendError(res, 500, "internal", err?.message || "internal error");
  }
});

server.listen(config.port, () => {
  console.log(`vera gateway listening on :${config.port}`);
});

async function shutdown() {
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
