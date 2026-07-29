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
  const rotations = [];
  const controller = new AbortController();
  return {
    ctx: {
      agent: { id: "agt_codex", name: "Codex" },
      runtime: account(command),
      prompt: { text: "INDEX\n\nquestion", turnText: "question", historyUserText: "question", residentBlock: "INDEX" },
      sessionMode: "main",
      providerBinding: null,
      workspacePath: process.cwd(),
      onDelta: (value) => deltas.push(value),
      onActivity: (value) => activities.push(value),
      persistProviderBinding: async (providerState, ifVersion) => {
        persisted.push({ providerState, ifVersion });
        return { version: persisted.length, providerState };
      },
      rotateProviderBinding: async (input) => {
        rotations.push(input);
        return { prompt: { text: `ROTATED ${input.reason}` }, providerBinding: null, generation: 2 };
      },
      signal: controller.signal,
      ...overrides,
    },
    deltas, activities, persisted, rotations, controller,
  };
}

function digestInput(command, overrides = {}) {
  const input = {
    runtime: account(command, { model: "fake-proposal" }),
    payload: {
      agent: { id: "agt_codex", name: "Codex" },
      chunks: [{ id: "dch_1", messages: [{ messageId: "msg_1", content: "Vera test port is 3210." }] }],
      facts: [], proposalSchema: MEMORY_DIGEST_OUTPUT_JSON_SCHEMA,
    },
    signal: new AbortController().signal,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "taskModel")) input.taskModel = input.runtime.model;
  return input;
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
    await assert.rejects(() => adapter.run(makeCtx(fake.binary, { runtime: item }).ctx), (error) => error.code === "unavailable");
  }
  await assert.rejects(
    () => adapter.digestMemory(digestInput(fake.binary, { runtime: bad[0] })),
    (error) => error.code === "executor_unavailable",
  );
  assert.deepEqual(await fake.readInvocations(), []);
});

