// Agent-scoped Memory HTTP routes (api-contract.md Memory).

import { asHandler, readJsonBody, sendJson, sendNoContent } from "../api/http.js";
import { ApiError } from "../core/errors.js";
import { getUnitBinding } from "../agents/unit-bindings.js";

const MARKDOWN_CAPABILITIES = Object.freeze({
  list: true, fetch: true, search: true, create: true, update: true,
  archive: true, delete: true, sources: true, versioning: true, pin: true,
  links: true, usage: true, externalEdit: true, digest: true, dream: true,
});

const MARKDOWN_PROVIDER_OPTION = Object.freeze({
  providerId: "vera.markdown",
  name: "Vera Markdown",
  source: "built-in",
  kind: "memory-provider",
  availability: "available",
  capabilities: MARKDOWN_CAPABILITIES,
  configSchema: { type: "object", additionalProperties: false },
  locationKind: "file",
});

export function registerMemoryRoutes(router, {
  memory, retrieval, store, digestService = null, dreamService = null,
  configService = null, taskRuntime = null, digestScheduler = null, dreamScheduler = null,
}) {
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

  router.get(
    "/api/agents/:agentId/memory/_config",
    asHandler(async ({ res, params }) => {
      requireAgent(params.agentId);
      if (!configService) throw new ApiError("memory_provider_unavailable", "Memory configuration is unavailable");
      sendJson(res, 200, configService.getConfig(params.agentId));
    }),
  );

  router.patch(
    "/api/agents/:agentId/memory/_config",
    asHandler(async ({ req, res, params }) => {
      requireAgent(params.agentId);
      if (!configService) throw new ApiError("memory_provider_unavailable", "Memory configuration is unavailable");
      const body = await readJsonBody(req);
      const current = configService.getConfig(params.agentId);
      if (body?.provider?.providerId && body.provider.providerId !== current.config.provider.providerId) {
        const activeDigest = digestService?.listJobs(params.agentId).some((job) => ["queued", "running", "applying"].includes(job.status));
        const activeDream = dreamService?.listJobs(params.agentId).some((job) => ["queued", "running", "applying"].includes(job.status));
        if (activeDigest || activeDream) throw new ApiError("memory_job_active", "Memory Provider cannot change while a Memory job is active");
      }
      const result = await configService.patchConfig(params.agentId, body);
      digestScheduler?.refreshAgent?.(params.agentId);
      dreamScheduler?.refresh?.();
      sendJson(res, 200, result);
    }),
  );

  router.get(
    "/api/agents/:agentId/memory/_options",
    asHandler(async ({ res, params }) => {
      requireAgent(params.agentId);
      if (!taskRuntime) throw new ApiError("memory_task_unavailable", "Memory task options are unavailable");
      sendJson(res, 200, {
        providers: [structuredClone(MARKDOWN_PROVIDER_OPTION)],
        tasks: taskRuntime.listOptions({ ownerAgentId: params.agentId }),
      });
    }),
  );

  router.get(
    "/api/agents/:agentId/memory/_status",
    asHandler(async ({ res, params }) => {
      requireAgent(params.agentId);
      const recall = getUnitBinding(store, params.agentId, "vera.memory.recall");
      const write = getUnitBinding(store, params.agentId, "vera.memory.write");
      const digestJobs = digestService?.listJobs(params.agentId) ?? [];
      const dreamJobs = dreamService?.listJobs(params.agentId) ?? [];
      const lastDigest = digestJobs.at(-1) ?? null;
      const lastDream = dreamJobs[0] ?? null;
      const currentDream = dreamJobs.find((job) => ["queued", "running", "applying"].includes(job.status));
      let providerState = "available";
      try { await memory.listWithDiagnostics(params.agentId); }
      catch { providerState = "unavailable"; }
      const nextDigestRunAt = digestScheduler?.nextRunAt?.(params.agentId) ?? null;
      const nextScheduledDreamRunAt = dreamScheduler?.nextRunAt?.(params.agentId) ?? null;
      sendJson(res, 200, {
        provider: {
          providerId: "vera.markdown",
          state: providerState,
          capabilities: MARKDOWN_CAPABILITIES,
          location: { vaultRoot: memory.getVaultPath(), agentPath: params.agentId },
        },
        hooks: { recall: { enabled: recall.enabled }, write: { enabled: write.enabled } },
        pendingContext: digestScheduler?.getPendingContext?.(params.agentId) ?? { messageCount: 0, charCount: 0, spaces: [] },
        digest: {
          status: lastDigest?.status ?? "idle",
          ...(lastDigest ? { lastJob: lastDigest } : {}),
          ...(nextDigestRunAt ? { nextRunAt: nextDigestRunAt } : {}),
        },
        dream: {
          status: currentDream?.status ?? lastDream?.status ?? "idle",
          ...(lastDream ? { lastJob: lastDream } : {}),
          ...(nextScheduledDreamRunAt ? { nextRunAt: nextScheduledDreamRunAt } : {}),
          ...(currentDream ? { currentJobId: currentDream.id } : {}),
        },
      });
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
      const allowed = new Set(["spaceId", "spaceSessionId", "mode", "fromMessageId", "toMessageId"]);
      for (const key of Object.keys(body)) {
        if (!allowed.has(key)) throw new ApiError("invalid_request", `unknown digest field: ${key}`);
      }
      const job = await digestService.enqueue({
        agentId: params.agentId,
        trigger: "manual",
        spaceId: body?.spaceId,
        spaceSessionId: body?.spaceSessionId,
        mode: body?.mode,
        fromMessageId: body?.fromMessageId,
        toMessageId: body?.toMessageId,
      });
      sendJson(res, 202, { job });
    }),
  );

  router.post(
    "/api/agents/:agentId/memory/_dream",
    asHandler(async ({ req, res, params }) => {
      requireAgent(params.agentId);
      if (!dreamService) throw new ApiError("memory_task_unavailable", "Memory Dream service is unavailable");
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 1 || typeof body.requestId !== "string") {
        throw new ApiError("invalid_request", "Dream body must be exactly { requestId }");
      }
      const result = await dreamService.enqueue({ agentId: params.agentId, trigger: "manual", requestId: body.requestId });
      sendJson(res, 202, result);
    }),
  );

  router.get(
    "/api/agents/:agentId/memory/_dream/jobs",
    asHandler(async ({ res, params, query }) => {
      requireAgent(params.agentId);
      sendJson(res, 200, { jobs: dreamService ? dreamService.listJobs(params.agentId, { limit: query.get("limit") ?? 20 }) : [] });
    }),
  );

  router.get(
    "/api/agents/:agentId/memory/_dream/jobs/:jobId",
    asHandler(async ({ res, params }) => {
      requireAgent(params.agentId);
      if (!dreamService) throw new ApiError("not_found", `Dream job ${params.jobId} does not exist`);
      sendJson(res, 200, { job: dreamService.getJob(params.agentId, params.jobId) });
    }),
  );

  for (const action of ["retry", "cancel"]) {
    router.post(
      `/api/agents/:agentId/memory/_dream/jobs/:jobId/${action}`,
      asHandler(async ({ res, params }) => {
        requireAgent(params.agentId);
        if (!dreamService) throw new ApiError("not_found", `Dream job ${params.jobId} does not exist`);
        sendJson(res, 200, { job: dreamService[action](params.agentId, params.jobId) });
      }),
    );
  }

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
      retrieval.recordUserEdit(params.agentId, saved.slug);
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
      if (["type", "description", "status", "content"].some((key) => Object.hasOwn(body, key))) {
        retrieval.recordUserEdit(params.agentId, params.slug);
      }
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
