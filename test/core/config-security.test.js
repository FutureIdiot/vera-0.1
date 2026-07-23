import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../../src/core/config.js";

test("security config defaults closed and parses exact deployment lists", () => {
  const defaults = loadConfig({});
  assert.equal(defaults.host, "127.0.0.1");
  assert.equal(loadConfig({ HOST: "0.0.0.0" }).host, "127.0.0.1");
  assert.deepEqual(defaults.security, {
    ownerTailscaleLogins: [],
    cors: { allowedOrigins: [] },
    allowLoopbackDevelopment: false,
  });
  assert.equal(defaults.updates.controlPath, null);
  assert.match(defaults.updates.releaseMetadataPath, /\.vera-release\.json$/u);

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

test("update control paths require absolute deployment paths", () => {
  const configured = loadConfig({
    VERA_UPDATE_CONTROL_PATH: "/var/lib/vera-updater",
    VERA_RELEASE_METADATA_PATH: "/opt/vera/current/.vera-release.json",
  });
  assert.deepEqual(configured.updates, {
    controlPath: "/var/lib/vera-updater",
    releaseMetadataPath: "/opt/vera/current/.vera-release.json",
  });
  assert.throws(() => loadConfig({ VERA_UPDATE_CONTROL_PATH: "relative" }), /must be an absolute path/u);
  assert.throws(() => loadConfig({ VERA_RELEASE_METADATA_PATH: "relative" }), /must be an absolute path/u);
});

test("gateway listener consumes the fixed loopback host", async () => {
  const source = await readFile(new URL("../../src/server.js", import.meta.url), "utf8");
  assert.match(source, /server\.listen\(config\.port, config\.host,/u);
  assert.doesNotMatch(source, /server\.listen\(config\.port,\s*\(\)/u);
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
