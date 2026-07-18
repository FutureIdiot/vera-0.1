// Owner Tailscale identity and native CORS black-box boundary.

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function run(ctx) {
  await ctx.check("security. owner identity and exact Origin fail closed at the real HTTP boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-security-check-"));
    let gateway;
    try {
      gateway = await ctx.startGateway({
        repoRoot: ctx.repoRoot,
        env: {
          VERA_DATA_PATH: join(root, "data"),
          VERA_OWNER_TAILSCALE_LOGINS: "owner@example.com",
          VERA_CORS_ALLOWED_ORIGINS: "capacitor://localhost",
          VERA_ALLOW_LOOPBACK_DEVELOPMENT: "false",
        },
      });
      const base = `http://127.0.0.1:${gateway.port}`;
      const request = (path, options = {}) => fetch(`${base}${path}`, options);

      const health = await request("/api/health");
      ctx.assertEqual(health.status, 200, "health must remain the only owner-free ordinary probe");

      const missing = await request("/api/bootstrap");
      ctx.assertEqual(missing.status, 403, "ordinary API must reject missing owner identity");
      const missingBody = await missing.text();
      ctx.assert(!missingBody.includes("owner@example.com"), "owner login must not leak in the error response");

      const wrong = await request("/api/bootstrap", { headers: { "Tailscale-User-Login": "wrong@example.com" } });
      ctx.assertEqual(wrong.status, 403, "wrong owner identity must be rejected");
      ctx.assert(!(await wrong.text()).includes("wrong@example.com"), "rejected identity must not be echoed");

      const ownerHeaders = { "Tailscale-User-Login": "owner@example.com" };
      const accepted = await request("/api/bootstrap", { headers: ownerHeaders });
      ctx.assertEqual(accepted.status, 200, "exact owner identity must reach the route");

      const staticDenied = await request("/");
      ctx.assertEqual(staticDenied.status, 403, "static frontend entry must share the owner boundary");

      const agentWithoutCredentials = await request("/api/agent/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      ctx.assertEqual(agentWithoutCredentials.status, 400, "Agent API must reach Agent auth without owner identity");
      ctx.assertEqual((await agentWithoutCredentials.json()).error.code, "invalid_request");

      const corsAccepted = await request("/api/bootstrap", { headers: {
        ...ownerHeaders,
        Origin: "capacitor://localhost",
      } });
      ctx.assertEqual(corsAccepted.status, 200);
      ctx.assertEqual(corsAccepted.headers.get("access-control-allow-origin"), "capacitor://localhost");
      ctx.assert((corsAccepted.headers.get("vary") ?? "").split(",").map((value) => value.trim()).includes("Origin"));
      ctx.assertEqual(corsAccepted.headers.get("access-control-allow-credentials"), null);

      const corsDenied = await request("/api/bootstrap", { headers: {
        ...ownerHeaders,
        Origin: "https://evil.example",
      } });
      ctx.assertEqual(corsDenied.status, 403, "nearby or unlisted Origins must fail before routing");
      ctx.assertEqual(corsDenied.headers.get("access-control-allow-origin"), null);

      const preflight = await request("/api/bootstrap", {
        method: "OPTIONS",
        headers: {
          Origin: "capacitor://localhost",
          "Access-Control-Request-Method": "PATCH",
          "Access-Control-Request-Headers": "Authorization, Content-Type, Last-Event-ID",
        },
      });
      ctx.assertEqual(preflight.status, 204);
      ctx.assertEqual(preflight.headers.get("access-control-allow-methods"), "GET, POST, PATCH, DELETE, OPTIONS");
      ctx.assertEqual(preflight.headers.get("access-control-allow-headers"), "Authorization, Content-Type, Last-Event-ID");

      const badPreflight = await request("/api/bootstrap", {
        method: "OPTIONS",
        headers: {
          Origin: "capacitor://localhost",
          "Access-Control-Request-Method": "PATCH",
          "Access-Control-Request-Headers": "X-Secret",
        },
      });
      ctx.assertEqual(badPreflight.status, 403);
      ctx.assertEqual(badPreflight.headers.get("access-control-allow-origin"), null);
    } finally {
      if (gateway) await gateway.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
}
