// Antigravity adapter temporary-gateway black-box and opt-in real CLI gate.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAntigravityAdapter } from "../../src/adapters/antigravity-adapter.js";
import { loadConfig } from "../../src/core/config.js";
import { createFakeAntigravity } from "../adapters/antigravity-cli-fixture.js";
import {
  createHttpClient,
  enrollDaemonIdentity,
  startGateway,
  startTestDaemon,
} from "./_helpers.mjs";

async function waitForReplies(request, spaceId, count, sleep, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const timeline = await request("GET", `/api/spaces/${spaceId}/timeline?limit=30`);
    const replies = timeline.json.items.filter((item) =>
      item.itemType === "message" &&
      item.author?.type === "account" &&
      item.status === "completed");
    if (replies.length >= count) return replies;
    await sleep(50);
  }
  return [];
}

export async function run(ctx) {
  const { check, assert, assertEqual, repoRoot, sleep } = ctx;
  await check("p5 Antigravity daemon chat rotates silent conversation replacement and reports CLI usage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vera-antigravity-blackbox-"));
    const dataPath = join(dir, "data");
    const fake = await createFakeAntigravity();
    let gateway;
    let daemon;
    let executionError = null;
    try {
      gateway = await startGateway({
        repoRoot,
        cwd: dir,
        env: {
          VERA_DATA_PATH: dataPath,
          VERA_MEMORY_VAULT_PATH: join(dir, "memory"),
          VERA_ANTIGRAVITY_BIN: fake.binary,
          VERA_ANTIGRAVITY_PROJECT_ID: "project-blackbox",
          VERA_ANTIGRAVITY_WATCHDOG_MS: "5000",
        },
      });
      const request = createHttpClient(gateway.port);
      const identity = await enrollDaemonIdentity({
        port: gateway.port,
        name: "Antigravity black-box",
        runtimeProfile: {
          schemaVersion: 1,
          kind: "cli",
          provider: "antigravity",
          model: "fake-rotate",
        },
      });
      const madeSpace = await request("POST", "/api/spaces", {
        name: "Antigravity black-box",
        seats: [{ accountId: identity.account.id, responseMode: "default" }],
      });
      const runtime = {
        hostId: `antigravity-${identity.agent.id}`,
        kind: "cli",
        provider: "antigravity",
        model: "fake-rotate",
        revision: identity.agent.runtimeRevision,
        runtimeCapabilities: { models: ["fake-rotate"], tools: [] },
        connection: { command: fake.binary, args: [], secretRef: null },
      };
      const config = loadConfig({
        VERA_ANTIGRAVITY_BIN: fake.binary,
        VERA_ANTIGRAVITY_PROJECT_ID: "project-blackbox",
        VERA_ANTIGRAVITY_WATCHDOG_MS: "5000",
      });
      const adapter = createAntigravityAdapter({ config: config.antigravity });
      daemon = await startTestDaemon({
        port: gateway.port,
        agentId: identity.agent.id,
        accountId: identity.account.id,
        agentToken: identity.agentToken,
        accountKey: identity.accountKey,
        runtime,
        workspace: {
          hostId: runtime.hostId,
          path: dir,
          status: "ready",
          policy: { allow: ["read", "write"] },
        },
        executor: {
          execute(context) {
            return adapter.run({
              runtime: { ...runtime, model: context.run.effectiveModel },
              workspacePath: dir,
              agent: context.agent,
              account: context.account,
              sessionMode: context.input.sessionMode,
              prompt: { text: context.input.promptText },
              providerBinding: context.input.providerBinding ?? null,
              signal: context.signal,
              onDelta: context.onDelta,
              onActivity: context.onActivity,
              persistProviderBinding: context.persistProviderBinding,
              rotateProviderBinding: context.rotateProviderBinding,
            }).catch((error) => {
              executionError = error;
              throw error;
            });
          },
          shutdown: () => adapter.shutdown(),
        },
      });
      const spaceId = madeSpace.json.space.id;
      const first = await request("POST", `/api/spaces/${spaceId}/messages`, {
        author: { type: "user" },
        target: { type: "broadcast" },
        content: "First Antigravity turn",
      });
      const firstReplies = await waitForReplies(request, spaceId, 1, sleep, 5000);
      assertEqual(
        firstReplies.length,
        1,
        `${executionError?.code ?? ""}:${executionError?.message ?? ""} ` +
          JSON.stringify((await request("GET", `/api/spaces/${spaceId}/timeline?limit=30`)).json),
      );
      const second = await request("POST", `/api/spaces/${spaceId}/messages`, {
        author: { type: "user" },
        target: { type: "broadcast" },
        content: "Second Antigravity turn",
      });
      const replies = await waitForReplies(request, spaceId, 2, sleep, 5000);
      assertEqual(replies.length, 2);
      assertEqual(replies[0].content, "AGY_CHAT_OK");
      assertEqual(replies[1].content, "AGY_CHAT_OK");

      await sleep(200);
      const calls = await fake.calls();
      assertEqual(calls.length, 3);
      assert(calls[1].args.includes("--conversation"), "second attempt must resume the frozen binding");
      assert(!calls[2].args.includes("--conversation"), "rotation retry must create a fresh conversation");
      assert(!JSON.stringify(calls).includes("dangerously-skip-permissions"), "dangerous bypass must never be sent");
      assert(!JSON.stringify(calls).includes("--sandbox"), "scratch sandbox must never replace the Account Workspace");

      const firstRun = first.json.runs.find((item) => item.agentId === identity.agent.id);
      const secondRun = second.json.runs.find((item) => item.agentId === identity.agent.id);
      assert(firstRun && secondRun, "both Antigravity messages must create a Run");
      const sessions = JSON.parse(await readFile(join(dataPath, "agentSessions.json"), "utf8"));
      const currentSession = sessions.find((item) => item.id === secondRun.agentSessionId);
      assertEqual(currentSession.generation, 2);
      assertEqual(currentSession.context.measurement, "provider_reported");
      assertEqual(currentSession.context.estimatedInputTokens, 10000);
      const bindings = JSON.parse(await readFile(join(dataPath, "providerBindings.json"), "utf8"));
      const binding = bindings.find((item) =>
        item.agentSessionId === secondRun.agentSessionId &&
        item.generation === 2 &&
        item.accountId === identity.account.id);
      assertEqual(binding.providerState.conversationId, "agy-conversation-1");
    } finally {
      if (gateway) await gateway.stop();
      await daemon?.stop();
      await fake.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

export async function runReal(ctx) {
  if (process.env.VERA_TEST_ANTIGRAVITY_NATIVE !== "1") return;
  const { check, assert, assertEqual } = ctx;
  await check("p5 real Antigravity CLI 1.1.8 streams and resumes the configured Project", async () => {
    const binary = process.env.VERA_ANTIGRAVITY_BIN || "agy";
    const projectId = process.env.VERA_ANTIGRAVITY_PROJECT_ID;
    const workspacePath = process.env.VERA_TEST_ANTIGRAVITY_WORKSPACE || process.cwd();
    const model = process.env.VERA_TEST_ANTIGRAVITY_MODEL || "gemini-3.6-flash-low";
    assert(projectId, "VERA_ANTIGRAVITY_PROJECT_ID is required for the real gate");
    const adapter = createAntigravityAdapter({
      config: {
        binary,
        projectId,
        mode: "plan",
        watchdogMs: 300000,
        maxInputBytes: 65536,
      },
    });
    const persisted = [];
    const base = {
      runtime: {
        kind: "cli",
        provider: "antigravity",
        model,
        connection: { command: binary, args: [], secretRef: null },
      },
      workspacePath,
      sessionMode: "main",
      signal: new AbortController().signal,
      onActivity() {},
      persistProviderBinding: async (providerState, ifVersion) => {
        const binding = { version: (ifVersion ?? 0) + 1, providerState };
        persisted.push(binding);
        return binding;
      },
    };
    try {
      const first = await adapter.run({
        ...base,
        prompt: { text: "Remember the marker AGY_NATIVE_729. Reply exactly FIRST_OK." },
        providerBinding: null,
        onDelta() {},
      });
      assertEqual(typeof first.providerBinding?.providerState?.conversationId, "string");
      assert(Number.isFinite(first.usage?.inputTokens), "real result must include provider input usage");
      const second = await adapter.run({
        ...base,
        prompt: { text: "Reply with the marker from the previous turn and nothing else." },
        providerBinding: first.providerBinding,
        onDelta() {},
      });
      assert(second.content.includes("AGY_NATIVE_729"), "real resume must preserve prior turn context");
      assertEqual(second.providerBinding.providerState.conversationId,
        first.providerBinding.providerState.conversationId);
    } finally {
      await adapter.shutdown();
    }
  });
}
