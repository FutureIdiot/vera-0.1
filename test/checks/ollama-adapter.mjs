// Native Ollama adapter temporary-gateway black-box fixture.

import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHttpClient, enrollDaemonIdentity, startGateway, startTestDaemon } from "./_helpers.mjs";
import { createStore } from "../../src/store/store.js";
import { createMemoryTaskRuntime } from "../../src/memory/memory-task-runtime.js";
import { createOllamaAdapter } from "../../src/adapters/ollama-adapter.js";
import { loadConfig } from "../../src/core/config.js";

async function verifyDigestTask(dataPath, agentId, model) {
  const store = await createStore({ dataPath, debounceMs: 5 });
  try {
    createMemoryTaskRuntime({ store }).recordVerification({
      taskKind: "digest", executorAgentId: agentId, model,
    });
  } finally { await store.close(); }
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

async function waitForStoredJob(path, jobId, sleep, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const jobs = JSON.parse(await readFile(path, "utf8"));
      const job = jobs.find((item) => item.id === jobId);
      if (job?.proposals && ["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    } catch {
      // Store debounce may not have created/flushed the collection file yet.
    }
    await sleep(50);
  }
  return null;
}

function proposalForEvidence(proposals, messageId) {
  return proposals.find((proposal) => proposal.evidenceMessageIds?.includes(messageId));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function startOllamaStub() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/api/chat") {
      res.writeHead(404).end();
      return;
    }
    const body = await readBody(req);
    requests.push(body);
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ message: { content: "OLLAMA_GATEWAY_STUB_OK" }, done: false })}\n`);
      res.end(`${JSON.stringify({ message: { content: "" }, done: true })}\n`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: { content: JSON.stringify({ proposals: [] }) }, done: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export async function run(ctx) {
  const { check, assert, assertEqual, repoRoot, sleep } = ctx;
  await check("p5-m2.4 Ollama Account routes chat and digest through the native adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vera-ollama-blackbox-"));
    const dataPath = join(dir, "data");
    const ollama = await startOllamaStub();
    let gateway;
    let daemon;
    try {
      gateway = await startGateway({
        repoRoot,
        env: {
          VERA_DATA_PATH: dataPath,
          VERA_MEMORY_VAULT_PATH: join(dir, "memory"),
          VERA_OLLAMA_WATCHDOG_MS: "5000",
          VERA_OLLAMA_MEMORY_DIGEST_TIMEOUT_MS: "5000",
        },
      });
      const identity = await enrollDaemonIdentity({
        port: gateway.port,
        name: "Ollama black-box",
        runtimeProfile: { schemaVersion: 1, kind: "api", provider: "ollama", model: "gemma4:e4b" },
      });
      const { agent, account } = identity;
      assertEqual(agent.runtimeProfile.provider, "ollama");
      await gateway.stop();
      gateway = null;
      await verifyDigestTask(dataPath, agent.id, "gemma4:e4b");
      gateway = await startGateway({
        repoRoot,
        env: {
          VERA_DATA_PATH: dataPath,
          VERA_MEMORY_VAULT_PATH: join(dir, "memory"),
          VERA_OLLAMA_WATCHDOG_MS: "5000",
          VERA_OLLAMA_MEMORY_DIGEST_TIMEOUT_MS: "5000",
          VERA_MEMORY_TASK_TRANSPORT: "daemon",
        },
      });
      const verifiedRequest = createHttpClient(gateway.port);
      const runtime = {
        hostId: `ollama-${agent.id}`,
        kind: "api",
        provider: "ollama",
        model: "gemma4:e4b",
        revision: agent.runtimeRevision,
        runtimeCapabilities: { models: ["gemma4:e4b"], tools: [] },
        connection: { baseUrl: ollama.baseUrl, secretRef: null },
      };
      const adapter = createOllamaAdapter({ config: loadConfig({
        VERA_OLLAMA_WATCHDOG_MS: "5000",
        VERA_OLLAMA_MEMORY_DIGEST_TIMEOUT_MS: "5000",
      }).ollama });
      daemon = await startTestDaemon({
        port: gateway.port,
        agentId: agent.id,
        accountId: account.id,
        agentToken: identity.agentToken,
        accountKey: identity.accountKey,
        runtime,
        workspace: { hostId: runtime.hostId, path: dir, status: "ready", policy: { allow: ["read", "write"] } },
        executor: {
          execute(context) {
            return adapter.run({
              runtime,
              sessionMode: context.input.sessionMode,
              prompt: { apiMessages: context.input.messages },
              historyVersion: context.input.historyVersion,
              signal: context.signal,
              onDelta: context.onDelta,
              onActivity: context.onActivity,
            });
          },
          shutdown: () => adapter.shutdown?.(),
        },
        memoryExecutor: {
          digestMemory: (input) => adapter.digestMemory(input),
          dreamMemory: (input) => adapter.dreamMemory(input),
        },
      });
      const madeSpace = await verifiedRequest("POST", "/api/spaces", {
        name: "Ollama black-box",
        seats: [{ accountId: account.id, responseMode: "default" }],
      });
      const space = madeSpace.json.space;
      const posted = await verifiedRequest("POST", `/api/spaces/${space.id}/messages`, {
        author: { type: "user" }, target: { type: "broadcast" }, content: "raw gateway question",
      });
      const userMessage = posted.json.message;

      let reply;
      for (let attempt = 0; attempt < 100 && !reply; attempt += 1) {
        const timeline = await verifiedRequest("GET", `/api/spaces/${space.id}/timeline?limit=20`);
        reply = timeline.json.items.find((item) => item.itemType === "message"
          && item.author?.type === "account" && item.status === "completed");
        if (!reply) await sleep(25);
      }
      assertEqual(reply?.content, "OLLAMA_GATEWAY_STUB_OK");

      const queued = await verifiedRequest("POST", `/api/agents/${agent.id}/memory/_digest`, {
        accountId: account.id, spaceId: space.id, spaceSessionId: userMessage.spaceSessionId, mode: "range",
        fromMessageId: userMessage.id, toMessageId: reply.id,
      });
      assertEqual(queued.status, 202, JSON.stringify(queued.json));
      let job = queued.json.job;
      for (let attempt = 0; attempt < 100 && !["succeeded", "failed", "cancelled"].includes(job.status); attempt += 1) {
        await sleep(25);
        job = (await verifiedRequest("GET", `/api/agents/${agent.id}/memory/_digest-jobs/${job.id}`)).json.job;
      }
      assertEqual(job.status, "succeeded");
      assertEqual(ollama.requests.length, 2);
      assertEqual(ollama.requests[0].stream, true);
      assertEqual(ollama.requests[1].stream, false);
      assertEqual(ollama.requests[0].model, "gemma4:e4b");
      assert(!("tools" in ollama.requests[1]), "digest must not receive Tools");
      const schemaText = JSON.stringify(ollama.requests[1].format);
      assert(!/oneOf|patternProperties|"pattern"|"const"/.test(schemaText), "Ollama transport schema must stay compatible");

      await sleep(300);
      const histories = JSON.parse(await readFile(join(dir, "data", "apiHistories.json"), "utf8"));
      const run = posted.json.runs.find((item) => item.agentId === agent.id);
      assert(run, "Ollama chat must expose its AgentSession generation");
      const history = histories.find((item) =>
        item.agentSessionId === run.agentSessionId && item.generation === run.contextGeneration);
      assert(history, "Ollama chat must persist generation-scoped API history");
      assertEqual(history.version, 1);
      assertEqual(history.turns[0].input.content, "raw gateway question");
      assertEqual(history.turns[0].assistant[0].content, "OLLAMA_GATEWAY_STUB_OK");
      assertEqual("providerState" in history, false);
    } finally {
      await daemon?.stop();
      if (gateway) await gateway.stop();
      await ollama.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

export async function runReal(ctx) {
  if (process.env.VERA_TEST_OLLAMA_NATIVE !== "1") return;
  const { check, assert, assertEqual, repoRoot, sleep } = ctx;
  await check("p5-m2.7 real Gemma fixed raw semantic qualification through gateway", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vera-ollama-real-"));
    const baseUrl = process.env.VERA_TEST_OLLAMA_BASE_URL || "http://127.0.0.1:11434";
    const model = process.env.VERA_TEST_OLLAMA_MODEL || "gemma4:e4b";
    let gateway;
    try {
      gateway = await startGateway({
        repoRoot,
        cwd: dir,
        env: {
          VERA_DATA_PATH: join(dir, "data"),
          VERA_MEMORY_VAULT_PATH: join(dir, "memory"),
          VERA_OLLAMA_WATCHDOG_MS: "300000",
          VERA_OLLAMA_MEMORY_DIGEST_TIMEOUT_MS: "300000",
        },
      });
      const request = createHttpClient(gateway.port);
      const created = await request("POST", "/api/agents", {
        name: "Gemma raw qualification",
        kind: "api",
        provider: "ollama",
        connection: { baseUrl, secretRef: null },
        model,
      });
      assertEqual(created.status, 201);
      const { agent } = created.json;
      const other = await request("POST", "/api/agents", { name: "Raw fixture peer" });
      assertEqual(other.status, 201);
      const madeSpace = await request("POST", "/api/spaces", {
        name: "Gemma raw qualification",
        seats: [{ agentId: agent.id, responseMode: "silent" }],
      });
      const space = madeSpace.json.space;
      const post = async (author, content) => (await request("POST", `/api/spaces/${space.id}/messages`, {
        author, target: { type: "broadcast" }, content,
      })).json.message;

      const durable = await post(
        { type: "user" },
        "项目长期规则：Vera 的人工验收端口固定为 3210。以后每次人工验收都使用这个端口，除非用户明确更正。",
      );
      const duplicate = await post(
        { type: "user" },
        "再次确认同一条规则：Vera 人工验收仍使用端口 3210。",
      );
      const chatter = await post(
        { type: "user" },
        "刚才页面转圈两秒，刷新后已经恢复；今天只发生了这一次。",
      );
      const inference = await post(
        { type: "agent", agentId: other.json.agent.id },
        "因为用户没有反对，我猜用户长期偏好所有 Vera 页面使用紫色；用户从未表达过这个偏好。",
      );
      const invented = await post(
        { type: "agent", agentId: agent.id },
        "我个人觉得蓝色标题更好看；这是我刚刚临时产生的审美偏好，不是用户要求，也不来自项目规范。",
      );

      const firstQueued = await request("POST", `/api/agents/${agent.id}/memory/_digest`, {
        accountId: account.id, spaceId: space.id, spaceSessionId: durable.spaceSessionId, mode: "range",
        fromMessageId: durable.id, toMessageId: duplicate.id,
      });
      assertEqual(firstQueued.status, 202, JSON.stringify(firstQueued.json));
      const first = await waitForJob(request, agent.id, firstQueued.json.job.id, sleep, 300000);
      assertEqual(first.status, "succeeded", JSON.stringify(first.error));
      const firstStored = await waitForStoredJob(
        join(dir, "data", "memoryDigestJobs.json"), first.id, sleep, 5000,
      );
      assert(firstStored, "first raw semantic job must be flushed with proposals");
      const writes = firstStored.proposals.filter((proposal) => proposal.action !== "skip");
      assertEqual(writes.length, 1, JSON.stringify(firstStored.proposals));
      assert(writes[0].evidenceMessageIds.includes(durable.id), "durable rule must source the single write");
      if (!writes[0].evidenceMessageIds.includes(duplicate.id)) {
        const duplicateProposal = proposalForEvidence(firstStored.proposals, duplicate.id);
        assertEqual(duplicateProposal?.action, "skip");
        assertEqual(duplicateProposal?.skipReason, "duplicate_in_job");
      }

      for (const [negative, reason] of [
        [chatter, "no_reusable_fact"],
        [inference, "unsupported_inference"],
        [invented, "unsupported_inference"],
      ]) {
        const negativeQueued = await request("POST", `/api/agents/${agent.id}/memory/_digest`, {
          accountId: account.id, spaceId: space.id, spaceSessionId: negative.spaceSessionId, mode: "range",
          fromMessageId: negative.id, toMessageId: negative.id,
        });
        assertEqual(negativeQueued.status, 202, JSON.stringify(negativeQueued.json));
        const negativeJob = await waitForJob(request, agent.id, negativeQueued.json.job.id, sleep, 300000);
        const negativeStored = await waitForStoredJob(
          join(dir, "data", "memoryDigestJobs.json"), negativeJob.id, sleep, 5000,
        );
        assertEqual(negativeJob.status, "succeeded", JSON.stringify({ error: negativeJob.error, proposals: negativeStored?.proposals }));
        assert(negativeStored.proposals.length >= 1, "each negative qualification range must return a skip");
        assert(negativeStored.proposals.every((proposal) => proposal.action === "skip"), JSON.stringify(negativeStored.proposals));
        const proposal = proposalForEvidence(negativeStored.proposals, negative.id);
        assertEqual(proposal?.skipReason, reason, JSON.stringify(negativeStored.proposals));
      }

      let memories = (await request("GET", `/api/agents/${agent.id}/memory`)).json.memories;
      assertEqual(memories.length, 1);
      const slug = memories[0].slug;
      let detail = (await request("GET", `/api/agents/${agent.id}/memory/${slug}`)).json.memory;
      const negativeIds = new Set([chatter.id, inference.id, invented.id]);
      assert(detail.sources.every((source) => !negativeIds.has(source.messageId)), "negative raw Messages must not become sources");
      const factId = first.result.facts[0].factId;

      const repeated = await post(
        { type: "user" },
        "再次确认：Vera 的人工验收端口仍固定为 3210。",
      );
      const repeatedQueued = await request("POST", `/api/agents/${agent.id}/memory/_digest`, {
        accountId: account.id, spaceId: space.id, spaceSessionId: repeated.spaceSessionId, mode: "range",
        fromMessageId: repeated.id, toMessageId: repeated.id,
      });
      assertEqual(repeatedQueued.status, 202, JSON.stringify(repeatedQueued.json));
      const repeatedJob = await waitForJob(request, agent.id, repeatedQueued.json.job.id, sleep, 300000);
      assertEqual(repeatedJob.status, "succeeded", JSON.stringify(repeatedJob.error));
      const repeatedStored = await waitForStoredJob(
        join(dir, "data", "memoryDigestJobs.json"), repeatedJob.id, sleep, 5000,
      );
      assertEqual(repeatedStored.proposals.length, 1, JSON.stringify(repeatedStored.proposals));
      assertEqual(repeatedStored.proposals[0].action, "update");
      assertEqual(repeatedStored.proposals[0].targetFactId, factId);
      assertEqual(repeatedStored.proposals[0].evidenceMessageIds[0], repeated.id);

      const correction = await post(
        { type: "user" },
        "纠正：Vera 的人工验收端口不再是 3210，改为 3211；这条更正取代之前的 3210 规则。",
      );
      const correctionQueued = await request("POST", `/api/agents/${agent.id}/memory/_digest`, {
        accountId: account.id, spaceId: space.id, spaceSessionId: correction.spaceSessionId, mode: "range",
        fromMessageId: correction.id, toMessageId: correction.id,
      });
      assertEqual(correctionQueued.status, 202, JSON.stringify(correctionQueued.json));
      const correctionJob = await waitForJob(request, agent.id, correctionQueued.json.job.id, sleep, 300000);
      assertEqual(correctionJob.status, "succeeded", JSON.stringify(correctionJob.error));
      const correctionStored = await waitForStoredJob(
        join(dir, "data", "memoryDigestJobs.json"), correctionJob.id, sleep, 5000,
      );
      assertEqual(correctionStored.proposals.length, 1, JSON.stringify(correctionStored.proposals));
      assertEqual(correctionStored.proposals[0].action, "supersede");
      assertEqual(correctionStored.proposals[0].targetFactId, factId);
      assertEqual(correctionStored.proposals[0].evidenceMessageIds[0], correction.id);
      assert(String(correctionStored.proposals[0].fact?.value).includes("3211"), "correction must carry the new value");

      memories = (await request("GET", `/api/agents/${agent.id}/memory`)).json.memories;
      assertEqual(memories.length, 1);
      assertEqual(memories[0].slug, slug);
      detail = (await request("GET", `/api/agents/${agent.id}/memory/${slug}`)).json.memory;
      assert(detail.content.includes("3211"), "same Memory must contain corrected value");
      const sourceIds = new Set(detail.sources.map((source) => source.messageId));
      assert(sourceIds.has(durable.id) && sourceIds.has(repeated.id) && sourceIds.has(correction.id), "durable, repeated and correction sources must remain traceable");
      for (const negativeId of negativeIds) assert(!sourceIds.has(negativeId), "negative source must stay excluded after later jobs");
    } finally {
      if (gateway) await gateway.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
