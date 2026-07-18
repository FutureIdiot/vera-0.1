// Codex adapter temporary-gateway black-box and opt-in real CLI M2 gate.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeCodex } from "../adapters/codex-cli-fixture.js";
import { createCodexAdapter } from "../../src/adapters/codex-adapter.js";
import { createHttpClient, startGateway } from "./_helpers.mjs";
import { createStore } from "../../src/store/store.js";
import { createMemoryTaskRuntime } from "../../src/memory/memory-task-runtime.js";

async function verifyDigestTask(dataPath, agentId, model) {
  const store = await createStore({ dataPath, debounceMs: 5 });
  try {
    createMemoryTaskRuntime({ store }).recordVerification({
      taskKind: "digest", executorAgentId: agentId, model,
    });
  } finally { await store.close(); }
}

async function waitForAgentReply(request, spaceId, sleep, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const timeline = await request("GET", `/api/spaces/${spaceId}/timeline?limit=20`);
    const reply = timeline.json.items.find((item) => item.itemType === "message"
      && item.author?.type === "account" && item.status === "completed");
    if (reply) return reply;
    await sleep(50);
  }
  return null;
}

async function waitForJob(request, agentId, jobId, sleep, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let job;
  while (Date.now() < deadline) {
    job = (await request("GET", `/api/agents/${agentId}/memory/_digest-jobs/${jobId}`)).json.job;
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    await sleep(50);
  }
  return job;
}

async function createScenario(request, { name, command, model, responseMode = "default" }) {
  const created = await request("POST", "/api/agents", {
    name, kind: "cli", provider: "codex",
    connection: { command, args: [], secretRef: null }, model,
  });
  const { agent, account } = created.json;
  const madeSpace = await request("POST", "/api/spaces", {
    name, seats: [{ accountId: account.id, responseMode }],
  });
  return { agent, account, space: madeSpace.json.space };
}

