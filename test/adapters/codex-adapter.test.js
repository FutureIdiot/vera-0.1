import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";

import { createCodexAdapter, projectCodexDigestSchema } from "../../src/adapters/codex-adapter.js";
import { MEMORY_DIGEST_OUTPUT_JSON_SCHEMA, validateDigestProposals } from "../../src/memory/memory-proposals.js";
import { createFakeCodex } from "./codex-cli-fixture.js";

function account(command, overrides = {}) {
  return {
    id: "acc_codex", kind: "cli", provider: "codex",
    connection: { command, args: [], secretRef: null }, model: "fake-chat", ...overrides,
  };
}

function makeCtx(command, overrides = {}) {
  const deltas = [];
  const activities = [];
  const persisted = [];
  const controller = new AbortController();
  return {
    ctx: {
      agent: { id: "agt_codex", name: "Codex" },
      account: account(command),
      prompt: { text: "INDEX\n\nquestion", turnText: "question", historyUserText: "question", residentBlock: "INDEX" },
      sessionState: null,
      workspacePath: process.cwd(),
      onDelta: (value) => deltas.push(value),
      onActivity: (value) => activities.push(value),
      persistSessionState: (value) => persisted.push(value),
      signal: controller.signal,
      ...overrides,
    },
    deltas, activities, persisted, controller,
  };
}

