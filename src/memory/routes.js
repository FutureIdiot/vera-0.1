// Memory HTTP 路由（api-contract.md Memory 一节）。
// 最小闭环：列表 + 手动保存；F1 扩 GET/PATCH/DELETE /api/memory/:slug 编辑端点。

import { asHandler, readJsonBody, sendJson, sendNoContent } from "../api/http.js";
import { ApiError } from "../core/errors.js";

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

  router.get(
    "/api/memory/:slug",
    asHandler(async ({ res, params }) => {
      const mem = await memory.getMemory(params.slug);
      sendJson(res, 200, { memory: mem });
    }),
  );

  router.patch(
    "/api/memory/:slug",
    asHandler(async ({ req, res, params }) => {
      const body = await readJsonBody(req);
      const mem = await memory.updateMemory(params.slug, body);
      sendJson(res, 200, { memory: mem });
    }),
  );

  router.delete(
    "/api/memory/:slug",
    asHandler(async ({ res, params }) => {
      await memory.deleteMemory(params.slug);
      sendNoContent(res);
    }),
  );
}
