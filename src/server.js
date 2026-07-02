// 唯一入口：路由组合与参数读取（AGENTS.md 结构约束）。业务逻辑都在
// core/ / store/ / api/ / agents/ / spaces/ / adapters/ 里。

import { createServer } from "node:http";
import { loadConfig } from "./core/config.js";
import { createStore } from "./store/store.js";
import { createRouter } from "./api/router.js";
import { createEventHub, handleSseRequest } from "./api/sse.js";
import { sendJson, sendError } from "./api/http.js";
import { createAgentStateTracker } from "./agents/agent-state.js";
import { registerAgentRoutes } from "./agents/routes.js";
import { registerSpaceRoutes } from "./spaces/routes.js";
import { createMockAdapter } from "./adapters/mock-adapter.js";

const config = loadConfig(process.env);
const store = await createStore({ dataPath: config.dataPath, debounceMs: config.store.debounceMs });
const hub = createEventHub({ bufferSize: config.sse.bufferSize, pingIntervalMs: config.sse.pingIntervalMs });
const agentStates = createAgentStateTracker({ hub });
const mockAdapter = createMockAdapter({ chunkDelayMs: config.mock.delayMs });

// 本次只实现示例 C（mock adapter）；provider -> adapter 的映射先写死这一条，
// 不预建插件注册表（AGENTS.md「可配置 ≠ 抽象层」），等第二个真实 adapter
// （OpenCode）落地时再看要不要抽出去。
function resolveAdapter(agent) {
  if (agent.provider === "mock") return mockAdapter;
  return null;
}

const router = createRouter();

router.get("/api/health", ({ res }) => sendJson(res, 200, { app: "vera", ok: true }));

router.get("/api/bootstrap", ({ res }) => {
  sendJson(res, 200, {
    agents: store.list("agents").map(({ _seq, ...rest }) => rest),
    spaces: store.list("spaces").map(({ _seq, ...rest }) => rest),
    agentStates: agentStates.list(),
    seq: hub.currentSeq(),
  });
});

router.get("/api/events", ({ req, res }) => {
  handleSseRequest(hub, req, res, { pingIntervalMs: config.sse.pingIntervalMs });
});

registerAgentRoutes(router, { store, agentStates });
registerSpaceRoutes(router, { store, hub, config, resolveAdapter, agentStates });

const server = createServer(async (req, res) => {
  try {
    const handled = await router.handle(req, res);
    if (!handled) sendError(res, 404, "not_found", `no route for ${req.method} ${req.url}`);
  } catch (err) {
    sendError(res, 500, "internal", err?.message || "internal error");
  }
});

server.listen(config.port, () => {
  console.log(`vera gateway listening on :${config.port}`);
});

async function shutdown() {
  await store.close();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
