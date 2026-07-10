// 中控台 Status HTTP 路由（api-contract.md 八、中控台 Status API [P4.6/F1]）。
// GET /api/status 只读，中控台进页时取一次、5s 轮询、离页清理。

import { asHandler, sendJson } from "./http.js";

export function registerStatusRoutes(router, { statusTracker, store, hub, config, memory, settingsStore }) {
  router.get(
    "/api/status",
    asHandler(async ({ res }) => {
      const status = await statusTracker.getStatus({ store, hub, config, memory, settingsStore });
      sendJson(res, 200, { status });
    }),
  );
}
