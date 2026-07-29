import test from "node:test";
import assert from "node:assert/strict";

import { createAntigravityAdapter } from "../../src/adapters/antigravity-adapter.js";
import { createFakeAntigravity } from "./antigravity-cli-fixture.js";

function runtime(command, model = "fake-chat", overrides = {}) {
  return {
    kind: "cli",
    provider: "antigravity",
    model,
    connection: { command, args: [], secretRef: null },
    ...overrides,
  };
}

function context(command, overrides = {}) {
  const deltas = [];
  const activities = [];
  const persisted = [];
  const rotations = [];
  const controller = new AbortController();
  return {
    ctx: {
      runtime: runtime(command),
      workspacePath: process.cwd(),
      prompt: { text: "Inspect this Workspace once" },
      sessionMode: "main",
      providerBinding: null,
      signal: controller.signal,
      onDelta: (delta) => deltas.push(delta),
      onActivity: (activity) => activities.push(activity),
      persistProviderBinding: async (providerState, ifVersion) => {
        persisted.push({ providerState, ifVersion });
        return { version: 1, providerState };
      },
      rotateProviderBinding: async (input) => {
        rotations.push(input);
        return {
          generation: 2,
          prompt: { text: `ROTATED ${input.reason}` },
          providerBinding: null,
        };
      },
      ...overrides,
    },
    deltas,
    activities,
    persisted,
    rotations,
    controller,
  };
}

function adapter(binary, overrides = {}) {
  return createAntigravityAdapter({
    config: {
      binary,
      projectId: "project-fixed",
      watchdogMs: 1000,
      maxInputBytes: 65536,
      ...overrides,
    },
  });
}

test("Antigravity stream persists and resumes one conversation without duplicate result text", async (t) => {
  const fake = await createFakeAntigravity(t);
  const instance = adapter(fake.binary);
  t.after(() => instance.shutdown());
  const first = context(fake.binary);
  const firstResult = await instance.run(first.ctx);
  assert.deepEqual(first.deltas, ["AGY_CHAT_OK"]);
  assert.deepEqual(first.persisted, [{
    providerState: { conversationId: "agy-conversation-1" },
    ifVersion: null,
  }]);
  assert.deepEqual(firstResult, {
    content: "AGY_CHAT_OK",
    providerBinding: {
      version: 1,
      providerState: { conversationId: "agy-conversation-1" },
    },
    usage: {
      inputTokens: 10000,
      outputTokens: 4,
      thinkingTokens: 2,
      cacheReadTokens: 0,
      totalTokens: 10006,
    },
  });
  const tool = first.activities.filter((item) => item.label === "run_command").at(-1);
  assert.equal(tool.kind, "command");
  assert.equal(tool.toolStatus, "completed");
  assert.equal(tool.detail.includes(process.cwd()), true);

  const second = context(fake.binary, { providerBinding: firstResult.providerBinding });
  const secondResult = await instance.run(second.ctx);
  assert.deepEqual(second.deltas, ["AGY_RESUME_OK"]);
  assert.equal(secondResult.usage.inputTokens, 24000);
  assert.deepEqual(second.persisted, []);
  const calls = await fake.calls();
  assert.deepEqual(calls[0].args.slice(0, 4), ["--project", "project-fixed", "--model", "fake-chat"]);
  assert.equal(calls[0].prompt, "Inspect this Workspace once");
  assert.equal(calls[0].args.includes("--dangerously-skip-permissions"), false);
  assert.equal(calls[0].args.includes("--sandbox"), false);
  assert.deepEqual(
    calls[1].args.slice(calls[1].args.indexOf("--conversation"), calls[1].args.indexOf("--conversation") + 2),
    ["--conversation", "agy-conversation-1"],
  );
});

