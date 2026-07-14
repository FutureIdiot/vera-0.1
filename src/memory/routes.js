// Agent-scoped Memory HTTP routes (api-contract.md Memory).

import { asHandler, readJsonBody, sendJson, sendNoContent } from "../api/http.js";
import { ApiError } from "../core/errors.js";

export function registerMemoryRoutes(router, { memory, retrieval, store, digestService = null }) {
  function requireAgent(agentId) {
    const agent = store.find("agents", agentId);
    if (!agent) throw new ApiError("not_found", `agent ${agentId} does not exist`);
    return agent;
  }

  router.get(
    "/api/agents/:agentId/memory",
    asHandler(async ({ res, params }) => {
      requireAgent(params.agentId);
      const result = await memory.listWithDiagnostics(params.agentId);
      const memories = result.memories.map(({ sourceRefs, links, schemaVersion, scope, ...summary }) => ({
        ...summary,
        pinned: retrieval.getPin(params.agentId, summary.slug).pinned,
        sourceCount: sourceRefs?.length ?? summary.sourceCount ?? 0,
      }));
      sendJson(res, 200, { memories, errors: result.errors, index: result.index });
    }),
  );

  router.post(
    "/api/agents/:agentId/memory/_digest",
    asHandler(async ({ req, res, params }) => {
      requireAgent(params.agentId);
      if (!digestService) throw new ApiError("adapter_unavailable", "Memory digest service is unavailable");
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new ApiError("invalid_request", "digest body must be an object");
      }
      const allowed = new Set(["spaceId", "mode", "fromMessageId", "toMessageId"]);
      for (const key of Object.keys(body)) {
        if (!allowed.has(key)) throw new ApiError("invalid_request", `unknown digest field: ${key}`);
      }
      const job = await digestService.enqueue({
        agentId: params.agentId,
        trigger: "manual",
        spaceId: body?.spaceId,
        mode: body?.mode,
        fromMessageId: body?.fromMessageId,
        toMessageId: body?.toMessageId,
      });
      sendJson(res, 202, { job });
    }),
  );

  router.put(
    "/api/agents/:agentId/memory/:slug/pin",
    asHandler(async ({ req, res, params }) => {
      requireAgent(params.agentId);
      await memory.getMemory(params.agentId, params.slug);
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 1 || typeof body.pinned !== "boolean") {
        throw new ApiError("invalid_request", "pin body must be exactly { pinned: boolean }");
      }
      const signal = retrieval.setPinned(params.agentId, params.slug, body.pinned);
      sendJson(res, 200, { pin: {
        slug: signal.slug,
        pinned: signal.pinned,
        ...(signal.pinnedAt ? { pinnedAt: signal.pinnedAt } : {}),
      } });
    }),
  );

  router.get(
    "/api/agents/:agentId/memory/_digest-jobs",
    asHandler(async ({ res, params }) => {
      requireAgent(params.agentId);
      sendJson(res, 200, { jobs: digestService ? digestService.listJobs(params.agentId) : [] });
    }),
  );

  router.get(
    "/api/agents/:agentId/memory/_digest-jobs/:jobId",
    asHandler(async ({ res, params }) => {
      requireAgent(params.agentId);
      if (!digestService) throw new ApiError("not_found", `digest job ${params.jobId} does not exist`);
      sendJson(res, 200, { job: digestService.getJob(params.agentId, params.jobId) });
    }),
  );

  for (const action of ["retry", "cancel"]) {
    router.post(
      `/api/agents/:agentId/memory/_digest-jobs/:jobId/${action}`,
      asHandler(async ({ res, params }) => {
        requireAgent(params.agentId);
        if (!digestService) throw new ApiError("not_found", `digest job ${params.jobId} does not exist`);
        const job = await digestService[action](params.agentId, params.jobId);
        sendJson(res, 200, { job });
      }),
    );
  }

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
    asHandler(async ({ res, params, query }) => {
      requireAgent(params.agentId);
      await memory.deleteMemory(params.agentId, params.slug, query.get("ifMatch") ?? undefined);
      sendNoContent(res);
    }),
  );
}
