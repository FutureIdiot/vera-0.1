import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createOllamaAdapter, projectOllamaDigestSchema } from "../../src/adapters/ollama-adapter.js";
import { MEMORY_DIGEST_OUTPUT_JSON_SCHEMA, validateDigestProposals } from "../../src/memory/memory-proposals.js";

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function startStub(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method, url: req.url, body });
    await handler({ req, res, body, index: requests.length - 1 });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

function account(baseUrl, overrides = {}) {
  return {
    id: "acc_ollama",
    kind: "api",
    provider: "ollama",
    connection: { baseUrl, secretRef: null },
    model: "gemma4:e4b",
    ...overrides,
  };
}

function makeCtx(baseUrl, overrides = {}) {
  const deltas = [];
  const activities = [];
  const controller = new AbortController();
  return {
    ctx: {
      agent: { id: "agt_ollama", name: "Gemma" },
      account: account(baseUrl),
      prompt: {
        apiMessages: [
          { role: "system", content: "INDEX" },
          { role: "user", content: "GROUP\n\nquestion" },
        ],
      },
      sessionMode: "main",
      onDelta: (value) => deltas.push(value),
      onActivity: (value) => activities.push(value),
      signal: controller.signal,
      ...overrides,
    },
    deltas,
    activities,
    controller,
  };
}

function digestInput(baseUrl, overrides = {}) {
  const input = {
    account: account(baseUrl),
    payload: {
      agent: { id: "agt_ollama", name: "Gemma" },
      chunks: [{ id: "dch_1", messages: [{ messageId: "msg_1", content: "Vera test port is 3210." }] }],
      facts: [],
      proposalSchema: MEMORY_DIGEST_OUTPUT_JSON_SCHEMA,
    },
    signal: new AbortController().signal,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "taskModel")) input.taskModel = input.account.model;
  return input;
}

function schemaHasKey(value, forbidden) {
  if (!value || typeof value !== "object") return false;
  if (Object.keys(value).some((key) => forbidden.has(key))) return true;
  return Object.values(value).some((child) => schemaHasKey(child, forbidden));
}

test("transport schema keeps proposal structure without Ollama 0.23.2 crash keywords", () => {
  const schema = projectOllamaDigestSchema(MEMORY_DIGEST_OUTPUT_JSON_SCHEMA);
  assert.equal(schemaHasKey(schema, new Set(["oneOf", "patternProperties", "pattern", "const"])), false);
  assert.deepEqual(schema.properties.proposals.items.properties.action.enum.sort(),
    ["archive", "create", "skip", "supersede", "update"]);
  assert.deepEqual(schema.properties.proposals.items.required, [
    "action", "evidenceMessageIds", "targetFactId", "targetMemorySlug",
    "suggestedSlug", "fact", "type", "description", "content", "skipReason",
  ]);
  assert.equal(schema.properties.proposals.items.properties.evidenceMessageIds.minItems, 1);
  assert.ok(schema.properties.proposals.items.properties.fact.properties.value);
  assert.ok(schema.properties.proposals.items.properties.targetFactId);
});

test("kind/provider, model, base URL and secret mismatch fail before HTTP", async () => {
  const adapter = createOllamaAdapter({ config: {} });
  const badAccounts = [
    account("http://127.0.0.1:9", { kind: "cli" }),
    account("http://127.0.0.1:9", { provider: "opencode" }),
    account("http://127.0.0.1:9", { model: "" }),
    account("http://public.example", {}),
    account("http://127.0.0.1:9", { connection: { baseUrl: "http://127.0.0.1:9", secretRef: "key" } }),
  ];
  for (const bad of badAccounts) {
    const { ctx } = makeCtx("http://127.0.0.1:9", { account: bad });
    await assert.rejects(() => adapter.run(ctx), (error) => error.code === "unavailable");
  }
  await assert.rejects(
    () => adapter.digestMemory(digestInput("http://127.0.0.1:9", { account: badAccounts[0] })),
    (error) => error.code === "executor_unavailable",
  );
});

