#!/usr/bin/env node

import { createDaemonClient } from "../src/agents/daemon-client.js";
import { createDaemonCredentialStore } from "../src/agents/daemon-credentials.js";
import { loadConfig } from "../src/core/config.js";
import { createCodexAdapter } from "../src/adapters/codex-adapter.js";
import { createOllamaAdapter } from "../src/adapters/ollama-adapter.js";
import { createOpencodeAdapter } from "../src/adapters/opencode-adapter.js";
import { createClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { createAntigravityAdapter } from "../src/adapters/antigravity-adapter.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw Object.assign(new Error(`${name} is required`), { code: "invalid_config" });
  return value;
}

function json(env, name) {
  try { return JSON.parse(required(env, name)); }
  catch (error) {
    if (error?.code === "invalid_config") throw error;
    throw Object.assign(new Error(`${name} is invalid`), { code: "invalid_config" });
  }
}

export function adapterFor(runtime, config) {
  if (runtime.kind === "cli" && runtime.provider === "codex") return createCodexAdapter({ config: config.codex });
  if (runtime.kind === "cli" && runtime.provider === "opencode") return createOpencodeAdapter({ config: config.opencode });
  if (runtime.kind === "cli" && runtime.provider === "claude-code") {
    return createClaudeCodeAdapter({ config: config.claudeCode });
  }
  if (runtime.kind === "cli" && runtime.provider === "antigravity") {
    return createAntigravityAdapter({ config: config.antigravity });
  }
  if (runtime.kind === "api" && runtime.provider === "ollama") return createOllamaAdapter({ config: config.ollama });
  throw Object.assign(new Error("runtime executor is unavailable"), { code: "unavailable" });
}

export async function discoverRuntimeCapabilities(runtime, adapter, config) {
  const models = runtime.runtimeCapabilities?.models ?? [runtime.model];
  const existing = Array.isArray(runtime.runtimeCapabilities?.modelContexts)
    ? runtime.runtimeCapabilities.modelContexts
    : [];
  let discoveredCapabilities = {};
  if (typeof adapter?.discoverRuntimeCapabilities === "function") {
    try {
      discoveredCapabilities = await adapter.discoverRuntimeCapabilities(runtime) ?? {};
    } catch {
      discoveredCapabilities = {};
    }
  } else if (runtime.kind === "api" && runtime.provider === "ollama") {
    discoveredCapabilities = {
      modelContexts: models.map((model) => ({
        model,
        contextWindowTokens: config.ollama.numCtx,
        measurement: "verified_config",
      })),
    };
  }
  const discovered = discoveredCapabilities.modelContexts ?? [];
  const byModel = new Map(existing.map((item) => [item.model, item]));
  for (const item of discovered) byModel.set(item.model, item);
  const { contextCompaction: _configuredCompaction, ...configuredCapabilities } =
    runtime.runtimeCapabilities ?? {};
  return {
    ...runtime,
    runtimeCapabilities: {
      ...configuredCapabilities,
      models,
      ...(byModel.size ? {
        modelContexts: [...byModel.values()].sort((left, right) => left.model.localeCompare(right.model)),
      } : {}),
      ...(discoveredCapabilities.contextCompaction === "native"
        ? { contextCompaction: "native" }
        : {}),
    },
  };
}

