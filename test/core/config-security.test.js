import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../../src/core/config.js";

test("security config defaults closed and parses exact deployment lists", () => {
  const defaults = loadConfig({});
  assert.deepEqual(defaults.security, {
    ownerTailscaleLogins: [],
    cors: { allowedOrigins: [] },
    allowLoopbackDevelopment: false,
  });

  const configured = loadConfig({
    VERA_OWNER_TAILSCALE_LOGINS: " owner@example.com,Owner@example.com,owner@example.com, ",
    VERA_CORS_ALLOWED_ORIGINS: "capacitor://localhost, https://vera.example,capacitor://localhost",
    VERA_ALLOW_LOOPBACK_DEVELOPMENT: "TrUe",
  });
  assert.deepEqual(configured.security.ownerTailscaleLogins, ["owner@example.com", "Owner@example.com"]);
  assert.deepEqual(configured.security.cors.allowedOrigins, ["capacitor://localhost", "https://vera.example"]);
  assert.equal(configured.security.allowLoopbackDevelopment, true);
  assert.equal(loadConfig({ VERA_ALLOW_LOOPBACK_DEVELOPMENT: "1" }).security.allowLoopbackDevelopment, false);
});

test("security config rejects unsafe Origins and production development bypass", () => {
  for (const origin of ["*", "null", "https://vera.example/", "https://vera.example/path", "not-an-origin"]) {
    assert.throws(
      () => loadConfig({ VERA_CORS_ALLOWED_ORIGINS: origin }),
      /exact serialized Origins/u,
      origin,
    );
  }
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", VERA_ALLOW_LOOPBACK_DEVELOPMENT: "true" }),
    /cannot be enabled in production/u,
  );
});