test("chat streams fragmented NDJSON and sends only gateway-compiled API messages", async (t) => {
  const stub = await startStub(t, async ({ res, body, index }) => {
    assert.equal(body.stream, true);
    assert.equal(body.think, false);
    assert.equal(body.model, "gemma4:e4b");
    assert.equal(body.options.num_ctx, 16384);
    assert.equal(body.tools, undefined);
    const answer = index === 0 ? ["你好", "，世界"] : ["续轮"];
    const wire = `${answer.map((content) => JSON.stringify({ message: { content }, done: false })).join("\r\n")}\r\n${JSON.stringify({ message: { content: "" }, done: true })}`;
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write(wire.slice(0, 11));
    res.end(wire.slice(11));
  });
  const adapter = createOllamaAdapter({ config: {} });
  const first = makeCtx(stub.baseUrl);
  const firstResult = await adapter.run(first.ctx);
  assert.deepEqual(firstResult, { content: "你好，世界" });
  assert.equal("sessionState" in firstResult, false);
  assert.equal("providerBinding" in firstResult, false);
  assert.deepEqual(first.deltas, ["你好", "，世界"]);
  assert.deepEqual(stub.requests[0].body.messages, [
    { role: "system", content: "INDEX" },
    { role: "user", content: "GROUP\n\nquestion" },
  ]);
  const second = makeCtx(stub.baseUrl, {
    prompt: {
      apiMessages: [
        { role: "system", content: "INDEX" },
        { role: "user", content: "question" },
        { role: "assistant", content: "你好，世界" },
        { role: "user", content: "NEW GROUP\n\nsecond\n\nRETRIEVAL" },
      ],
    },
  });
  const secondResult = await adapter.run(second.ctx);
  assert.deepEqual(stub.requests[1].body.messages, [
    { role: "system", content: "INDEX" },
    { role: "user", content: "question" },
    { role: "assistant", content: "你好，世界" },
    { role: "user", content: "NEW GROUP\n\nsecond\n\nRETRIEVAL" },
  ]);
  assert.equal(JSON.stringify(stub.requests[1].body.messages).includes("GROUP\n\nquestion"), false);
  assert.deepEqual(secondResult, { content: "续轮" });
});

test("API messages are one-shot, legacy context fields are ignored, and oversized input never fetches", async (t) => {
  const stub = await startStub(t, async ({ res }) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.end(`${JSON.stringify({ message: { content: "ok" }, done: false })}\n${JSON.stringify({ done: true, message: { content: "" } })}\n`);
  });
  const adapter = createOllamaAdapter({ config: { maxInputBytes: 18 } });
  const oneShot = makeCtx(stub.baseUrl, {
    sessionMode: "isolated",
    prompt: {
      apiMessages: [{ role: "user", content: "new2" }],
      text: "must-not-be-used",
      turnText: "must-not-be-used",
      historyUserText: "must-not-be-used",
      residentBlock: "must-not-be-used",
    },
    providerBinding: { version: 1, providerState: { history: [] } },
    rotateProviderBinding: () => { throw new Error("API adapter must not rotate CLI bindings"); },
    persistProviderBinding: () => { throw new Error("API adapter must not persist CLI bindings"); },
  });
  const oneShotResult = await adapter.run(oneShot.ctx);
  assert.deepEqual(oneShotResult, { content: "ok" });
  assert.deepEqual(oneShot.activities, []);
  assert.deepEqual(stub.requests[0].body.messages, [
    { role: "user", content: "new2" },
  ]);

  const oversized = makeCtx(stub.baseUrl, {
    prompt: { apiMessages: [{ role: "user", content: "x".repeat(19) }] },
  });
  await assert.rejects(() => adapter.run(oversized.ctx), (error) => error.code === "provider_error");
  const invalidMessages = makeCtx(stub.baseUrl, { prompt: { text: "legacy-only" } });
  await assert.rejects(() => adapter.run(invalidMessages.ctx), (error) => error.code === "provider_error");
  assert.equal(stub.requests.length, 1);
});

test("ordinary Ollama provider errors do not invoke any binding callback", async (t) => {
  const stub = await startStub(t, async ({ res }) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "ordinary failure" }));
  });
  const adapter = createOllamaAdapter({ config: {} });
  const input = makeCtx(stub.baseUrl, {
    rotateProviderBinding: () => { throw new Error("API adapter must not rotate CLI bindings"); },
    persistProviderBinding: () => { throw new Error("API adapter must not persist CLI bindings"); },
  });
  await assert.rejects(() => adapter.run(input.ctx), (error) => error.code === "provider_error");
});

