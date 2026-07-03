// Memory HTTP 路由（api-contract.md Memory 一节，最小闭环：列表 + 手动保存）。

import { asHandler, readJsonBody, sendJson } from "../api/http.js";

export function registerMemoryRoutes(router, { memory }) {
  router.get(
    "/api/memory",
    asHandler(async ({ res }) => {
      sendJson(res, 200, { memories: await memory.listMemories() });
    }),
  );

  router.post(
    "/api/memory",
    asHandler(async ({ req, res }) => {
      const body = await readJsonBody(req);
      const saved = await memory.saveMemory(body);
      sendJson(res, 201, { memory: saved });
    }),
  );
}