test("invalid binding and silent provider conversation replacement rotate before any text escapes", async (t) => {
  const fake = await createFakeAntigravity(t);
  const instance = adapter(fake.binary);
  t.after(() => instance.shutdown());
  const invalid = context(fake.binary, {
    providerBinding: { version: 1, providerState: { broken: true } },
  });
  const invalidResult = await instance.run(invalid.ctx);
  assert.equal(invalidResult.content, "AGY_CHAT_OK");
  assert.deepEqual(invalid.rotations, [{ reason: "invalid" }]);
  assert.equal((await fake.calls())[0].prompt, "ROTATED invalid");

  const stale = context(fake.binary, {
    providerBinding: {
      version: 2,
      providerState: { conversationId: "stale-conversation" },
    },
  });
  const result = await instance.run(stale.ctx);
  assert.equal(result.content, "AGY_CHAT_OK");
  assert.deepEqual(stale.rotations, [{ reason: "missing" }]);
  assert.deepEqual(stale.deltas, ["AGY_CHAT_OK"]);
  assert.equal(stale.deltas.includes("MUST_NOT_ESCAPE"), false);
  const calls = await fake.calls();
  assert.equal(calls.at(-2).args.includes("stale-conversation"), true);
  assert.equal(calls.at(-1).args.includes("--conversation"), false);
  assert.equal(calls.at(-1).prompt, "ROTATED missing");
});

test("fragmented JSONL and result fallback work while provider errors remain redacted", async (t) => {
  const fake = await createFakeAntigravity(t);
  const instance = adapter(fake.binary);
  t.after(() => instance.shutdown());
  const fragmented = context(fake.binary, { runtime: runtime(fake.binary, "fake-fragmented") });
  assert.equal((await instance.run(fragmented.ctx)).content, "AGY_CHAT_OK");
  const fallback = context(fake.binary, { runtime: runtime(fake.binary, "fake-fallback") });
  assert.equal((await instance.run(fallback.ctx)).content, "FALLBACK_OK");
  assert.deepEqual(fallback.deltas, ["FALLBACK_OK"]);
  const failed = context(fake.binary, { runtime: runtime(fake.binary, "fake-provider-error") });
  await assert.rejects(() => instance.run(failed.ctx), (error) =>
    error.code === "provider_error" &&
    !error.message.includes("google") &&
    !error.message.includes("http"));
  const missing = context(fake.binary, { runtime: runtime(fake.binary, "fake-no-result") });
  await assert.rejects(() => instance.run(missing.ctx), (error) => error.code === "provider_error");
  const wrongCwd = context(fake.binary, { runtime: runtime(fake.binary, "fake-wrong-cwd") });
  await assert.rejects(() => instance.run(wrongCwd.ctx), (error) => error.code === "provider_error");
});

test("headless permission soft-deny resumes once without creating an Approval or rotating", async (t) => {
  const fake = await createFakeAntigravity(t);
  const instance = adapter(fake.binary);
  t.after(() => instance.shutdown());
  const denied = context(fake.binary, {
    prompt: { text: "TRIGGER_PERMISSION_DENIAL" },
    requestApproval: () => {
      throw new Error("Antigravity headless soft-deny must not create a Vera Approval");
    },
  });
  const result = await instance.run(denied.ctx);
  assert.equal(result.content, "AGY_PERMISSION_CONTINUED");
  assert.deepEqual(denied.deltas, ["AGY_PERMISSION_CONTINUED"]);
  assert.deepEqual(denied.rotations, []);
  assert.equal(result.providerBinding.providerState.conversationId, "agy-conversation-1");
  assert.equal(result.usage.inputTokens, 12000);
  const deniedActivity = denied.activities.filter((item) => item.label === "run_command").at(-1);
  assert.equal(deniedActivity.toolStatus, "failed");
  assert.equal(deniedActivity.summary, "工具权限申请已自动拒绝");
  const calls = await fake.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.includes("--conversation"), true);
  assert.equal(calls[1].prompt.startsWith("Vera control notice:"), true);
  assert.equal(calls[1].prompt.includes("Do not retry that tool"), true);

  const filesystem = context(fake.binary, {
    prompt: { text: "TRIGGER_FILESYSTEM_PERMISSION_ERROR" },
  });
  const filesystemResult = await instance.run(filesystem.ctx);
  assert.equal(filesystemResult.content, "");
  assert.equal(filesystem.activities.at(-1).summary, "命令执行失败");
  assert.equal((await fake.calls()).length, 3);

  const repeated = context(fake.binary, {
    runtime: runtime(fake.binary, "fake-permission-loop"),
    prompt: { text: "TRIGGER_PERMISSION_DENIAL" },
  });
  await assert.rejects(
    () => instance.run(repeated.ctx),
    (error) => error.code === "provider_error" && !error.message.includes("printf"),
  );
  assert.deepEqual(repeated.rotations, []);
  assert.equal((await fake.calls()).length, 5);
});