export async function run(ctx) {
  const { check, assert, assertEqual, repoRoot, sleep } = ctx;
  await check("p5-m2.5 Codex Account routes chat and digest while OpenCode digest stays paused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vera-codex-blackbox-"));
    const dataPath = join(dir, "data");
    const fake = await createFakeCodex();
    let gateway;
    try {
      gateway = await startGateway({
        repoRoot,
        cwd: dir,
        env: {
          VERA_DATA_PATH: dataPath,
          VERA_MEMORY_VAULT_PATH: join(dir, "memory"),
          VERA_CODEX_BIN: fake.binary,
          VERA_CODEX_WATCHDOG_MS: "5000",
          VERA_CODEX_MEMORY_DIGEST_TIMEOUT_MS: "5000",
        },
      });
      const request = createHttpClient(gateway.port);
      const { agent, account, space } = await createScenario(request, {
        name: "Codex black-box", command: fake.binary, model: "fake-proposal",
      });
      assertEqual(agent.runtimeProfile.provider, "codex");
      await gateway.stop();
      gateway = null;
      await verifyDigestTask(dataPath, agent.id, "fake-proposal");
      gateway = await startGateway({
        repoRoot,
        cwd: dir,
        env: {
          VERA_DATA_PATH: dataPath,
          VERA_MEMORY_VAULT_PATH: join(dir, "memory"),
          VERA_CODEX_BIN: fake.binary,
          VERA_CODEX_WATCHDOG_MS: "5000",
          VERA_CODEX_MEMORY_DIGEST_TIMEOUT_MS: "5000",
        },
      });
      const verifiedRequest = createHttpClient(gateway.port);
      const posted = await verifiedRequest("POST", `/api/spaces/${space.id}/messages`, {
        author: { type: "user" }, target: { type: "broadcast" }, content: "Vera test port is 3210.",
      });
      const reply = await waitForAgentReply(verifiedRequest, space.id, sleep, 5000);
      assertEqual(reply?.content, "CODEX_CHAT_OK");

      const queued = await verifiedRequest("POST", `/api/agents/${agent.id}/memory/_digest`, {
        accountId: account.id, spaceId: space.id, spaceSessionId: posted.json.message.spaceSessionId, mode: "range",
        fromMessageId: posted.json.message.id, toMessageId: posted.json.message.id,
      });
      assertEqual(queued.status, 202, JSON.stringify(queued.json));
      const job = await waitForJob(verifiedRequest, agent.id, queued.json.job.id, sleep, 5000);
      assertEqual(job.status, "succeeded");
      const memories = await verifiedRequest("GET", `/api/agents/${agent.id}/memory`);
      assertEqual(memories.json.memories[0].slug, "vera-test-port");
      assertEqual(memories.json.memories[0].sourceCount, 1);

      const recallSpace = await verifiedRequest("POST", "/api/spaces", {
        name: "Codex cross-Space recall", seats: [{ accountId: account.id }],
      });
      const recalled = await verifiedRequest("POST", `/api/spaces/${recallSpace.json.space.id}/messages`, {
        author: { type: "user" }, target: { type: "direct", accountIds: [account.id] },
        content: "What is the Vera test port?",
      });
      assertEqual(recalled.status, 201);
      const recallReply = await waitForAgentReply(
        verifiedRequest, recallSpace.json.space.id, sleep, 5000,
      );
      assertEqual(recallReply?.content, "CODEX_CHAT_OK");

      await sleep(300);
      const bindings = JSON.parse(await readFile(join(dir, "data", "providerBindings.json"), "utf8"));
      const run = posted.json.runs.find((item) => item.agentId === agent.id);
      assert(run, "Codex chat must expose its AgentSession generation");
      const binding = bindings.find((item) =>
        item.agentSessionId === run.agentSessionId &&
        item.generation === run.contextGeneration &&
        item.accountId === account.id);
      assert(binding, "Codex chat must persist a generation-scoped provider binding");
      assertEqual(binding.providerState.threadId, "thr_fake_1");
      const calls = await fake.readInvocations();
      assertEqual(calls.length, 3);
      assert(calls[1].args.includes("--output-schema"), "digest must pass --output-schema");
      assert(!calls[1].args.includes("resume"), "digest must not resume chat");
      assert(/Vera 记忆库常驻索引/.test(calls[2].input), "new Space must receive the resident Memory index");
      assert(/vera-test-port/.test(calls[2].input), "new Space must recall the digested Memory slug");
      assert(/Vera uses port 3210/.test(calls[2].input), "new Space must recall the digested Memory projection");

      const openCode = await verifiedRequest("POST", "/api/agents", {
        name: "Paused OpenCode", kind: "cli", provider: "opencode",
        connection: { command: "/nonexistent/opencode", args: [], secretRef: null }, model: "navy/paused",
      });
      const openSpace = await verifiedRequest("POST", "/api/spaces", {
        name: "Paused OpenCode", seats: [{ accountId: openCode.json.account.id, responseMode: "silent" }],
      });
      const openMessage = await verifiedRequest("POST", `/api/spaces/${openSpace.json.space.id}/messages`, {
        author: { type: "user" }, target: { type: "broadcast" }, content: "Do not execute OpenCode digest.",
      });
      const openQueued = await verifiedRequest("POST", `/api/agents/${openCode.json.agent.id}/memory/_digest`, {
        accountId: openCode.json.account.id, spaceId: openSpace.json.space.id, spaceSessionId: openMessage.json.message.spaceSessionId, mode: "range",
        fromMessageId: openMessage.json.message.id, toMessageId: openMessage.json.message.id,
      });
      assertEqual(openQueued.status, 202, JSON.stringify(openQueued.json));
      const openJob = await waitForJob(verifiedRequest, openCode.json.agent.id, openQueued.json.job.id, sleep, 5000);
      assertEqual(openJob.status, "failed");
      assertEqual(openJob.error.code, "memory_task_unavailable");
      assertEqual((await fake.readInvocations()).length, 3);
    } finally {
      if (gateway) await gateway.stop();
      await fake.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

export async function runReal(ctx) {
  if (process.env.VERA_TEST_CODEX_NATIVE !== "1") return;
  const { check, assert, assertEqual, repoRoot, sleep } = ctx;
  await check("p5-m2.6 real Codex CLI completes gateway chat and current M2 digest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vera-codex-real-"));
    const binary = process.env.VERA_CODEX_BIN || "/Applications/ChatGPT.app/Contents/Resources/codex";
    const model = process.env.VERA_TEST_CODEX_MODEL || "gpt-5.6-sol";
    let gateway;
    try {
      gateway = await startGateway({
        repoRoot,
        cwd: dir,
        env: {
          VERA_DATA_PATH: join(dir, "data"),
          VERA_MEMORY_VAULT_PATH: join(dir, "memory"),
          VERA_CODEX_BIN: binary,
          VERA_CODEX_CHAT_SANDBOX: "read-only",
          VERA_CODEX_WATCHDOG_MS: "300000",
          VERA_CODEX_MEMORY_DIGEST_TIMEOUT_MS: "300000",
        },
      });
      const request = createHttpClient(gateway.port);
      const { agent, account, space } = await createScenario(request, {
        name: "Codex real M2", command: binary, model,
      });
      const statement = "Durable Vera rule: the real Codex M2 verification marker is codex-m2-2026-07-14.";
      const posted = await request("POST", `/api/spaces/${space.id}/messages`, {
        author: { type: "user" }, target: { type: "broadcast" },
        content: `${statement}\n\nFor this chat turn, reply with exactly CODEX_GATEWAY_CHAT_OK and do not use tools.`,
      });
      const reply = await waitForAgentReply(request, space.id, sleep, 300000);
      assert(reply?.content?.includes("CODEX_GATEWAY_CHAT_OK"), "real Codex chat must complete");

      const queued = await request("POST", `/api/agents/${agent.id}/memory/_digest`, {
        accountId: account.id, spaceId: space.id, spaceSessionId: posted.json.message.spaceSessionId, mode: "range",
        fromMessageId: posted.json.message.id, toMessageId: posted.json.message.id,
      });
      assertEqual(queued.status, 202, JSON.stringify(queued.json));
      const job = await waitForJob(request, agent.id, queued.json.job.id, sleep, 300000);
      assertEqual(job.status, "succeeded", JSON.stringify(job.error));
      const memories = (await request("GET", `/api/agents/${agent.id}/memory`)).json.memories;
      assert(memories.some((memory) => memory.sourceCount >= 1), "real digest must apply a sourced Memory");

      await sleep(300);
      const bindings = JSON.parse(await readFile(join(dir, "data", "providerBindings.json"), "utf8"));
      const binding = bindings.find((item) =>
        item.agentSessionId === posted.json.runs[0].agentSessionId &&
        item.generation === posted.json.runs[0].contextGeneration &&
        item.accountId === account.id);
      assert(typeof binding?.providerState?.threadId === "string", "real chat must persist generation binding threadId");

      const abortAdapter = createCodexAdapter({
        config: { binary, chatSandbox: "read-only", watchdogMs: 300000, maxInputBytes: 12000 },
      });
      const controller = new AbortController();
      const pending = abortAdapter.run({
        agent, account,
        prompt: { text: "Wait before replying. Do not use tools.", turnText: "", historyUserText: null, residentBlock: null },
        spaceSessionId: "sps_real_abort", agentSessionId: "ags_real_abort",
        contextGeneration: 1, sessionMode: "main", providerBinding: null,
        workspacePath: dir, signal: controller.signal,
      });
      pending.catch(() => {});
      setTimeout(() => controller.abort(), 100);
      let abortCode = null;
      try { await pending; } catch (error) { abortCode = error.code; }
      assertEqual(abortCode, "cancelled", "real Codex capability probe must abort mid-flight");
      await abortAdapter.shutdown();
    } finally {
      if (gateway) await gateway.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
