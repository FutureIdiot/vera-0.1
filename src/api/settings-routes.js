// 系统设置 HTTP 路由（Phase 4.5，api-contract.md「配置 [P4]」）。
// GET/PATCH /api/settings，字段白名单与类型校验在 settings-store 层（抛
// ApiError invalid_request 由 asHandler 映射 400）。

import { asHandler, readJsonBody, sendJson } from "./http.js";
import { ApiError } from "../core/errors.js";

export function registerSettingsRoutes(router, { settingsStore, onSettingsChanged }) {
  router.get(
    "/api/settings",
    asHandler(async ({ res }) => {
      sendJson(res, 200, { settings: settingsStore.getAll() });
    }),
  );

  router.patch(
    "/api/settings",
    asHandler(async ({ req, res }) => {
      const body = await readJsonBody(req);
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        !body.settings ||
        typeof body.settings !== "object" ||
        Array.isArray(body.settings)
      ) {
        throw new ApiError("invalid_request", "request body must be { settings: <object> }");
      }
      const merged = await settingsStore.setAll(body.settings);
      onSettingsChanged?.(merged);
      sendJson(res, 200, { settings: merged });
    }),
  );
}