test("chat abort, timeout, provider errors and shutdown expose stable codes", async (t) => {
  const stub = await startStub(t, async () => new Promise(() => {}));
  const abortAdapter = createOllamaAdapter({ config: { watchdogMs: 1000 } });
  const aborted = makeCtx(stub.baseUrl);
  const pending = abortAdapter.run(aborted.ctx);
  while (stub.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  aborted.controller.abort();
  await assert.rejects(pending, (error) => error.code === "cancelled" && !error.message.includes(stub.baseUrl));

  const timeoutAdapter = createOllamaAdapter({ config: { watchdogMs: 20 } });
  await assert.rejects(() => timeoutAdapter.run(makeCtx(stub.baseUrl).ctx), (error) => error.code === "timed_out");
  await timeoutAdapter.shutdown();
  await timeoutAdapter.shutdown();
  await assert.rejects(() => timeoutAdapter.run(makeCtx(stub.baseUrl).ctx), (error) => error.code === "unavailable");
});

test("digest is isolated, schema-projected, parsed, and accepted by the full gateway validator", async (t) => {
  const proposal = {
    action: "create", evidenceMessageIds: ["msg_1"],
    targetFactId: "", targetMemorySlug: "",
    fact: { subject: "Vera", relation: "test port", qualifiers: [], value: "3210" },
    suggestedSlug: "vera-test-port", type: "rule",
    description: "Vera uses test port 3210", content: "Use port 3210 for Vera tests.",
    skipReason: "no_reusable_fact",
  };
  const stub = await startStub(t, async ({ res, body }) => {
    assert.equal(body.stream, false);
    assert.equal(body.think, false);
    assert.equal(body.tools, undefined);
    assert.equal(body.options.temperature, 0);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[1].content.includes("proposalSchema"), false);
    assert.equal(schemaHasKey(body.format, new Set(["oneOf", "patternProperties", "pattern", "const"])), false);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: { content: JSON.stringify({ proposals: [proposal] }) }, done: true }));
  });
  const adapter = createOllamaAdapter({ config: {} });
  const input = digestInput(stub.baseUrl);
  const before = JSON.stringify(input.payload);
  const result = await adapter.digestMemory(input);
  assert.equal(JSON.stringify(input.payload), before, "adapter must not mutate the frozen digest payload");
  assert.deepEqual(result.proposals, [{
    action: "create", evidenceMessageIds: ["msg_1"],
    fact: { subject: "Vera", relation: "test port", qualifiers: [], value: "3210" },
    suggestedSlug: "vera-test-port", type: "rule",
    description: "Vera uses test port 3210", content: "Use port 3210 for Vera tests.",
  }]);
  assert.deepEqual(result.execution, {
    adapter: "ollama", primaryModel: "gemma4:e4b", effectiveModel: "gemma4:e4b",
    fallbackUsed: false, fallbackReason: null, attempts: 1,
  });
  validateDigestProposals({
    proposals: result.proposals,
    messages: [{ id: "msg_1", spaceId: "spc_1", status: "completed", content: "Vera test port is 3210." }],
    agentId: "agt_ollama", spaceId: "spc_1", jobId: "mdj_1",
  });
});

test("opt-in real native Ollama Gemma chat and digest smoke", {
  skip: process.env.VERA_TEST_OLLAMA_NATIVE !== "1" ? "set VERA_TEST_OLLAMA_NATIVE=1 after starting Ollama" : false,
  timeout: 360_000,
}, async () => {
  const baseUrl = process.env.VERA_TEST_OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const model = process.env.VERA_TEST_OLLAMA_MODEL || "gemma4:e4b";
  const adapter = createOllamaAdapter({ config: { watchdogMs: 180_000, digestTimeoutMs: 300_000, numCtx: 16384, maxInputBytes: 12000 } });
  try {
    const chat = makeCtx(baseUrl, {
      account: account(baseUrl, { model }),
      prompt: { text: "只回复：OLLAMA_NATIVE_OK", turnText: "只回复：OLLAMA_NATIVE_OK", historyUserText: "只回复：OLLAMA_NATIVE_OK", residentBlock: null },
      signal: AbortSignal.timeout(180_000),
    });
    const chatResult = await adapter.run(chat.ctx);
    assert.ok(chatResult.content.trim());

    const input = digestInput(baseUrl, { account: account(baseUrl, { model }), signal: AbortSignal.timeout(300_000) });
    const result = await adapter.digestMemory(input);
    assert.equal(result.execution.adapter, "ollama");
    validateDigestProposals({
      proposals: result.proposals,
      messages: [{ id: "msg_1", spaceId: "spc_smoke", status: "completed", content: "Vera test port is 3210." }],
      agentId: "agt_ollama", spaceId: "spc_smoke", jobId: "mdj_smoke",
    });
  } finally {
    await adapter.shutdown();
  }
});