export async function main({ env = process.env, fetchImpl = globalThis.fetch, executor = null } = {}) {
  const config = loadConfig(env);
  const configuredRuntime = json(env, "VERA_AGENT_RUNTIME_JSON");
  const workspace = json(env, "VERA_AGENT_WORKSPACE_JSON");
  const adapter = executor ? null : adapterFor(configuredRuntime, config);
  const runtime = await discoverRuntimeCapabilities(configuredRuntime, adapter, config);
  const daemonExecutor = executor ?? {
    execute(context) {
      const { input, run } = context;
      const executionRuntime = { ...runtime, model: run.effectiveModel };
      return adapter.run({
        runtime: executionRuntime,
        workspacePath: workspace.path,
        agent: context.agent,
        account: context.account,
        sessionMode: input.sessionMode,
        prompt: input.kind === "cli" ? { text: input.promptText } : { apiMessages: input.messages },
        providerBinding: input.kind === "cli" ? input.providerBinding ?? null : null,
        historyVersion: input.kind === "api" ? input.historyVersion ?? null : null,
        spaceSessionId: run.spaceSessionId,
        agentSessionId: run.agentSessionId,
        contextGeneration: run.contextGeneration,
        accountId: run.accountId,
        signal: context.signal,
        onDelta: context.onDelta,
        onActivity: context.onActivity,
        persistProviderBinding: context.persistProviderBinding,
        rotateProviderBinding: context.rotateProviderBinding,
        delegate: context.delegate,
        sendRunMessage: context.sendRunMessage,
        readRunMessages: context.readRunMessages,
      });
    },
    async executeCoordination(context) {
      const directory = await mkdtemp(join(tmpdir(), "vera-coordination-"));
      try {
        const { input, run } = context;
        const executionRuntime = { ...runtime, model: run.effectiveModel };
        return await adapter.run({
          runtime: executionRuntime,
          workspacePath: directory,
          agent: context.agent,
          account: context.account,
          sessionMode: "isolated",
          prompt: input.kind === "cli" ? { text: input.promptText } : { apiMessages: input.messages },
          providerBinding: null,
          historyVersion: null,
          spaceSessionId: run.spaceSessionId,
          agentSessionId: null,
          contextGeneration: null,
          accountId: run.accountId,
          signal: context.signal,
          onDelta: context.onDelta,
          onActivity: () => {},
          delegate: context.delegate,
          sendRunMessage: context.sendRunMessage,
          readRunMessages: context.readRunMessages,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async executeCatchup(context) {
      const directory = await mkdtemp(join(tmpdir(), "vera-catchup-"));
      try {
        const { input, run } = context;
        const executionRuntime = { ...runtime, model: run.effectiveModel };
        const rejectCatchupTool = (activity = {}) => {
          if (["reasoning", "status", "usage"].includes(activity.kind)) return;
          throw Object.assign(new Error("catch-up tools are disabled"), { code: "provider_error" });
        };
        return await adapter.run({
          runtime: executionRuntime,
          workspacePath: directory,
          agent: context.agent,
          account: context.account,
          sessionMode: "isolated",
          prompt: input.kind === "cli" ? { text: input.promptText } : { apiMessages: input.messages },
          providerBinding: null,
          historyVersion: null,
          spaceSessionId: run.spaceSessionId,
          agentSessionId: null,
          contextGeneration: null,
          accountId: run.accountId,
          signal: context.signal,
          onDelta: context.onDelta,
          onActivity: rejectCatchupTool,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    compactSession(context) {
      return adapter.compactSession?.({
        ...context,
        runtime,
        workspacePath: workspace.path,
      });
    },
    shutdown: () => adapter.shutdown?.(),
  };
  const memoryExecutor = adapter ? {
    digestMemory: adapter.digestMemory?.bind(adapter),
    dreamMemory: adapter.dreamMemory?.bind(adapter),
  } : executor?.memoryExecutor ?? null;
  const client = createDaemonClient({
    gatewayUrl: required(env, "VERA_GATEWAY_URL"),
    agentId: required(env, "VERA_AGENT_ID"),
    accountId: required(env, "VERA_ACCOUNT_ID"),
    runtime,
    workspace,
    credentialStore: createDaemonCredentialStore({ secretsPath: config.agentDaemon.secretsPath }),
    executor: daemonExecutor,
    memoryExecutor,
    activitySummaryMaxLength: config.activity.summaryMaxLength,
    fetchImpl,
  });
  await client.start();
  const result = await client.wait();
  if (result.reason !== "gateway_unreachable" && result.reason !== "stopped") process.exitCode = 1;
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`agent daemon stopped: ${error?.code ?? "internal"}`);
    process.exitCode = 1;
  });
}
