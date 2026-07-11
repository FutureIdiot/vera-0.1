// Agent-scoped Memory HTTP routes (api-contract.md Memory).

import { asHandler, readJsonBody, sendJson, sendNoContent } from "../api/http.js";
import { ApiError } from "../core/errors.js";

export function registerMemoryRoutes(router, { memory, store }) {
  function requireAgent(agentId) {
    const agent = store.find("agents", agentId);
    if (!agent) throw new ApiError("not_found", `agent ${agentId} does not exist`);
    return agent;
  }

  router.get(
    "/api/agents/:agentId/memory",
    asHandler(async ({ res, params }) => {
      requireAgent(params.agentId);
      sendJson(res, 200, { memories: await memory.listMemories(params.agentId) });
    }),
  );

  router.post(
    "/api/agents/:agentId/memory",
    asHandler(async ({ req, res, params }) => {
      requireAgent(params.agentId);
      const body = await readJsonBody(req);
      const saved = await memory.saveMemory(params.agentId, body);
      sendJson(res, 201, { memory: saved });
    }),
  );

  router.get(
    "/api/agents/:agentId/memory/:slug",
    asHandler(async ({ res, params }) => {
      requireAgent(params.agentId);
      const mem = await memory.getMemory(params.agentId, params.slug);
      sendJson(res, 200, { memory: mem });
    }),
  );

  router.patch(
    "/api/agents/:agentId/memory/:slug",
    asHandler(async ({ req, res, params }) => {
      requireAgent(params.agentId);
      const body = await readJsonBody(req);
      const mem = await memory.updateMemory(params.agentId, params.slug, body);
      sendJson(res, 200, { memory: mem });
    }),
  );

  router.delete(
    "/api/agents/:agentId/memory/:slug",
    asHandler(async ({ res, params }) => {
      requireAgent(params.agentId);
      await memory.deleteMemory(params.agentId, params.slug);
      sendNoContent(res);
    }),
  );
}