test("chat uses non-interactive exec, CAS-persists provider binding, resumes, and maps tool activity", async (t) => {
  const fake = await createFakeCodex(t);
  const adapter = createCodexAdapter({ config: { binary: fake.binary } });
  const first = makeCtx(fake.binary, { runtime: account(fake.binary, { model: "fake-tool" }) });
  const firstResult = await adapter.run(first.ctx);
  assert.equal(firstResult.content, "CODEX_CHAT_OK");
  assert.deepEqual(first.deltas, ["CODEX_CHAT_OK"]);
  assert.deepEqual(first.persisted, [{ providerState: { threadId: "thr_fake_1" }, ifVersion: null }]);
  assert.equal(first.activities.filter((item) => item.phase === "thinking").at(-1)?.summary, "检查项目状态并运行验证");
  assert.equal(first.activities.find((item) => item.phase === "thinking")?.kind, "reasoning");
  assert.equal(first.activities.find((item) => item.phase === "tool")?.kind, "command");
  assert.equal(first.activities.find((item) => item.phase === "tool")?.summary, "已运行命令");
  assert.deepEqual(firstResult, {
    content: "CODEX_CHAT_OK",
    providerBinding: { version: 1, providerState: { threadId: "thr_fake_1" } },
    usage: {
      inputTokens: 101,
      outputTokens: 9,
      cacheReadTokens: 80,
      totalTokens: 110,
      contextWindowTokens: 950,
    },
  });
  assert.equal("sessionState" in firstResult, false);

  const second = makeCtx(fake.binary, { providerBinding: firstResult.providerBinding });
  const secondResult = await adapter.run(second.ctx);
  assert.deepEqual(secondResult, {
    content: "CODEX_RESUME_OK",
    providerBinding: firstResult.providerBinding,
    usage: {
      inputTokens: 101,
      outputTokens: 9,
      cacheReadTokens: 80,
      totalTokens: 110,
      contextWindowTokens: 950,
    },
  });
  assert.deepEqual(second.persisted, []);
  const calls = await fake.readInvocations();
  assert.equal(calls[0].input, "INDEX\n\nquestion");
  assert.deepEqual(calls[0].args.slice(0, 7), ["-C", process.cwd(), "-a", "never", "-s", "workspace-write", "exec"]);
  assert.equal(calls[0].args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.deepEqual(calls[1].args.slice(6, 9), ["exec", "resume", "thr_fake_1"]);
});

test("invalid binding and explicit missing thread rotate, while ordinary provider errors do not", async (t) => {
  const fake = await createFakeCodex(t);
  const adapter = createCodexAdapter({ config: { binary: fake.binary } });
  const invalid = makeCtx(fake.binary, {
    providerBinding: { version: 1, providerState: { broken: true } },
    rotateProviderBinding: async (reason) => {
      invalid.rotations.push(reason);
      return { prompt: { text: "FRESH INVALID CODEX PROMPT" }, providerBinding: null, generation: 2 };
    },
  });
  const invalidResult = await adapter.run(invalid.ctx);
  assert.equal(invalid.activities.find((item) => item.label === "session-reset")?.summary, "Codex 会话已重置");
  assert.deepEqual(invalid.rotations, [{ reason: "invalid" }]);
  assert.deepEqual(invalid.persisted, [{ providerState: { threadId: "thr_fake_1" }, ifVersion: null }]);
  assert.equal("sessionState" in invalidResult, false);
  assert.equal((await fake.readInvocations())[0].input, "FRESH INVALID CODEX PROMPT");

  const resetOrder = [];
  const stale = makeCtx(fake.binary, {
    providerBinding: { version: 1, providerState: { threadId: "stale-thread" } },
    rotateProviderBinding: async (reason) => {
      resetOrder.push({ type: "rotate", reason });
      return { prompt: { text: "FRESH CODEX PROMPT" }, providerBinding: null, generation: 2 };
    },
  });
  stale.ctx.onActivity = (activity) => {
    stale.activities.push(activity);
    resetOrder.push({ type: "activity", label: activity.label });
  };
  const result = await adapter.run(stale.ctx);
  assert.equal(result.content, "CODEX_CHAT_OK");
  assert.equal(stale.activities.find((item) => item.label === "session-reset")?.summary, "Codex 会话已重置");
  assert.deepEqual(resetOrder.filter((item) => item.type === "rotate" || item.label === "session-reset"), [
    { type: "activity", label: "session-reset" },
    { type: "rotate", reason: { reason: "missing" } },
  ]);
  assert.deepEqual(stale.persisted, [{ providerState: { threadId: "thr_fake_1" }, ifVersion: null }]);

  const callsAfterReset = await fake.readInvocations();
  assert.ok(callsAfterReset[1].args.includes("resume"), "first stale attempt must resume the old thread");
  assert.equal(callsAfterReset[2].args.includes("resume"), false, "fresh retry must not resume");
  assert.equal(callsAfterReset[2].input, "FRESH CODEX PROMPT");

  const ordinaryRotateReasons = [];
  const failed = makeCtx(fake.binary, {
    runtime: account(fake.binary, { model: "fake-provider-error" }),
    providerBinding: { version: 1, providerState: { threadId: "healthy-thread" } },
    rotateProviderBinding: async (reason) => {
      ordinaryRotateReasons.push(reason);
      return { prompt: { text: "ordinary errors must not use this" }, providerBinding: null, generation: 2 };
    },
  });
  await assert.rejects(() => adapter.run(failed.ctx), (error) => error.code === "provider_error" && !error.message.includes("secret"));
  assert.equal(failed.activities.every((item) => item.phase === "thinking"), true);
  assert.deepEqual(ordinaryRotateReasons, []);
});

test("Codex preserves actionable native quota and rate-limit errors while redacting secrets", async (t) => {
  const fake = await createFakeCodex(t);
  const adapter = createCodexAdapter({ config: { binary: fake.binary } });
  const quota = makeCtx(fake.binary, {
    runtime: account(fake.binary, { model: "fake-quota-error" }),
  });
  await assert.rejects(
    () => adapter.run(quota.ctx),
    (error) => error.code === "quota_exhausted" &&
      error.message ===
        "Codex: You've hit your usage limit. Try again at 5:06 PM. token=[redacted]" &&
      !/SECRET|example/iu.test(error.message),
  );
  const rate = makeCtx(fake.binary, {
    runtime: account(fake.binary, { model: "fake-rate-error" }),
  });
  await assert.rejects(
    () => adapter.run(rate.ctx),
    (error) => error.code === "rate_limited" &&
      error.message ===
        "Codex: HTTP 429: too many requests; retry after 12 seconds; Bearer [redacted]" &&
      !/SECRET/iu.test(error.message),
  );
});

test("Codex discovers model-specific usable context windows from the installed CLI catalog", async (t) => {
  const fake = await createFakeCodex(t);
  const adapter = createCodexAdapter({ config: { binary: fake.binary } });
  const capabilities = await adapter.discoverRuntimeCapabilities({
    ...account(fake.binary),
    runtimeCapabilities: { models: ["fake-chat", "fake-tool", "not-in-catalog"] },
  });
  assert.deepEqual(capabilities.modelContexts, [
    {
      model: "fake-chat",
      contextWindowTokens: 950,
      measurement: "provider_reported",
    },
    {
      model: "fake-tool",
      contextWindowTokens: 1800,
      measurement: "provider_reported",
    },
  ]);
  assert.equal(capabilities.contextCompaction, "native");
});

test("Codex native compact resumes the same app-server thread and fails closed", async (t) => {
  const fake = await createFakeCodex(t);
  const adapter = createCodexAdapter({ config: { binary: fake.binary, watchdogMs: 1000 } });
  const providerBinding = {
    version: 2,
    accountId: "acc_codex",
    providerFingerprint: "sha256:codex",
    providerState: { threadId: "thread-native" },
  };
  assert.deepEqual(await adapter.compactSession({
    runtime: account(fake.binary),
    workspacePath: process.cwd(),
    input: { providerBinding },
    signal: new AbortController().signal,
  }), { providerBinding });
  const requests = (await fake.readInvocations())
    .filter((item) => item.args[0] === "app-server" && item.args[1] === "--stdio")
    .map((item) => JSON.parse(item.input));
  assert.deepEqual(requests.map((item) => item.method), [
    "initialize", "thread/resume", "thread/compact/start",
  ]);
  assert.equal(requests[1].params.threadId, "thread-native");
  assert.equal(requests[2].params.threadId, "thread-native");

  await assert.rejects(() => adapter.compactSession({
    runtime: account(fake.binary),
    workspacePath: process.cwd(),
    input: { providerBinding: {
      ...providerBinding,
      providerState: { threadId: "thread-fail" },
    } },
    signal: new AbortController().signal,
  }), (error) => error.code === "provider_error");
});

test("isolated CLI run is one-shot and neither persists nor returns a binding", async (t) => {
  const fake = await createFakeCodex(t);
  const adapter = createCodexAdapter({ config: { binary: fake.binary } });
  const isolated = makeCtx(fake.binary, {
    sessionMode: "isolated",
    providerBinding: { version: 1, providerState: { threadId: "healthy-thread" } },
    persistProviderBinding: () => { throw new Error("isolated run must not persist"); },
    rotateProviderBinding: () => { throw new Error("isolated run must not rotate"); },
  });
  const result = await adapter.run(isolated.ctx);
  assert.deepEqual(result, { content: "CODEX_CHAT_OK" });
  assert.equal((await fake.readInvocations())[0].args.includes("resume"), false);
});

test("chat parses fragmented JSONL and uses output-file fallback without fake deltas", async (t) => {
  const fake = await createFakeCodex(t);
  const adapter = createCodexAdapter({ config: { binary: fake.binary } });
  const fragmented = makeCtx(fake.binary, { runtime: account(fake.binary, { model: "fake-fragmented" }) });
  assert.equal((await adapter.run(fragmented.ctx)).content, "CODEX_CHAT_OK");
  assert.deepEqual(fragmented.deltas, ["CODEX_CHAT_OK"]);

  const fallback = makeCtx(fake.binary, { runtime: account(fake.binary, { model: "fake-output-only" }) });
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
  const aborted = makeCtx(fake.binary, { runtime: account(fake.binary, { model: "fake-hang" }) });
  const pending = abortAdapter.run(aborted.ctx);
  pending.catch(() => {});
  while ((await fake.readInvocations()).length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  aborted.controller.abort();
  await assert.rejects(pending, (error) => error.code === "cancelled");

  const timeout = createCodexAdapter({ config: { binary: fake.binary, watchdogMs: 30 } });
  await assert.rejects(
    () => timeout.run(makeCtx(fake.binary, { runtime: account(fake.binary, { model: "fake-hang" }) }).ctx),
    (error) => error.code === "timed_out",
  );
  const malformed = createCodexAdapter({ config: { binary: fake.binary } });
  await assert.rejects(
    () => malformed.run(makeCtx(fake.binary, { runtime: account(fake.binary, { model: "fake-bad-jsonl" }) }).ctx),
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
    runtime: account(fake.binary, { model: "fake-hang" }),
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
    () => adapter.digestMemory(digestInput(fake.binary, { runtime: account(fake.binary, { model: "fake-tool" }) })),
    (error) => error.code === "executor_failed",
  );
  await assert.rejects(
    () => adapter.digestMemory(digestInput(fake.binary, { runtime: account(fake.binary, { model: "fake-bad-envelope" }) })),
    (error) => error.code === "executor_failed",
  );
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(() => adapter.digestMemory(digestInput(fake.binary, { signal: pre.signal })),
    (error) => error.code === "cancelled");

  const mid = new AbortController();
  const pending = adapter.digestMemory(digestInput(fake.binary, {
    runtime: account(fake.binary, { model: "fake-hang" }), signal: mid.signal,
  }));
  pending.catch(() => {});
  const seen = (await fake.readInvocations()).length;
  while ((await fake.readInvocations()).length === seen) await new Promise((resolve) => setTimeout(resolve, 5));
  mid.abort();
  await assert.rejects(pending, (error) => error.code === "cancelled");

  const timeout = createCodexAdapter({ config: { binary: fake.binary, digestTimeoutMs: 30 } });
  await assert.rejects(
    () => timeout.digestMemory(digestInput(fake.binary, { runtime: account(fake.binary, { model: "fake-hang" }) })),
    (error) => error.code === "timed_out",
  );
});
