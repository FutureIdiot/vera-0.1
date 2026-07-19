import { asHandler, readJsonBody, sendJson } from "../api/http.js";
import { ApiError } from "../core/errors.js";

function rejectAccountCredentials(headers) {
  if (headers["x-vera-account-key"] || headers["x-vera-account-session"]) {
    throw new ApiError("invalid_request", "Memory task endpoints do not accept Account credentials");
  }
}

export function registerMemoryTaskRoutes(router, { controlService, transport, heartbeatIntervalMs }) {
  router.get(
    "/api/agent/memory-tasks/events",
    asHandler(async ({ req, res }) => {
      rejectAccountCredentials(req.headers);
      const { agent } = await controlService.authenticateAgent(req.headers);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": connected\n\n");
      const unsubscribe = transport.subscribe(agent.id, { write: (frame) => res.write(frame) });
      const timer = setInterval(() => transport.heartbeat(agent.id), heartbeatIntervalMs);
      timer.unref?.();
      req.on?.("close", () => {
        clearInterval(timer);
        unsubscribe();
      });
    }),
  );

  router.put(
    "/api/agent/memory-tasks/:dispatchId/result",
    asHandler(async ({ req, res, params }) => {
      rejectAccountCredentials(req.headers);
      const { agent } = await controlService.authenticateAgent(req.headers);
      const result = transport.submitResult(agent.id, params.dispatchId, await readJsonBody(req));
      sendJson(res, 200, result);
    }),
  );
}
