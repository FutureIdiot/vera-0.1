// Space / Message / Run / Approval HTTP 路由。

import { asHandler, readJsonBody, sendJson, sendNoContent } from "../api/http.js";
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
  projectAgentSession,
  resumeSpaceSession,
  startNewSpaceSession,
} from "./context-sessions.js";
import { getContextCompactionJob } from "./context-compaction-store.js";
import {
  deleteArchivedSpace,
  getSpaceDeletionPreview,
} from "./space-deletion.js";
import {
  listProjects,
  getProjectOrThrow,
  createProject,
  updateProject,
  deleteProject,
} from "./projects.js";
import {
  listGroups,
  getGroupOrThrow,
  createGroup,
  updateGroup,
  deleteGroup,
} from "./groups.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

function activeAgentSessionsForSpace(store, space, spaceSessionId) {
  const activePairs = new Set((space.seats ?? []).flatMap((seat) => {
    const account = store.find("accounts", seat.accountId);
    return account?.ownerAgentId ? [`${account.id}\u0000${account.ownerAgentId}`] : [];
  }));
  return store.list("agentSessions")
    .filter((session) =>
      session.spaceSessionId === spaceSessionId &&
      session.status === "active" &&
      activePairs.has(`${session.accountId}\u0000${session.agentId}`))
    .map(projectAgentSession);
}

