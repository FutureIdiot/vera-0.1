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
  const persisted = [];
  const controller = new AbortController();
  return {
    ctx: {
      agent: { id: "agt_ollama", name: "Gemma" },
      account: account(baseUrl),
      prompt: {
        text: "INDEX\n\nGROUP\n\nquestion",
        turnText: "GROUP\n\nquestion",
        historyUserText: "question",
        residentBlock: "INDEX",
      },
      sessionState: null,
      onDelta: (value) => deltas.push(value),
      onActivity: (value) => activities.push(value),
      persistSessionState: (value) => persisted.push(value),
      signal: controller.signal,
      ...overrides,
    },
    deltas,
    activities,
    persisted,
    controller,
  };
}

function digestInput(baseUrl, overrides = {}) {
  return {
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

test("chat streams fragmented NDJSON and persists only stable user history", async (t) => {
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
  assert.equal(firstResult.content, "你好，世界");
  assert.deepEqual(first.deltas, ["你好", "，世界"]);
  assert.deepEqual(stub.requests[0].body.messages, [
    { role: "system", content: "INDEX" },
    { role: "user", content: "GROUP\n\nquestion" },
  ]);
  assert.deepEqual(firstResult.sessionState, {
    schemaVersion: 1,
    stablePrefix: "INDEX",
    history: [{ role: "user", content: "question" }, { role: "assistant", content: "你好，世界" }],
  });
  assert.deepEqual(first.persisted, [{ schemaVersion: 1, stablePrefix: "INDEX", history: [] }]);

  const second = makeCtx(stub.baseUrl, {
    prompt: { text: "NEW GROUP\n\nsecond", turnText: "NEW GROUP\n\nsecond", historyUserText: "second", residentBlock: "NEW INDEX" },
    sessionState: firstResult.sessionState,
  });
  await adapter.run(second.ctx);
  assert.deepEqual(stub.requests[1].body.messages.slice(0, 3), [
    { role: "system", content: "INDEX" },
    { role: "user", content: "question" },
    { role: "assistant", content: "你好，世界" },
  ]);
  assert.equal(JSON.stringify(stub.requests[1].body.messages).includes("GROUP\n\nquestion"), false);
});

test("invalid state resets, history prunes oldest pairs, and oversized current turn never fetches", async (t) => {
  const stub = await startStub(t, async ({ res }) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.end(`${JSON.stringify({ message: { content: "ok" }, done: false })}\n${JSON.stringify({ done: true, message: { content: "" } })}\n`);
  });
  const adapter = createOllamaAdapter({ config: { maxInputBytes: 18 } });
  const invalid = makeCtx(stub.baseUrl, {
    prompt: { text: "new", turnText: "new", historyUserText: "new", residentBlock: "fresh" },
    sessionState: { broken: true },
  });
  await adapter.run(invalid.ctx);
  assert.equal(invalid.activities[0].label, "session-reset");
  assert.equal(stub.requests[0].body.messages[0].content, "fresh");

  const pruned = makeCtx(stub.baseUrl, {
    prompt: { text: "new", turnText: "new", historyUserText: "new", residentBlock: "ignored" },
    sessionState: {
      schemaVersion: 1,
      stablePrefix: "fresh",
      history: [
        { role: "user", content: "old1" }, { role: "assistant", content: "old2" },
        { role: "user", content: "keep" }, { role: "assistant", content: "ok" },
      ],
    },
  });
  await adapter.run(pruned.ctx);
  assert.equal(JSON.stringify(stub.requests[1].body.messages).includes("old1"), false);
  assert.equal(JSON.stringify(stub.requests[1].body.messages).includes("keep"), true);

  const oversized = makeCtx(stub.baseUrl, {
    prompt: { text: "x".repeat(19), turnText: "x".repeat(19), historyUserText: "x", residentBlock: null },
  });
  await assert.rejects(() => adapter.run(oversized.ctx), (error) => error.code === "provider_error");
  assert.equal(stub.requests.length, 2);
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
