import test from "node:test";
import assert from "node:assert/strict";

import { createRequestSecurity, isLoopbackAddress } from "../../src/api/request-security.js";

function makeConfig({ owners = ["owner@example.com"], origins = [], development = false } = {}) {
  return {
    security: {
      ownerTailscaleLogins: owners,
      cors: { allowedOrigins: origins },
      allowLoopbackDevelopment: development,
    },
  };
}

function makeExchange({
  method = "GET",
  url = "/api/bootstrap",
  headers = {},
  remoteAddress = "127.0.0.1",
  encrypted = false,
} = {}) {
  const storedHeaders = new Map();
  let status = null;
  let body = "";
  const req = {
    method,
    url,
    headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
    socket: { remoteAddress, encrypted },
  };
  const res = {
    setHeader(name, value) { storedHeaders.set(name.toLowerCase(), value); },
    getHeader(name) { return storedHeaders.get(name.toLowerCase()); },
    removeHeader(name) { storedHeaders.delete(name.toLowerCase()); },
    writeHead(nextStatus, responseHeaders = {}) {
      status = nextStatus;
      for (const [name, value] of Object.entries(responseHeaders)) this.setHeader(name, value);
    },
    end(chunk = "") { body += chunk; },
  };
  return {
    req,
    res,
    result() {
      return { status, body, headers: Object.fromEntries(storedHeaders) };
    },
  };
}

test("Owner boundary trusts only exact loopback identities and keeps Agent APIs separate", () => {
  const enforce = createRequestSecurity({ config: makeConfig() });
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("100.64.0.2"), false);

  const health = makeExchange({ url: "/api/health", remoteAddress: "100.64.0.2" });
  assert.equal(enforce(health.req, health.res), false);

  const agentApi = makeExchange({ url: "/api/agent/login", remoteAddress: "100.64.0.2", headers: {
    "Tailscale-User-Login": "owner@example.com",
  } });
  assert.equal(enforce(agentApi.req, agentApi.res), false);

  for (const exchange of [
    makeExchange(),
    makeExchange({ headers: { "Tailscale-User-Login": "Owner@example.com" } }),
    makeExchange({ remoteAddress: "100.64.0.2", headers: { "Tailscale-User-Login": "owner@example.com" } }),
  ]) {
    assert.equal(enforce(exchange.req, exchange.res), true);
    const result = exchange.result();
    assert.equal(result.status, 403);
    assert.deepEqual(JSON.parse(result.body), { error: { code: "forbidden", message: "Owner access is forbidden" } });
    assert.equal(result.body.includes("owner@example.com"), false);
  }

  const owner = makeExchange({ headers: { "Tailscale-User-Login": "owner@example.com" } });
  assert.equal(enforce(owner.req, owner.res), false);
});

test("loopback development bypass requires a missing identity and never trusts a forged one", () => {
  const enforce = createRequestSecurity({ config: makeConfig({ owners: [], development: true }) });
  const local = makeExchange();
  assert.equal(enforce(local.req, local.res), false);

  const forged = makeExchange({ headers: { "Tailscale-User-Login": "attacker@example.com" } });
  assert.equal(enforce(forged.req, forged.res), true);
  assert.equal(forged.result().status, 403);

  const remote = makeExchange({ remoteAddress: "100.64.0.2" });
  assert.equal(enforce(remote.req, remote.res), true);
  assert.equal(remote.result().status, 403);
});

test("CORS accepts only exact configured or effective same Origins", () => {
  const enforce = createRequestSecurity({ config: makeConfig({ origins: ["capacitor://localhost"] }) });
  const allowed = makeExchange({ headers: {
    Host: "vera.example",
    Origin: "capacitor://localhost",
    "Tailscale-User-Login": "owner@example.com",
  } });
  allowed.res.setHeader("Vary", "Accept-Encoding");
  assert.equal(enforce(allowed.req, allowed.res), false);
  assert.equal(allowed.result().headers["access-control-allow-origin"], "capacitor://localhost");
  assert.equal(allowed.result().headers.vary, "Accept-Encoding, Origin");
  assert.equal("access-control-allow-credentials" in allowed.result().headers, false);

  const sameOrigin = makeExchange({ headers: {
    Host: "vera.example",
    Origin: "https://vera.example",
    "Tailscale-User-Login": "owner@example.com",
  } });
  assert.equal(enforce(sameOrigin.req, sameOrigin.res), false);
  assert.equal("access-control-allow-origin" in sameOrigin.result().headers, false);

  for (const origin of ["https://evil.example", "https://vera.example.evil", "null"]) {
    const denied = makeExchange({ headers: {
      Host: "vera.example",
      Origin: origin,
      "Tailscale-User-Login": "owner@example.com",
    } });
    assert.equal(enforce(denied.req, denied.res), true);
    assert.equal(denied.result().status, 403);
    assert.equal("access-control-allow-origin" in denied.result().headers, false);
  }
});

test("CORS preflight validates exact method and header allowlists", () => {
  const enforce = createRequestSecurity({ config: makeConfig({ origins: ["capacitor://localhost"] }) });
  const allowed = makeExchange({ method: "OPTIONS", url: "/api/bootstrap", headers: {
    Origin: "capacitor://localhost",
    "Access-Control-Request-Method": "patch",
    "Access-Control-Request-Headers": "content-type, authorization, last-event-id",
  } });
  assert.equal(enforce(allowed.req, allowed.res), true);
  assert.deepEqual(allowed.result(), {
    status: 204,
    body: "",
    headers: {
      "access-control-allow-origin": "capacitor://localhost",
      vary: "Origin",
      "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type, Last-Event-ID",
    },
  });

  for (const headers of [
    { "Access-Control-Request-Method": "TRACE" },
    { "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "X-Secret" },
  ]) {
    const denied = makeExchange({ method: "OPTIONS", headers: { Origin: "capacitor://localhost", ...headers } });
    assert.equal(enforce(denied.req, denied.res), true);
    assert.equal(denied.result().status, 403);
    assert.equal("access-control-allow-origin" in denied.result().headers, false);
  }
});
