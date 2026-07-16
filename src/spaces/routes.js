// Space / Message / Run / Approval HTTP 路由。

import { asHandler, readJsonBody, sendJson } from "../api/http.js";
import {
  listSpaces,
  createSpace,
  updateSpace,
  archiveSpace,
  restoreSpace,
  isArchived,
  getSpaceOrThrow,
} from "./spaces.js";
import { getTimeline } from "./timeline.js";
import { postMessage } from "./messages.js";
import { cancelRun } from "./run-controller.js";
import { answerApproval } from "./approvals.js";
import { ApiError } from "../core/errors.js";
import {
  ensureActiveSpaceSession,
  startNewSpaceSession,
} from "./context-sessions.js";
import { getContextCompactionJob } from "./context-compaction-store.js";
import {
  deleteArchivedSpace,
  getSpaceDeletionPreview,
} from "./space-deletion.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

export function registerSpaceRoutes(router, {
  store, hub, config, resolveAdapter, agentStates, memoryRetrieval, memoryDigestScheduler,
  contextCompaction, memory, files,
}) {
  router.get(
    "/api/spaces",
    asHandler(async ({ res, query }) => {
      const archivedParam = query.get("archived");
      const archived = archivedParam === "true" ? true : archivedParam === "all" ? "all" : undefined;
      sendJson(res, 200, { spaces: listSpaces(store, { archived }) });
    }),
  );

  router.post(
    "/api/spaces",
    asHandler(async ({ req, res }) => {
      const body = await readJsonBody(req);
      const space = createSpace(store, body);
      hub.publish("space.updated", { space });
      sendJson(res, 201, { space });
    }),
  );

  router.patch(
    "/api/spaces/:id",
    asHandler(async ({ req, res, params }) => {
      const body = await readJsonBody(req);
      const space = updateSpace(store, params.id, body);
      hub.publish("space.updated", { space });
      sendJson(res, 200, { space });
    }),
  );

  router.post(
    "/api/spaces/:id/archive",
    asHandler(async ({ res, params }) => {
      const space = archiveSpace(store, params.id);
      hub.publish("space.updated", { space });
      sendJson(res, 200, { space });
    }),
  );

  router.post(
    "/api/spaces/:id/restore",
    asHandler(async ({ res, params }) => {
      const space = restoreSpace(store, params.id);
      hub.publish("space.updated", { space });
      sendJson(res, 200, { space });
    }),
  );

  router.get(
    "/api/spaces/:id/deletion-preview",
    asHandler(async ({ res, params }) => {
      if (!memory) throw new ApiError("memory_provider_unavailable", "Memory is unavailable");
      const preview = await getSpaceDeletionPreview({ store, memory, files, spaceId: params.id });
      sendJson(res, 200, { preview });
    }),
  );

  router.delete(
    "/api/spaces/:id",
    asHandler(async ({ req, res, params }) => {
      if (!memory) throw new ApiError("memory_provider_unavailable", "Memory is unavailable");
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 1 || typeof body.deleteExclusiveMemories !== "boolean") {
        throw new ApiError("invalid_request", "body must be exactly { deleteExclusiveMemories: boolean }");
      }
      const deleted = await deleteArchivedSpace({
        store,
        memory,
        files,
        spaceId: params.id,
        deleteExclusiveMemories: body.deleteExclusiveMemories,
      });
      for (const fileId of deleted.deletedFileIds) {
        hub.publish("file.deleted", { spaceId: params.id, fileId });
      }
      delete deleted.deletedFileIds;
      hub.publish("space.deleted", { spaceId: params.id });
      sendJson(res, 200, { deleted });
    }),
  );

  router.get(
    "/api/spaces/:id/timeline",
    asHandler(async ({ res, params, query }) => {
      getSpaceOrThrow(store, params.id);
      const spaceSession = ensureActiveSpaceSession(store, params.id);
      const before = query.get("before") || undefined;
      const limitParam = query.get("limit");
      const limit = limitParam ? Number(limitParam) : 50;
      const timeline = getTimeline(store, params.id, { spaceSessionId: spaceSession.id, before, limit });
      timeline.items = timeline.items.map((item) => item.itemType === "message" ? files.projectMessage(item, params.id) : item);
      sendJson(res, 200, timeline);
    }),
  );

  router.get(
    "/api/spaces/:id/sessions",
    asHandler(async ({ res, params, query }) => {
      getSpaceOrThrow(store, params.id);
      const status = query.get("status") ?? "archived";
      if (!["active", "archived", "all"].includes(status)) {
        throw new ApiError("invalid_request", "status must be active, archived, or all");
      }
      const sessions = store.list("spaceSessions")
        .filter((item) => item.spaceId === params.id && (status === "all" || item.status === status))
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
        .map(stripInternal);
      sendJson(res, 200, { sessions });
    }),
  );

  router.get(
    "/api/spaces/:id/sessions/:spaceSessionId/timeline",
    asHandler(async ({ res, params, query }) => {
      getSpaceOrThrow(store, params.id);
      const session = store.find("spaceSessions", params.spaceSessionId);
      if (!session || session.spaceId !== params.id) {
        throw new ApiError("not_found", `space session ${params.spaceSessionId} does not exist`);
      }
      const before = query.get("before") || undefined;
      const limit = query.get("limit") ? Number(query.get("limit")) : 50;
      const timeline = getTimeline(store, params.id, {
        spaceSessionId: session.id,
        before,
        limit,
      });
      timeline.items = timeline.items.map((item) => item.itemType === "message" ? files.projectMessage(item, params.id) : item);
      sendJson(res, 200, timeline);
    }),
  );

  router.post(
    "/api/spaces/:id/session/_new",
    asHandler(async ({ req, res, params }) => {
      getSpaceOrThrow(store, params.id);
      if (isArchived(store, params.id)) {
        throw new ApiError("conflict", `space ${params.id} is archived, restore it first`);
      }
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 1 || typeof body.requestId !== "string" || !body.requestId) {
        throw new ApiError("invalid_request", "body must be exactly { requestId }");
      }
      const repeated = store.list("contextControlRequests").some((item) =>
        item.type === "new" && item.spaceId === params.id && item.requestId === body.requestId);
      const result = startNewSpaceSession(store, { spaceId: params.id, requestId: body.requestId });
      if (!repeated) {
        hub.publish("space-session.archived", {
          spaceId: params.id,
          spaceSession: result.archivedSession,
        });
        hub.publish("space-session.created", {
          spaceId: params.id,
          spaceSession: result.newSession,
        });
      }
      sendJson(res, 200, result);
    }),
  );

  router.post(
    "/api/spaces/:id/session/_compact",
    asHandler(async ({ req, res, params }) => {
      getSpaceOrThrow(store, params.id);
      if (isArchived(store, params.id)) {
        throw new ApiError("conflict", `space ${params.id} is archived, restore it first`);
      }
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 1 || typeof body.requestId !== "string" || !body.requestId) {
        throw new ApiError("invalid_request", "body must be exactly { requestId }");
      }
      if (!contextCompaction) throw new ApiError("context_capacity", "context compaction is unavailable");
      const job = contextCompaction.enqueue({ spaceId: params.id, requestId: body.requestId });
      sendJson(res, 202, { job });
    }),
  );

  router.get(
    "/api/spaces/:id/session/_compact/jobs/:jobId",
    asHandler(async ({ res, params }) => {
      getSpaceOrThrow(store, params.id);
      const job = getContextCompactionJob(store, params.jobId);
      if (!job || job.spaceId !== params.id) {
        throw new ApiError("not_found", `context compaction job ${params.jobId} does not exist`);
      }
      sendJson(res, 200, { job });
    }),
  );

  router.post(
    "/api/spaces/:id/messages",
    asHandler(async ({ req, res, params }) => {
      // 已归档 Space 禁止发消息（api-contract.md 266）
      if (isArchived(store, params.id)) {
        throw new ApiError("conflict", `space ${params.id} is archived, restore it first`);
      }
      const body = await readJsonBody(req);
      const result = postMessage({
        store,
        hub,
        config,
        resolveAdapter,
        agentStates,
        memoryRetrieval,
        memoryDigestScheduler,
        contextCompaction,
        files,
        spaceId: params.id,
        body,
      });
      sendJson(res, 201, result);
    }),
  );

  router.post(
    "/api/runs/:id/cancel",
    asHandler(async ({ res, params }) => {
      const run = store.find("runs", params.id);
      if (!run) throw new ApiError("not_found", `run ${params.id} does not exist`);
      if (["pending", "running"].includes(run.status)) cancelRun(params.id);
      const current = store.find("runs", params.id);
      sendJson(res, 200, { run: stripInternal(current) });
    }),
  );

  router.post(
    "/api/approvals/:id/answer",
    asHandler(async ({ req, res, params }) => {
      const body = await readJsonBody(req);
      const approval = answerApproval(store, hub, params.id, body.answer);
      sendJson(res, 200, { approval });
    }),
  );
}
