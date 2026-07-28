import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../../src/core/config.js";
import { adapterFor } from "../../scripts/agent-daemon.js";

test("Antigravity provider config has safe defaults and strict env normalization", async () => {
  const defaults = loadConfig({});
  assert.deepEqual(defaults.antigravity, {
    binary: "agy",
    projectId: null,
    mode: "accept-edits",
    watchdogMs: 1800000,
    contextWindowTokens: 32768,
    maxInputBytes: 131072,
  });
  const configured = loadConfig({
    VERA_ANTIGRAVITY_BIN: "/home/ubuntu/.local/bin/agy",
    VERA_ANTIGRAVITY_PROJECT_ID: " project-1 ",
    VERA_ANTIGRAVITY_MODE: "plan",
    VERA_ANTIGRAVITY_WATCHDOG_MS: "1234",
    VERA_ANTIGRAVITY_CONTEXT_WINDOW_TOKENS: "45678",
    VERA_ANTIGRAVITY_MAX_INPUT_BYTES: "77777",
  });
  assert.deepEqual(configured.antigravity, {
    binary: "/home/ubuntu/.local/bin/agy",
    projectId: "project-1",
    mode: "plan",
    watchdogMs: 1234,
    contextWindowTokens: 45678,
    maxInputBytes: 77777,
  });
  const invalid = loadConfig({
    VERA_ANTIGRAVITY_MODE: "dangerously-skip-permissions",
    VERA_ANTIGRAVITY_WATCHDOG_MS: "-1",
    VERA_ANTIGRAVITY_CONTEXT_WINDOW_TOKENS: "0",
    VERA_ANTIGRAVITY_MAX_INPUT_BYTES: "0",
  });
  assert.equal(invalid.antigravity.mode, "accept-edits");
  assert.equal(invalid.antigravity.watchdogMs, 1800000);
  assert.equal(invalid.antigravity.contextWindowTokens, 32768);
  assert.equal(invalid.antigravity.maxInputBytes, 131072);
});

test("production daemon selects Antigravity only for the exact runtime provider", async () => {
  const config = loadConfig({ VERA_ANTIGRAVITY_PROJECT_ID: "project-1" });
  const selected = adapterFor({
    kind: "cli",
    provider: "antigravity",
    model: "gemini-3.6-flash-low",
  }, config);
  assert.equal(typeof selected.run, "function");
  assert.equal(typeof selected.shutdown, "function");
  await selected.shutdown();
  assert.throws(
    () => adapterFor({ kind: "cli", provider: "agy", model: "gemini-3.6-flash-low" }, config),
    (error) => error.code === "unavailable",
  );
});
