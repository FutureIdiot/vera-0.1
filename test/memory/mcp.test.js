import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMcpDispatcher } from "../../src/memory/mcp.js";
import { createMemoryVault } from "../../src/memory/memory.js";
import { createMemoryRetrievalService } from "../../src/memory/memory-retrieval.js";
import { createStore } from "../../src/store/store.js";

async function withMcp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "vera-memory-mcp-test-"));
  const message = { id: "msg_source01", spaceId: "spc_alpha", spaceSessionId: "sps_alpha" };
  const store = await createStore({ dataPath: join(dir, "data"), debounceMs: 5 });
  const memory = createMemoryVault({
    vaultPath: join(dir, "vault"),
    resolveSource: ({ messageId }) => messageId === message.id ? message : null,
  });
  const retrieval = createMemoryRetrievalService({ store, memory });
  const recall = await retrieval.ensureSession({ agentId: "agt_alpha", agentSessionId: "ags_alpha", generation: 1 });
  try {
    await fn({
      memory,
      retrieval,
      mcp: createMemoryMcpDispatcher({ memory, retrieval }),
      context: {
        agentId: "agt_alpha",
        agentSessionId: recall.agentSessionId,
        generation: recall.generation,
        spaceId: message.spaceId,
        spaceSessionId: message.spaceSessionId,
        sourceRefs: [{ kind: "message", spaceId: message.spaceId, messageId: message.id }],
      },
    });
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("Memory MCP schemas never let tool arguments select identity or sources", async () => {
  await withMcp(async ({ mcp }) => {
    const tools = mcp.listTools();
    assert.deepEqual(tools.map((item) => item.name), [
      "memory_list", "memory_search", "memory_fetch_more", "memory_fetch_detail",
      "memory_create", "memory_update", "memory_archive", "memory_digest",
    ]);
    for (const spec of tools) {
      const properties = spec.inputSchema.properties;
      for (const forbidden of ["agentId", "agentSessionId", "generation", "spaceSessionId", "scope", "origin", "sources", "sourceRefs"]) {
        assert.equal(forbidden in properties, false, `${spec.name} must not expose ${forbidden}`);
      }
      assert.equal(spec.inputSchema.additionalProperties, false);
    }
  });
});

test("MCP binds Digest to the trusted SpaceSession", async () => {
  await withMcp(async ({ memory, retrieval, context }) => {
    const calls = [];
    const mcp = createMemoryMcpDispatcher({
      memory,
      retrieval,
      digestService: { enqueue(input) { calls.push(input); return { id: "mdj_trusted" }; } },
    });
    const result = await mcp.callTool({
      context: { ...context, triggerMessageId: "msg_source01" },
      name: "memory_digest",
      arguments: { mode: "incremental" },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [{
      agentId: context.agentId,
      spaceId: context.spaceId,
      spaceSessionId: context.spaceSessionId,
      mode: "incremental",
      trigger: "manual",
      fromMessageId: undefined,
      toMessageId: "msg_source01",
    }]);
  });
});

test("trusted Agent context drives MCP create/list/fetch_detail/update/archive through one authority", async () => {
  await withMcp(async ({ mcp, retrieval, context }) => {
    const created = await mcp.callTool({
      context,
      name: "memory_create",
      arguments: {
        slug: "mcp-created",
        type: "decision",
        description: "created through MCP",
        content: "authoritative body",
        stains: { agt_beta: "#AABBCC" },
      },
    });
    assert.equal(created.isError, undefined);
    assert.match(created.structuredContent.memory.version, /^sha256:[0-9a-f]{64}$/);

    const listed = await mcp.callTool({ context, name: "memory_list", arguments: { status: "active" } });
    assert.deepEqual(listed.structuredContent.memories.map((item) => item.slug), ["mcp-created"]);

    const searched = await mcp.callTool({ context, name: "memory_search", arguments: { query: "authoritative body" } });
    assert.deepEqual(searched.structuredContent.nodes.map((item) => item.slug), ["mcp-created"]);

    const full = await mcp.callTool({ context, name: "memory_fetch_detail", arguments: { slug: "mcp-created" } });
    assert.equal(full.structuredContent.memory.content, "authoritative body");
    assert.deepEqual(full.structuredContent.memory.sources, context.sourceRefs);
    assert.equal(full.structuredContent.usageRecorded, true);
    const repeated = await mcp.callTool({ context, name: "memory_fetch_detail", arguments: { slug: "mcp-created" } });
    assert.equal(repeated.structuredContent.usageRecorded, false);
    assert.deepEqual(
      retrieval.listSignals().filter((item) => item.kind === "detail_opened")
        .map(({ agentId, slug, kind }) => ({ agentId, slug, kind })),
      [{ agentId: context.agentId, slug: "mcp-created", kind: "detail_opened" }],
    );
    assert.doesNotMatch(JSON.stringify(full), /stains|#AABBCC/u);

    const updated = await mcp.callTool({
      context,
      name: "memory_update",
      arguments: {
        slug: "mcp-created",
        ifMatch: full.structuredContent.memory.version,
        content: "updated through MCP",
      },
    });
    assert.equal(updated.structuredContent.memory.content, "updated through MCP");

    const archived = await mcp.callTool({
      context,
      name: "memory_archive",
      arguments: { slug: "mcp-created", ifMatch: updated.structuredContent.memory.version },
    });
    assert.equal(archived.structuredContent.memory.status, "archived");
  });
});

test("MCP rejects missing trusted sources and argument-level Agent impersonation without writes", async () => {
  await withMcp(async ({ mcp, context }) => {
    const noSources = await mcp.callTool({
      context: { agentId: context.agentId },
      name: "memory_create",
      arguments: { slug: "no-source", type: "decision", description: "bad", content: "bad" },
    });
    assert.equal(noSources.isError, true);
    assert.match(noSources.content[0].text, /SourceRefs/);

    const manualSource = await mcp.callTool({
      context: {
        agentId: context.agentId,
        sourceRefs: [{ kind: "manual", actor: "legacy", capturedAt: "2026-07-13T00:00:00.000Z" }],
      },
      name: "memory_create",
      arguments: { slug: "manual-source", type: "decision", description: "bad", content: "bad" },
    });
    assert.equal(manualSource.isError, true);
    assert.match(manualSource.content[0].text, /Message SourceRefs/);

    const impersonation = await mcp.callTool({
      context,
      name: "memory_create",
      arguments: {
        agentId: "agt_beta",
        slug: "impersonated",
        type: "decision",
        description: "bad",
        content: "bad",
      },
    });
    assert.equal(impersonation.isError, true);
    assert.match(impersonation.content[0].text, /unknown memory_create argument: agentId/);

    const alpha = await mcp.callTool({ context, name: "memory_list", arguments: {} });
    const beta = await mcp.callTool({ context: { agentId: "agt_beta" }, name: "memory_list", arguments: {} });
    assert.deepEqual(alpha.structuredContent.memories, []);
    assert.deepEqual(beta.structuredContent.memories, []);
  });
});

test("JSON-RPC dispatcher exposes standard MCP tool results without network identity fallback", async () => {
  await withMcp(async ({ mcp, context }) => {
    const initialized = await mcp.handleRpc({ context, request: { jsonrpc: "2.0", id: 1, method: "initialize" } });
    assert.equal(initialized.result.serverInfo.name, "vera-memory");

    const tools = await mcp.handleRpc({ context, request: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    assert.equal(tools.result.tools.length, 8);

    const failed = await mcp.handleRpc({
      context: null,
      request: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_list", arguments: {} } },
    });
    assert.equal(failed.result.isError, true);
    assert.match(failed.result.content[0].text, /trusted Memory MCP context/);
  });
});
