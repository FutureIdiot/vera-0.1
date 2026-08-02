#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDaemonCredentialStore } from "../src/agents/daemon-credentials.js";
import { loadConfig } from "../src/core/config.js";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw Object.assign(new Error(`${name} is required`), { code: "invalid_config" });
  return value;
}

function gatewayUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Object.assign(new Error("VERA_GATEWAY_URL is invalid"), { code: "invalid_config" }); }
  if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) {
    throw Object.assign(new Error("VERA_GATEWAY_URL is not allowed"), { code: "invalid_config" });
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

async function* sseEnvelopes(body) {
  if (!body) throw Object.assign(new Error("wake event stream has no body"), { code: "gateway_unreachable" });
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/gu, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /u, ""))
        .join("\n");
      if (!data) continue;
      try { yield JSON.parse(data); }
      catch { throw Object.assign(new Error("wake event data is invalid"), { code: "invalid_event" }); }
    }
  }
}

export function createAgentWaker({
  gatewayUrl: configuredGatewayUrl,
  agentId,
  accountId,
  credentialStore,
  daemonPath = fileURLToPath(new URL("./agent-daemon.js", import.meta.url)),
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  reconnectMs = 5000,
  env = process.env,
} = {}) {
  const gateway = gatewayUrl(configuredGatewayUrl);
  const safeAgentId = required({ agentId }, "agentId");
  const safeAccountId = required({ accountId }, "accountId");
  if (!credentialStore?.load || typeof fetchImpl !== "function" || typeof spawnImpl !== "function") {
    throw Object.assign(new Error("agent waker dependencies are unavailable"), { code: "invalid_config" });
  }
  let child = null;
  let stopped = false;
  let abortController = null;
  let loopPromise = null;

  async function loadToken() {
    const credentials = await credentialStore.load({ agentId: safeAgentId, accountId: safeAccountId });
    if (!credentials?.agentToken) throw Object.assign(new Error("Agent Token is unavailable"), { code: "unauthorized" });
    return credentials.agentToken;
  }

  function startDaemon() {
    if (child && child.exitCode === null && !child.killed) return false;
    const next = spawnImpl(process.execPath, ["--preserve-symlinks-main", daemonPath], {
      env: { ...env },
      stdio: "inherit",
    });
    child = next;
    next.once?.("exit", () => {
      if (child === next) child = null;
    });
    return true;
  }

  async function readWakeEvents(token) {
    const url = new URL("/api/agent/wake-events", gateway);
    url.searchParams.set("accountId", safeAccountId);
    abortController = new AbortController();
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: abortController.signal,
    });
    if (!response.ok) {
      const error = Object.assign(new Error(`wake event stream returned ${response.status}`), { code: "gateway_unreachable" });
      throw error;
    }
    for await (const envelope of sseEnvelopes(response.body)) {
      if (envelope?.type !== "account.wake.requested" || envelope.data?.accountId !== safeAccountId) continue;
      startDaemon();
    }
  }

  async function run() {
    const token = await loadToken();
    startDaemon();
    while (!stopped) {
      try {
        await readWakeEvents(token);
      } catch (error) {
        if (stopped || error?.name === "AbortError") break;
      }
      if (!stopped) await sleep(reconnectMs);
    }
  }

  return {
    start() {
      if (!loopPromise) loopPromise = run();
      return loopPromise;
    },
    async stop() {
      stopped = true;
      abortController?.abort();
      child?.kill?.("SIGTERM");
      await loopPromise?.catch(() => {});
    },
    wait() { return loopPromise ?? Promise.resolve(); },
  };
}

export async function main({ env = process.env, fetchImpl = globalThis.fetch, spawnImpl = spawn } = {}) {
  const config = loadConfig(env);
  const agentId = required(env, "VERA_AGENT_ID");
  const accountId = required(env, "VERA_ACCOUNT_ID");
  const waker = createAgentWaker({
    gatewayUrl: required(env, "VERA_GATEWAY_URL"),
    agentId,
    accountId,
    credentialStore: createDaemonCredentialStore({ secretsPath: config.agentDaemon.secretsPath }),
    fetchImpl,
    spawnImpl,
    env,
  });
  await waker.start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`agent waker stopped: ${error?.code ?? "internal"}`);
    process.exitCode = 1;
  });
}
