import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../src/store/store.js";

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

test("P5-C1 migration backfills session identity, reconstructs verifiable API turns, and retires sessionStates", async () => {
  const root = await mkdtemp(join(tmpdir(), "vera-context-migration-"));
  const dataPath = join(root, "data");
  await mkdir(dataPath);
  const createdAt = "2026-01-01T00:00:00.000Z";
  const files = {
    "agents.json": [{ id: "agt_cli", name: "CLI" }, { id: "agt_api", name: "API" }],
    "accounts.json": [
      { id: "acc_cli", owningAgentId: "agt_cli", kind: "cli", provider: "codex", connection: {}, model: "gpt" },
      { id: "acc_api", owningAgentId: "agt_api", kind: "api", provider: "ollama", connection: {}, model: "gemma" },
    ],
    "spaces.json": [{
      id: "spc_old", name: "old", createdAt,
      seats: [{ agentId: "agt_cli", responseMode: "default" }, { agentId: "agt_api", responseMode: "default" }],
    }],
    "messages.json": [
      { id: "msg_in", spaceId: "spc_old", author: { type: "user" }, target: { type: "broadcast" }, content: "q", status: "completed", createdAt, _seq: 1 },
      { id: "msg_out", spaceId: "spc_old", runId: "run_api", author: { type: "agent", agentId: "agt_api" }, target: { type: "broadcast" }, content: "a", status: "completed", createdAt, _seq: 3 },
    ],
    "runs.json": [{
      id: "run_api", agentId: "agt_api", spaceId: "spc_old", triggerMessageId: "msg_in",
      replyMessageIds: ["msg_out"], status: "completed", createdAt, _seq: 2,
    }],
    "activities.json": [{ id: "act_old", spaceId: "spc_old", runId: "run_api" }],
    "approvals.json": [{ id: "apr_old", spaceId: "spc_old", runId: "run_api" }],
    "session-states.json": { "acc_cli:spc_old": { threadId: "thr_old" } },
    "meta.json": { _seq: 3, eventSeqWatermark: 7 },
  };
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(dataPath, name), JSON.stringify(value), "utf8");
  }
  try {
    const store = await createStore({ dataPath, debounceMs: 5 });
    const space = store.find("spaces", "spc_old");
    assert.ok(space.activeSpaceSessionId);
    assert.equal(store.list("spaceSessions").length, 1);
    assert.equal(store.list("agentSessions").length, 2);
    for (const name of ["messages", "runs", "activities", "approvals"]) {
      assert.equal(store.list(name)[0].spaceSessionId, space.activeSpaceSessionId, `${name} is backfilled`);
    }
    const migratedRun = store.find("runs", "run_api");
    assert.equal(migratedRun.accountId, "acc_api");
    assert.equal(migratedRun.role, "main");
    assert.equal(migratedRun.parentRunId, null);
    assert.equal(migratedRun.contextGeneration, 1);
    const cliSession = store.list("agentSessions").find((item) => item.agentId === "agt_cli");
    assert.deepEqual(store.list("providerBindings").find((item) => item.agentSessionId === cliSession.id).providerState,
      { threadId: "thr_old" });
    const apiSession = store.list("agentSessions").find((item) => item.agentId === "agt_api");
    assert.equal(migratedRun.agentSessionId, apiSession.id);
    const history = store.list("apiHistories").find((item) => item.agentSessionId === apiSession.id);
    assert.equal(history.version, 1);
    assert.deepEqual(history.turns[0].assistant, [{ messageId: "msg_out", content: "a", createdAt }]);
    assert.equal("getSessionState" in store, false);
    await store.close();
    assert.equal(await exists(join(dataPath, "session-states.json")), false);
    assert.equal(await exists(join(dataPath, "session-states.json.legacy")), true);
    const meta = JSON.parse(await readFile(join(dataPath, "meta.json"), "utf8"));
    assert.equal(meta.contextSessionsMigrationVersion, 1);

    // Simulate a crash after collection files were written but before the final
    // migration marker reached meta.json. Replay must adopt the existing IDs.
    await writeFile(join(dataPath, "meta.json"), JSON.stringify({
      ...meta, contextSessionsMigrationVersion: 0,
    }), "utf8");
    const reloaded = await createStore({ dataPath, debounceMs: 5 });
    assert.equal(reloaded.list("spaceSessions").length, 1, "restart does not duplicate SpaceSession");
    assert.equal(reloaded.list("providerBindings").length, 1, "restart does not duplicate binding");
    const highWatermark = Math.max(...[
      "agents", "accounts", "spaces", "messages", "runs", "spaceSessions", "agentSessions", "providerBindings", "apiHistories",
    ].flatMap((name) => reloaded.list(name).map((item) => item._seq ?? 0)));
    assert.ok(reloaded.insert("themes", { id: "thm_after_replay" })._seq > highWatermark,
      "a stale migration meta file cannot regress the global sequence");
    await reloaded.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