function digestInput(command, overrides = {}) {
  return {
    account: account(command, { model: "fake-proposal" }),
    payload: {
      agent: { id: "agt_codex", name: "Codex" },
      chunks: [{ id: "dch_1", messages: [{ messageId: "msg_1", content: "Vera test port is 3210." }] }],
      facts: [], proposalSchema: MEMORY_DIGEST_OUTPUT_JSON_SCHEMA,
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function hasForbiddenSchemaKey(value) {
  if (!value || typeof value !== "object") return false;
  if (Object.keys(value).some((key) => ["oneOf", "patternProperties", "pattern", "const"].includes(key))) return true;
  return Object.values(value).some(hasForbiddenSchemaKey);
}

test("Codex transport schema is strict-compatible and preserves all proposal actions", () => {
  const schema = projectCodexDigestSchema(MEMORY_DIGEST_OUTPUT_JSON_SCHEMA);
  assert.equal(hasForbiddenSchemaKey(schema), false);
  const variants = schema.properties.proposals.items.anyOf;
  assert.deepEqual([...new Set(variants.map((item) => item.properties.action.enum[0]))].sort(),
    ["archive", "create", "skip", "supersede", "update"]);
  for (const variant of variants) assert.deepEqual([...variant.required].sort(), Object.keys(variant.properties).sort());
  assert.throws(() => projectCodexDigestSchema({}), (error) => error.code === "executor_unavailable");
});

test("kind/provider, secretRef and unsupported args fail before spawning", async (t) => {
  const fake = await createFakeCodex(t);
  const adapter = createCodexAdapter({ config: { binary: fake.binary } });
  const bad = [
    account(fake.binary, { kind: "api" }),
    account(fake.binary, { provider: "opencode" }),
    account(fake.binary, { connection: { command: "/tmp/not-codex", args: [], secretRef: null } }),
    account(fake.binary, { connection: { command: fake.binary, args: [], secretRef: "key" } }),
    account(fake.binary, { connection: { command: fake.binary, args: ["--search"], secretRef: null } }),
  ];
  for (const item of bad) {
    await assert.rejects(() => adapter.run(makeCtx(fake.binary, { account: item }).ctx), (error) => error.code === "unavailable");
  }
  await assert.rejects(
    () => adapter.digestMemory(digestInput(fake.binary, { account: bad[0] })),
    (error) => error.code === "executor_unavailable",
  );
  assert.deepEqual(await fake.readInvocations(), []);
});

test("chat uses non-interactive exec, persists thread id, resumes, and maps tool activity", async (t) => {
  const fake = await createFakeCodex(t);
  const adapter = createCodexAdapter({ config: { binary: fake.binary } });
  const first = makeCtx(fake.binary, { account: account(fake.binary, { model: "fake-tool" }) });
  const firstResult = await adapter.run(first.ctx);
  assert.equal(firstResult.content, "CODEX_CHAT_OK");
  assert.deepEqual(first.deltas, ["CODEX_CHAT_OK"]);
  assert.deepEqual(first.persisted, [{ threadId: "thr_fake_1" }]);
  assert.equal(first.activities[0].label, "command_execution");
  assert.deepEqual(firstResult.sessionState, { threadId: "thr_fake_1" });

  const second = makeCtx(fake.binary, { sessionState: firstResult.sessionState });
  const secondResult = await adapter.run(second.ctx);
  assert.equal(secondResult.content, "CODEX_RESUME_OK");
  const calls = await fake.readInvocations();
  assert.equal(calls[0].input, "INDEX\n\nquestion");
  assert.deepEqual(calls[0].args.slice(0, 7), ["-C", process.cwd(), "-a", "never", "-s", "workspace-write", "exec"]);
  assert.equal(calls[0].args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.deepEqual(calls[1].args.slice(6, 9), ["exec", "resume", "thr_fake_1"]);
});

test("invalid state and explicit missing thread reset, while ordinary provider errors do not", async (t) => {
  const fake = await createFakeCodex(t);
  const adapter = createCodexAdapter({ config: { binary: fake.binary } });
  const invalid = makeCtx(fake.binary, { sessionState: { broken: true } });
  await adapter.run(invalid.ctx);
  assert.equal(invalid.activities[0].label, "session-reset");

  const stale = makeCtx(fake.binary, { sessionState: { threadId: "stale-thread" } });
  const result = await adapter.run(stale.ctx);
  assert.equal(result.content, "CODEX_CHAT_OK");
  assert.equal(stale.activities[0].label, "session-reset");

  const failed = makeCtx(fake.binary, {
    account: account(fake.binary, { model: "fake-provider-error" }),
    sessionState: { threadId: "healthy-thread" },
  });
  await assert.rejects(() => adapter.run(failed.ctx), (error) => error.code === "provider_error" && !error.message.includes("secret"));
  assert.equal(failed.activities.length, 0);
});

test("chat parses fragmented JSONL and uses output-file fallback without fake deltas", async (t) => {
  const fake = await createFakeCodex(t);
  const adapter = createCodexAdapter({ config: { binary: fake.binary } });
  const fragmented = makeCtx(fake.binary, { account: account(fake.binary, { model: "fake-fragmented" }) });
  assert.equal((await adapter.run(fragmented.ctx)).content, "CODEX_CHAT_OK");
  assert.deepEqual(fragmented.deltas, ["CODEX_CHAT_OK"]);

  const fallback = makeCtx(fake.binary, { account: account(fake.binary, { model: "fake-output-only" }) });
  assert.equal((await adapter.run(fallback.ctx)).content, "CODEX_CHAT_OK");
  assert.deepEqual(fallback.deltas, []);
});

test("chat enforces capacity, abort, timeout, malformed JSONL and idempotent shutdown", async (t) => {
  const fake = await createFakeCodex(t);
  const pre = makeCtx(fake.binary);
  pre.controller.abort();
  const preAdapter = createCodexAdapter({ config: { binary: fake.binary } });
  await assert.rejects(() => preAdapter.run(pre.ctx), (error) => error.code === "cancelled");

  const small = createCodexAdapter({ config: { binary: fake.binary, maxInputBytes: 4 } });
  await assert.rejects(() => small.run(makeCtx(fake.binary).ctx), (error) => error.code === "provider_error");

  const abortAdapter = createCodexAdapter({ config: { binary: fake.binary, watchdogMs: 1000 } });
  const aborted = makeCtx(fake.binary, { account: account(fake.binary, { model: "fake-hang" }) });
  const pending = abortAdapter.run(aborted.ctx);
  pending.catch(() => {});
  while ((await fake.readInvocations()).length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  aborted.controller.abort();
  await assert.rejects(pending, (error) => error.code === "cancelled");

  const timeout = createCodexAdapter({ config: { binary: fake.binary, watchdogMs: 30 } });
  await assert.rejects(
    () => timeout.run(makeCtx(fake.binary, { account: account(fake.binary, { model: "fake-hang" }) }).ctx),
    (error) => error.code === "timed_out",
  );
  const malformed = createCodexAdapter({ config: { binary: fake.binary } });
  await assert.rejects(
    () => malformed.run(makeCtx(fake.binary, { account: account(fake.binary, { model: "fake-bad-jsonl" }) }).ctx),
    (error) => error.code === "provider_error",
  );
  await malformed.shutdown();
  await malformed.shutdown();
  await assert.rejects(() => malformed.run(makeCtx(fake.binary).ctx), (error) => error.code === "unavailable");
});

test("shutdown cancels and awaits the complete in-flight operation cleanup", async (t) => {
  const fake = await createFakeCodex(t);
  const adapter = createCodexAdapter({ config: { binary: fake.binary, watchdogMs: 1000 } });
  const running = adapter.run(makeCtx(fake.binary, {
    account: account(fake.binary, { model: "fake-hang" }),
  }).ctx);
  running.catch(() => {});
  while ((await fake.readInvocations()).length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  const call = (await fake.readInvocations())[0];
  const outputPath = call.args[call.args.indexOf("--output-last-message") + 1];
  let settled = false;
  running.then(() => { settled = true; }, () => { settled = true; });
  await adapter.shutdown();
  assert.equal(settled, true);
  await assert.rejects(running, (error) => error.code === "cancelled");
  await assert.rejects(() => access(outputPath));
});

test("digest is isolated, uses --output-schema, cleans temp files, and passes the gateway validator", async (t) => {
  const fake = await createFakeCodex(t);
  const adapter = createCodexAdapter({ config: { binary: fake.binary } });
  const input = digestInput(fake.binary);
  const before = JSON.stringify(input.payload);
  const result = await adapter.digestMemory(input);
  assert.equal(JSON.stringify(input.payload), before);
  assert.deepEqual(result.execution, {
    adapter: "codex", primaryModel: "fake-proposal", effectiveModel: "fake-proposal",
    fallbackUsed: false, fallbackReason: null, attempts: 1,
  });
  validateDigestProposals({
    proposals: result.proposals,
    messages: [{ id: "msg_1", spaceId: "spc_1", status: "completed", content: "Vera test port is 3210." }],
    agentId: "agt_codex", spaceId: "spc_1", jobId: "mdj_1",
  });
  const calls = await fake.readInvocations();
  const call = calls[0];
  assert.equal(call.args.includes("--ephemeral"), true);
  assert.equal(call.args.includes("--ignore-user-config"), true);
  assert.equal(call.args.includes("--ignore-rules"), true);
  assert.equal(call.args.includes("--output-schema"), true);
  assert.equal(call.args.includes("resume"), false);
  assert.equal(call.input.includes("proposalSchema"), false);
  assert.equal(call.input.includes("isolated memory digest executor"), true);
  await assert.rejects(() => access(call.cwd));
});

test("digest rejects tool use, bad envelopes, pre/mid abort and timeout", async (t) => {
  const fake = await createFakeCodex(t);
  const adapter = createCodexAdapter({ config: { binary: fake.binary, digestTimeoutMs: 1000 } });
  await assert.rejects(
    () => adapter.digestMemory(digestInput(fake.binary, {
      payload: { agent: { id: "agt_codex", name: "Codex" }, chunks: [], facts: [], proposalSchema: {} },
    })),
    (error) => error.code === "executor_unavailable",
  );
  assert.deepEqual(await fake.readInvocations(), []);
  await assert.rejects(
    () => adapter.digestMemory(digestInput(fake.binary, { account: account(fake.binary, { model: "fake-tool" }) })),
    (error) => error.code === "executor_failed",
  );
  await assert.rejects(
    () => adapter.digestMemory(digestInput(fake.binary, { account: account(fake.binary, { model: "fake-bad-envelope" }) })),
    (error) => error.code === "executor_failed",
  );
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(() => adapter.digestMemory(digestInput(fake.binary, { signal: pre.signal })),
    (error) => error.code === "cancelled");

  const mid = new AbortController();
  const pending = adapter.digestMemory(digestInput(fake.binary, {
    account: account(fake.binary, { model: "fake-hang" }), signal: mid.signal,
  }));
  pending.catch(() => {});
  const seen = (await fake.readInvocations()).length;
  while ((await fake.readInvocations()).length === seen) await new Promise((resolve) => setTimeout(resolve, 5));
  mid.abort();
  await assert.rejects(pending, (error) => error.code === "cancelled");

  const timeout = createCodexAdapter({ config: { binary: fake.binary, digestTimeoutMs: 30 } });
  await assert.rejects(
    () => timeout.digestMemory(digestInput(fake.binary, { account: account(fake.binary, { model: "fake-hang" }) })),
    (error) => error.code === "timed_out",
  );
});
