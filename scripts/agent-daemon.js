#!/usr/bin/env node

import { createDaemonClient } from "../src/agents/daemon-client.js";
import { createDaemonCredentialStore } from "../src/agents/daemon-credentials.js";
import { loadConfig } from "../src/core/config.js";
import { createCodexAdapter } from "../src/adapters/codex-adapter.js";
import { createOllamaAdapter } from "../src/adapters/ollama-adapter.js";
import { createOpencodeAdapter } from "../src/adapters/opencode-adapter.js";

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

function adapterFor(runtime, config) {
  if (runtime.kind === "cli" && runtime.provider === "codex") return createCodexAdapter({ config: config.codex });
  if (runtime.kind === "cli" && runtime.provider === "opencode") return createOpencodeAdapter({ config: config.opencode });
  if (runtime.kind === "api" && runtime.provider === "ollama") return createOllamaAdapter({ config: config.ollama });
  throw Object.assign(new Error("runtime executor is unavailable"), { code: "unavailable" });
}

export async function main({ env = process.env, fetchImpl = globalThis.fetch, executor = null } = {}) {
  const config = loadConfig(env);
  const runtime = json(env, "VERA_AGENT_RUNTIME_JSON");
  const workspace = json(env, "VERA_AGENT_WORKSPACE_JSON");
  const adapter = executor ? null : adapterFor(runtime, config);
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
