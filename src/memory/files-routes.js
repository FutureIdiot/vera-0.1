// Files HTTP routes: raw binary upload/download plus JSON metadata operations.

import { finished } from "node:stream/promises";
import { asHandler, readJsonBody, sendJson, sendNoContent } from "../api/http.js";
import { ApiError } from "../core/errors.js";

function decodeDisplayName(value) {
  if (typeof value !== "string" || !value) throw new ApiError("invalid_request", "X-Vera-File-Name is required");
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError("invalid_request", "X-Vera-File-Name must be encodeURIComponent output");
  }
}

function parseContentLength(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new ApiError("invalid_request", "Content-Length must be a non-negative integer");
  return parsed;
}

function parseIfMatch(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ApiError("invalid_request", "ifMatch must be a positive integer");
  return parsed;
}

export function registerFilesRoutes(router, { files, hub }) {
  router.get(
    "/api/spaces/:id/files",
    asHandler(async ({ res, params }) => {
      sendJson(res, 200, files.listReadable(params.id));
    }),
  );

  router.post(
    "/api/spaces/:id/files",
    asHandler(async ({ req, res, params }) => {
      const file = await files.upload({
        spaceId: params.id,
        name: decodeDisplayName(req.headers["x-vera-file-name"]),
        declaredMime: req.headers["content-type"],
        contentLength: parseContentLength(req.headers["content-length"]),
        body: req,
      });
      const eventFile = { ...file };
      delete eventFile.sha256;
      hub.publish("file.created", { spaceId: params.id, file: eventFile });
      sendJson(res, 201, { file });
    }),
  );

  router.get(
    "/api/spaces/:id/files/:fileId",
    asHandler(async ({ res, params }) => {
      sendJson(res, 200, { file: await files.getReadable(params.id, params.fileId) });
    }),
  );

  router.get(
    "/api/spaces/:id/files/:fileId/download",
    asHandler(async ({ res, params }) => {
      const { file, handle } = await files.openDownload(params.id, params.fileId);
      const stream = handle.createReadStream({ start: 0, autoClose: true });
      res.writeHead(200, {
        "Content-Type": file.mime,
        "Content-Length": file.sizeBytes,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "X-Content-Type-Options": "nosniff",
      });
      stream.pipe(res);
      await finished(stream);
    }),
  );

  router.patch(
    "/api/spaces/:id/files/:fileId",
    asHandler(async ({ req, res, params }) => {
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).sort().join(",") !== "ifMatch,sharedSpaceIds") {
        throw new ApiError("invalid_request", "body must be exactly { sharedSpaceIds, ifMatch }");
      }
      const file = await files.updateSharing(params.id, params.fileId, body);
      const eventFile = { ...file };
      delete eventFile.sha256;
      hub.publish("file.updated", { spaceId: params.id, file: eventFile });
      sendJson(res, 200, { file });
    }),
  );

  router.delete(
    "/api/spaces/:id/files/:fileId",
    asHandler(async ({ res, params, query }) => {
      await files.deleteFile(params.id, params.fileId, parseIfMatch(query.get("ifMatch")));
      hub.publish("file.deleted", { spaceId: params.id, fileId: params.fileId });
      sendNoContent(res);
    }),
  );
}