test("runtime guards, isolated mode, capacity, cancellation, timeout and shutdown are strict", async (t) => {
  const fake = await createFakeAntigravity(t);
  const instance = adapter(fake.binary);
  const bad = [
    runtime(fake.binary, "fake-chat", { kind: "api" }),
    runtime(fake.binary, "fake-chat", { provider: "agy" }),
    runtime(fake.binary, "fake-chat", {
      connection: { command: "/tmp/not-antigravity", args: [], secretRef: null },
    }),
    runtime(fake.binary, "fake-chat", {
      connection: { command: fake.binary, args: ["--sandbox"], secretRef: null },
    }),
    runtime(fake.binary, "fake-chat", {
      connection: { command: fake.binary, args: [], secretRef: "oauth" },
    }),
  ];
  for (const item of bad) {
    await assert.rejects(
      () => instance.run(context(fake.binary, { runtime: item }).ctx),
      (error) => error.code === "unavailable",
    );
  }
  assert.deepEqual(await fake.calls(), []);
  const noProject = createAntigravityAdapter({ config: { binary: fake.binary } });
  await assert.rejects(
    () => noProject.run(context(fake.binary).ctx),
    (error) => error.code === "unavailable",
  );
  const noPersistence = context(fake.binary, { persistProviderBinding: undefined });
  await assert.rejects(
    () => instance.run(noPersistence.ctx),
    (error) => error.code === "provider_error",
  );

  const isolated = context(fake.binary, {
    sessionMode: "isolated",
    providerBinding: { version: 1, providerState: { conversationId: "must-ignore" } },
    persistProviderBinding: () => { throw new Error("isolated must not persist"); },
    rotateProviderBinding: () => { throw new Error("isolated must not rotate"); },
  });
  assert.deepEqual(await instance.run(isolated.ctx), {
    content: "AGY_CHAT_OK",
    usage: {
      inputTokens: 10000,
      outputTokens: 4,
      thinkingTokens: 2,
      cacheReadTokens: 0,
      totalTokens: 10006,
    },
  });

  const small = adapter(fake.binary, { maxInputBytes: 3 });
  await assert.rejects(() => small.run(context(fake.binary).ctx), (error) => error.code === "provider_error");

  const pre = context(fake.binary);
  pre.controller.abort();
  await assert.rejects(() => instance.run(pre.ctx), (error) => error.code === "cancelled");

  const aborting = context(fake.binary, { runtime: runtime(fake.binary, "fake-hang") });
  const pending = instance.run(aborting.ctx);
  pending.catch(() => {});
  while ((await fake.calls()).length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  aborting.controller.abort();
  await assert.rejects(pending, (error) => error.code === "cancelled");

  const timeout = adapter(fake.binary, { watchdogMs: 30 });
  await assert.rejects(
    () => timeout.run(context(fake.binary, { runtime: runtime(fake.binary, "fake-hang") }).ctx),
    (error) => error.code === "timed_out",
  );
  await timeout.shutdown();
  await noProject.shutdown();
  await small.shutdown();
  await instance.shutdown();
  await instance.shutdown();
  await assert.rejects(() => instance.run(context(fake.binary).ctx), (error) => error.code === "unavailable");
});
