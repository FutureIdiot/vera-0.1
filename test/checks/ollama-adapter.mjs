// Native Ollama adapter temporary-gateway black-box fixture.

import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHttpClient, startGateway } from "./_helpers.mjs";

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
    const ollama = await startOllamaStub();
    let gateway;
    try {
      gateway = await startGateway({
        repoRoot,
        env: {
          VERA_DATA_PATH: join(dir, "data"),
          VERA_MEMORY_VAULT_PATH: join(dir, "memory"),
          VERA_OLLAMA_WATCHDOG_MS: "5000",
          VERA_OLLAMA_MEMORY_DIGEST_TIMEOUT_MS: "5000",
        },
      });
      const request = createHttpClient(gateway.port);
      const created = await request("POST", "/api/agents", {
        name: "Ollama black-box",
        kind: "api",
        provider: "ollama",
        connection: { baseUrl: ollama.baseUrl, secretRef: null },
        model: "gemma4:e4b",
      });
      assertEqual(created.status, 201);
      const { agent, account } = created.json;
      assertEqual(account.provider, "ollama");
      const madeSpace = await request("POST", "/api/spaces", {
        name: "Ollama black-box",
        seats: [{ agentId: agent.id, responseMode: "default" }],
      });
      const space = madeSpace.json.space;
      const posted = await request("POST", `/api/spaces/${space.id}/messages`, {
        author: { type: "user" }, target: { type: "broadcast" }, content: "raw gateway question",
      });
      const userMessage = posted.json.message;

      let reply;
      for (let attempt = 0; attempt < 100 && !reply; attempt += 1) {
        const timeline = await request("GET", `/api/spaces/${space.id}/timeline?limit=20`);
        reply = timeline.json.items.find((item) => item.itemType === "message"
          && item.author?.type === "agent" && item.status === "completed");
        if (!reply) await sleep(25);
      }
      assertEqual(reply?.content, "OLLAMA_GATEWAY_STUB_OK");

      const queued = await request("POST", `/api/agents/${agent.id}/memory/_digest`, {
        spaceId: space.id, mode: "range", fromMessageId: userMessage.id, toMessageId: reply.id,
      });
      let job = queued.json.job;
      for (let attempt = 0; attempt < 100 && !["succeeded", "failed", "cancelled"].includes(job.status); attempt += 1) {
        await sleep(25);
        job = (await request("GET", `/api/agents/${agent.id}/memory/_digest-jobs/${job.id}`)).json.job;
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
      const states = JSON.parse(await readFile(join(dir, "data", "session-states.json"), "utf8"));
      const state = states[`${account.id}:${space.id}`];
      assertEqual(state.schemaVersion, 1);
      assertEqual(state.history[0].content, "raw gateway question");
      assertEqual(state.history[1].content, "OLLAMA_GATEWAY_STUB_OK");
      assertEqual("externalSessionId" in state, false);
    } finally {
      if (gateway) await gateway.stop();
      await ollama.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
