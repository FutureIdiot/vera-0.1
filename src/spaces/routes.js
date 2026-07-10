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

function stripInternal({ _seq, ...rest }) {
  return rest;
}

export function registerSpaceRoutes(router, { store, hub, config, resolveAdapter, agentStates, memory }) {
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
      sendJson(res, 201, { space });
    }),
  );

  router.patch(
    "/api/spaces/:id",
    asHandler(async ({ req, res, params }) => {
      const body = await readJsonBody(req);
      const space = updateSpace(store, params.id, body);
      sendJson(res, 200, { space });
    }),
  );

  router.post(
    "/api/spaces/:id/archive",
    asHandler(async ({ res, params }) => {
      const space = archiveSpace(store, params.id);
      sendJson(res, 200, { space });
    }),
  );

  router.post(
    "/api/spaces/:id/restore",
    asHandler(async ({ res, params }) => {
      const space = restoreSpace(store, params.id);
      sendJson(res, 200, { space });
    }),
  );

  router.get(
    "/api/spaces/:id/timeline",
    asHandler(async ({ res, params, query }) => {
      getSpaceOrThrow(store, params.id);
      const before = query.get("before") || undefined;
      const limitParam = query.get("limit");
      const limit = limitParam ? Number(limitParam) : 50;
      sendJson(res, 200, getTimeline(store, params.id, { before, limit }));
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
        memory,
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
      if (run.status === "running") cancelRun(params.id);
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