export function registerSpaceRoutes(router, {
  store, hub, config, daemonScheduler, memoryDigestScheduler, extensionHooks,
  daemonRuntime, daemonRunLifecycle, contextCompaction, memory, files, observation,
  contextForge,
  runBackground, controlService,
  runMessages,
}) {
  router.get(
    "/api/groups",
    asHandler(async ({ res }) => {
      sendJson(res, 200, { groups: listGroups(store) });
    }),
  );

  router.get(
    "/api/groups/:id",
    asHandler(async ({ res, params }) => {
      sendJson(res, 200, { group: getGroupOrThrow(store, params.id) });
    }),
  );

  router.post(
    "/api/groups",
    asHandler(async ({ req, res }) => {
      const body = await readJsonBody(req);
      const group = createGroup(store, body);
      hub.publish("group.updated", { group });
      sendJson(res, 201, { group });
    }),
  );

  router.patch(
    "/api/groups/:id",
    asHandler(async ({ req, res, params }) => {
      const body = await readJsonBody(req);
      const result = updateGroup(store, params.id, body);
      hub.publish("group.updated", { group: result.group });
      for (const space of result.spaces) {
        observation?.reconcileSpace(space.id);
        hub.publish("space.updated", { space });
      }
      sendJson(res, 200, result);
    }),
  );

  router.delete(
    "/api/groups/:id",
    asHandler(async ({ res, params }) => {
      deleteGroup(store, params.id);
      hub.publish("group.deleted", { groupId: params.id });
      sendNoContent(res);
    }),
  );

  router.get(
    "/api/projects",
    asHandler(async ({ res }) => {
      sendJson(res, 200, { projects: listProjects(store) });
    }),
  );

  router.get(
    "/api/projects/:id",
    asHandler(async ({ res, params }) => {
      sendJson(res, 200, { project: getProjectOrThrow(store, params.id) });
    }),
  );

  router.post(
    "/api/projects",
    asHandler(async ({ req, res }) => {
      const body = await readJsonBody(req);
      const project = createProject(store, body);
      hub.publish("project.updated", { project });
      sendJson(res, 201, { project });
    }),
  );

  router.patch(
    "/api/projects/:id",
    asHandler(async ({ req, res, params }) => {
      const body = await readJsonBody(req);
      const project = updateProject(store, params.id, body);
      hub.publish("project.updated", { project });
      sendJson(res, 200, { project });
    }),
  );

  router.delete(
    "/api/projects/:id",
    asHandler(async ({ res, params }) => {
      deleteProject(store, params.id);
      hub.publish("project.deleted", { projectId: params.id });
      sendNoContent(res);
    }),
  );

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
      observation?.reconcileSpace(params.id);
      hub.publish("space.updated", { space });
      sendJson(res, 200, { space });
    }),
  );

  router.post(
    "/api/spaces/:id/archive",
    asHandler(async ({ res, params }) => {
      const space = archiveSpace(store, params.id);
      observation?.reconcileSpace(params.id);
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
      observation?.reconcileSpace(params.id);
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
      const space = getSpaceOrThrow(store, params.id);
      const spaceSession = ensureActiveSpaceSession(store, params.id);
      const before = query.get("before") || undefined;
      const limitParam = query.get("limit");
      const limit = limitParam ? Number(limitParam) : 50;
      const timeline = getTimeline(store, params.id, { spaceSessionId: spaceSession.id, before, limit });
      timeline.items = timeline.items.map((item) => {
        if (item.itemType === "message") return files.projectMessage(item, params.id);
        if (item.itemType === "activity") return observation?.projectActivity(item) ?? item;
        return item;
      });
      timeline.agentSessions = activeAgentSessionsForSpace(store, space, spaceSession.id);
      timeline.forgeContext = contextForge?.forgeContextForSession(spaceSession.id) ?? null;
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
      timeline.items = timeline.items.map((item) => {
        if (item.itemType === "message") return files.projectMessage(item, params.id);
        if (item.itemType === "activity") {
          return observation?.projectActivity(item, { archived: session.status !== "active" }) ?? item;
        }
        return item;
      });
      timeline.forgeContext = contextForge?.forgeContextForSession(session.id) ?? null;
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

  router.post(
    "/api/spaces/:id/sessions/:spaceSessionId/_resume",
    asHandler(async ({ req, res, params }) => {
      getSpaceOrThrow(store, params.id);
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 1 || typeof body.requestId !== "string" || !body.requestId) {
        throw new ApiError("invalid_request", "body must be exactly { requestId }");
      }
      const repeated = store.list("contextControlRequests").some((item) =>
        item.type === "resume" && item.spaceId === params.id && item.requestId === body.requestId);
      const result = resumeSpaceSession(store, {
        spaceId: params.id,
        spaceSessionId: params.spaceSessionId,
        requestId: body.requestId,
      });
      if (!repeated) {
        hub.publish("space-session.archived", {
          spaceId: params.id,
          spaceSession: result.archivedSession,
        });
        hub.publish("space-session.resumed", {
          spaceId: params.id,
          spaceSession: result.resumedSession,
          agentSessions: result.agentSessions,
        });
      }
      sendJson(res, 200, result);
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
    "/api/spaces/:id/session/_forge/drafts",
    asHandler(async ({ req, res, params }) => {
      getSpaceOrThrow(store, params.id);
      if (isArchived(store, params.id)) {
        throw new ApiError("conflict", `space ${params.id} is archived, restore it first`);
      }
      if (!contextForge) throw new ApiError("forge_failed", "Forge is unavailable");
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 1 || typeof body.requestId !== "string" || !body.requestId) {
        throw new ApiError("invalid_request", "body must be exactly { requestId }");
      }
      const draft = contextForge.createDraft({ spaceId: params.id, requestId: body.requestId });
      sendJson(res, 202, { draft });
    }),
  );

  router.get(
    "/api/spaces/:id/session/_forge/drafts/:draftId",
    asHandler(async ({ res, params }) => {
      getSpaceOrThrow(store, params.id);
      if (!contextForge) throw new ApiError("forge_failed", "Forge is unavailable");
      const draft = contextForge.getDraft(params.draftId);
      if (draft.spaceId !== params.id) {
        throw new ApiError("not_found", `Forge draft ${params.draftId} does not exist`);
      }
      sendJson(res, 200, { draft });
    }),
  );

  router.patch(
    "/api/spaces/:id/session/_forge/drafts/:draftId",
    asHandler(async ({ req, res, params }) => {
      getSpaceOrThrow(store, params.id);
      if (!contextForge) throw new ApiError("forge_failed", "Forge is unavailable");
      const current = contextForge.getDraft(params.draftId);
      if (current.spaceId !== params.id) {
        throw new ApiError("not_found", `Forge draft ${params.draftId} does not exist`);
      }
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).sort().join(",") !== "ifVersion,targets") {
        throw new ApiError("invalid_request", "body must be exactly { ifVersion, targets }");
      }
      const draft = contextForge.updateDraft({
        draftId: params.draftId,
        ifVersion: body.ifVersion,
        targets: body.targets,
      });
      sendJson(res, 200, { draft });
    }),
  );

  router.delete(
    "/api/spaces/:id/session/_forge/drafts/:draftId",
    asHandler(async ({ res, params }) => {
      getSpaceOrThrow(store, params.id);
      if (!contextForge) throw new ApiError("forge_failed", "Forge is unavailable");
      const current = contextForge.getDraft(params.draftId);
      if (current.spaceId !== params.id) {
        throw new ApiError("not_found", `Forge draft ${params.draftId} does not exist`);
      }
      sendJson(res, 200, { draft: contextForge.cancelDraft(params.draftId) });
    }),
  );

  router.post(
    "/api/spaces/:id/session/_forge/drafts/:draftId/_confirm",
    asHandler(async ({ req, res, params }) => {
      getSpaceOrThrow(store, params.id);
      if (!contextForge) throw new ApiError("forge_failed", "Forge is unavailable");
      const current = contextForge.getDraft(params.draftId);
      if (current.spaceId !== params.id) {
        throw new ApiError("not_found", `Forge draft ${params.draftId} does not exist`);
      }
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).sort().join(",") !== "ifVersion,requestId" ||
          typeof body.requestId !== "string" || !body.requestId) {
        throw new ApiError("invalid_request", "body must be exactly { requestId, ifVersion }");
      }
      const repeated = store.list("contextControlRequests").some((item) =>
        item.type === "forge" && item.spaceId === params.id && item.requestId === body.requestId);
      const result = contextForge.confirmDraft({
        draftId: params.draftId,
        requestId: body.requestId,
        ifVersion: body.ifVersion,
      });
      if (!repeated) {
        hub.publish("space-session.archived", {
          spaceId: params.id,
          spaceSession: result.archivedSession,
        });
        hub.publish("space-session.created", {
          spaceId: params.id,
          spaceSession: result.newSession,
          agentSessions: result.agentSessions,
          forgeContext: result.draft,
        });
      }
      sendJson(res, 200, result);
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
        daemonScheduler,
        memoryDigestScheduler,
        extensionHooks,
        files,
        observation,
        runBackground,
        runMessages,
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
      const subtree = store.list("runs")
        .filter((candidate) => {
          if (candidate.id === run.id) return true;
          let parent = store.find("runs", candidate.parentRunId);
          while (parent) {
            if (parent.id === run.id) return true;
            parent = store.find("runs", parent.parentRunId);
          }
          return false;
        })
        .filter((candidate) => ["pending", "running"].includes(candidate.status))
        .sort((left, right) => (right.depth ?? 0) - (left.depth ?? 0));
      for (const target of subtree) {
        if (target.executionTransport === "daemon") {
          if (target.status === "running") {
            try {
              daemonRuntime?.dispatchEvent({
                accountId: target.accountId,
                event: { type: "run.cancelled", data: { runId: target.id } },
              });
            } catch {
              // Gateway cancellation remains authoritative even if the daemon
              // channel vanished between the owner action and this write.
            }
          }
          daemonRunLifecycle?.cancelRun(target.id);
        } else cancelRun(target.id);
      }
      const current = store.find("runs", params.id);
      sendJson(res, 200, { run: stripInternal(current) });
    }),
  );

  router.post(
    "/api/runs/:id/background",
    asHandler(async ({ res, params }) => {
      if (!runBackground) throw new ApiError("conflict", "Run backgrounding is unavailable");
      sendJson(res, 200, { run: runBackground.backgroundRun(params.id) });
    }),
  );

  router.post(
    "/api/runs/:id/user-messages",
    asHandler(async ({ req, res, params }) => {
      if (!runMessages) throw new ApiError("conflict", "RunMessage service is unavailable");
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).sort().join(",") !== "content,idempotencyKey,replyToRunMessageId" ||
          typeof body.content !== "string" ||
          typeof body.replyToRunMessageId !== "string" ||
          typeof body.idempotencyKey !== "string") {
        throw new ApiError(
          "invalid_request",
          "body must be exactly { content, replyToRunMessageId, idempotencyKey }",
        );
      }
      sendJson(res, 201, runMessages.createUserInstruction(params.id, body));
    }),
  );

  router.put(
    "/api/agent/run-catchups/:id/result",
    asHandler(async ({ req, res, params }) => {
      if (!runBackground || !controlService?.authenticateCurrentAccountSession) {
        throw new ApiError("conflict", "Run catch-up is unavailable");
      }
      const authority = await controlService.authenticateCurrentAccountSession(req.headers);
      const body = await readJsonBody(req);
      const allowed = body?.status === "succeeded"
        ? new Set(["status", "summary"])
        : new Set(["status", "error"]);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).some((key) => !allowed.has(key)) ||
          (body.status === "succeeded" && (
            Object.keys(body).length !== 2 || typeof body.summary !== "string"
          )) ||
          (body.status === "failed" && (
            Object.keys(body).length !== 2 ||
            !body.error || typeof body.error !== "object" || Array.isArray(body.error) ||
            Object.keys(body.error).sort().join(",") !== "code,message" ||
            typeof body.error.code !== "string" || typeof body.error.message !== "string"
          )) ||
          !["succeeded", "failed"].includes(body.status)) {
        throw new ApiError("invalid_request", "catch-up result fields are invalid");
      }
      const catchup = runBackground.submitResult(params.id, authority, body);
      sendJson(res, 200, { catchup });
    }),
  );

  router.post(
    "/api/approvals/:id/answer",
    asHandler(async ({ req, res, params }) => {
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 1 || typeof body.answer !== "string") {
        throw new ApiError("invalid_request", "body must be exactly { answer }");
      }
      const approval = answerApproval(store, hub, params.id, body.answer);
      sendJson(res, 200, { approval });
    }),
  );
}
