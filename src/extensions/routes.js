import { asHandler, readJsonBody, sendJson, sendNoContent } from "../api/http.js";

export function registerExtensionRoutes(router, { loader }) {
  router.get("/api/extensions", asHandler(async ({ res }) => sendJson(res, 200, { extensions: loader.list() })));
  router.get("/api/extensions/:id", asHandler(async ({ res, params }) => sendJson(res, 200, { extension: loader.get(params.id) })));
  router.post("/api/extensions/register", asHandler(async ({ req, res }) => sendJson(res, 201, { extension: await loader.register((await readJsonBody(req)).sourcePath) })));
  router.delete("/api/extensions/:id", asHandler(async ({ res, params, query }) => { await loader.unload(params.id, { ifMatch: query.get("ifMatch") }); sendNoContent(res); }));
  router.get("/api/agents/:id/extensions", asHandler(async ({ res, params }) => sendJson(res, 200, { extensions: await loader.listAgent(params.id) })));
  router.post("/api/agents/:id/extensions/:extensionId/mcp", asHandler(async ({ req, res, params }) => {
    sendJson(res, 200, { result: await loader.callMcp(params.extensionId, params.id, await readJsonBody(req)) });
  }));
  router.post("/api/agents/:id/extensions/:extensionId/hooks/:unitId", asHandler(async ({ req, res, params }) => {
    sendJson(res, 200, { result: await loader.callHook(params.extensionId, params.id, { unitId: params.unitId, event: await readJsonBody(req) }) });
  }));
  router.post("/api/agents/:id/extensions/:extensionId/bind", asHandler(async ({ req, res, params }) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, { binding: await loader.bindAgent(params.extensionId, params.id, body) });
  }));
  router.delete("/api/agents/:id/extensions/:extensionId/bind", asHandler(async ({ res, params, query }) => {
    sendJson(res, 200, { binding: await loader.unbindAgent(params.extensionId, params.id, { ifMatch: query.get("ifMatch") }) });
  }));
}
