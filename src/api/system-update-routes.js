import { asHandler, readJsonBody, sendJson } from "./http.js";
import { ApiError } from "../core/errors.js";

function exactBody(body, keys) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function registerSystemUpdateRoutes(router, { updateControl }) {
  router.get(
    "/api/system/update",
    asHandler(async ({ res }) => sendJson(res, 200, { update: await updateControl.getStatus() })),
  );

  router.post(
    "/api/system/update/check",
    asHandler(async ({ req, res }) => {
      const body = await readJsonBody(req);
      if (!exactBody(body, [])) throw new ApiError("invalid_request", "request body must be {}");
      sendJson(res, 202, { update: await updateControl.queueCheck() });
    }),
  );

  router.post(
    "/api/system/update/apply",
    asHandler(async ({ req, res }) => {
      const body = await readJsonBody(req);
      if (!exactBody(body, ["ifRequestId", "targetCommit"])) {
        throw new ApiError("invalid_request", "request body must be { targetCommit, ifRequestId }");
      }
      sendJson(res, 202, { update: await updateControl.queueApply(body) });
    }),
  );
}
