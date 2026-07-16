// First-party Vera Memory MCP dispatcher. Network transport and authentication
// are intentionally separate: callers must provide a trusted gateway context
// whose agentId and SourceRefs were bound outside tool arguments.

import { randomUUID } from "node:crypto";
import { ApiError } from "../core/errors.js";

const TOOL_SPECS = [
  tool("memory_list", "List the current Agent's Memory summaries.", {
    status: { type: "string", enum: ["active", "archived"] },
    type: { type: "string" },
  }),
  tool("memory_search", "Search the current Agent's Memory with a bounded semantic projection budget.", {
    query: { type: "string" },
    tokenBudget: { type: "integer" },
  }, ["query"]),
  tool("memory_fetch_more", "Continue one frozen Memory search snapshot in a returned direction.", {
    cursor: { type: "string" },
    direction: { type: "string" },
    tokenBudget: { type: "integer" },
  }, ["cursor", "direction"]),
  tool("memory_fetch_detail", "Read one authoritative Memory and one-hop links. Never interpret, quote, or reason from stain hex values.", {
    slug: { type: "string" },
  }, ["slug"]),
  tool("memory_create", "Create one sourced Memory for the current Agent.", {
    slug: { type: "string" },
    type: { type: "string" },
    description: { type: "string" },
    content: { type: "string" },
    stains: { type: "object", additionalProperties: { type: "string" } },
  }, ["slug", "type", "description", "content"]),
  tool("memory_update", "Update one Memory using its opaque version.", {
    slug: { type: "string" },
    ifMatch: { type: "string" },
    type: { type: "string" },
    description: { type: "string" },
    content: { type: "string" },
    stains: { type: "object", additionalProperties: { type: "string" } },
  }, ["slug", "ifMatch"]),
  tool("memory_archive", "Archive one Memory using its opaque version.", {
    slug: { type: "string" },
    ifMatch: { type: "string" },
  }, ["slug", "ifMatch"]),
  tool("memory_digest", "Create an asynchronous digest job from saved Messages.", {
    fromMessageId: { type: "string" },
    toMessageId: { type: "string" },
    mode: { type: "string", enum: ["incremental", "range"] },
  }, ["mode"]),
];

const SPEC_BY_NAME = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]));

function tool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

function invalid(message) {
  return new ApiError("invalid_request", message);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be an object`);
  return value;
}

function validateArguments(name, args) {
  const spec = SPEC_BY_NAME.get(name);
  if (!spec) throw invalid(`unknown Memory MCP tool: ${name}`);
  const value = requireObject(args ?? {}, "tool arguments");
  const allowed = new Set(Object.keys(spec.inputSchema.properties));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalid(`unknown ${name} argument: ${key}`);
  }
  for (const key of spec.inputSchema.required) {
    if (value[key] === undefined || value[key] === null || value[key] === "") throw invalid(`${name}.${key} is required`);
  }
  return value;
}

function requireContext(context, { sources = false } = {}) {
  const value = requireObject(context, "trusted Memory MCP context");
  if (typeof value.agentId !== "string" || !value.agentId) throw invalid("trusted Memory MCP context requires agentId");
  if (sources && (
    !Array.isArray(value.sourceRefs) ||
    value.sourceRefs.length === 0 ||
    !value.sourceRefs.every((source) => source?.kind === "message")
  )) {
    throw invalid("memory_create requires trusted Message SourceRefs");
  }
  return value;
}

function operation(context, kind, fields) {
  return {
    operationId: `mop_${randomUUID()}`,
    agentId: context.agentId,
    origin: "agent-mcp",
    kind,
    requestedAt: new Date().toISOString(),
    ...fields,
  };
}

function toolResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolError(error) {
  const message = error instanceof ApiError ? error.message : "Memory MCP tool failed";
  const code = error instanceof ApiError ? error.code : "memory_retrieval_unavailable";
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    structuredContent: { error: {
      code,
      message,
      retryable: ["memory_cursor_expired", "memory_retrieval_unavailable"].includes(code),
      details: {},
    } },
  };
}

export function createMemoryMcpDispatcher({ memory, retrieval, digestService = null }) {
  if (!memory) throw new Error("createMemoryMcpDispatcher requires memory");

  async function callTool({ context, name, arguments: rawArguments }) {
    try {
      const args = validateArguments(name, rawArguments);
      const trusted = requireContext(context, { sources: name === "memory_create" });
      if (["memory_search", "memory_fetch_more", "memory_fetch_detail"].includes(name)) {
        if (typeof trusted.agentSessionId !== "string" || !trusted.agentSessionId ||
            !Number.isInteger(trusted.generation) || trusted.generation < 1) {
          throw invalid(`${name} requires trusted agentSessionId and generation`);
        }
        if (!retrieval) throw new ApiError("memory_retrieval_unavailable", "Memory retrieval is unavailable");
      }

      if (name === "memory_list") {
        const result = await memory.listWithDiagnostics(trusted.agentId);
        const memories = result.memories.filter((item) =>
          (args.status === undefined || item.status === args.status) &&
          (args.type === undefined || item.type === args.type));
        return toolResult({ memories, errors: result.errors, index: result.index });
      }
      if (name === "memory_search") {
        return toolResult(await retrieval.search({
          context: trusted,
          query: args.query,
          tokenBudget: args.tokenBudget,
          kind: "search_returned",
        }));
      }
      if (name === "memory_fetch_more") {
        return toolResult(await retrieval.fetchMore({
          context: trusted,
          cursor: args.cursor,
          direction: args.direction,
          tokenBudget: args.tokenBudget,
        }));
      }
      if (name === "memory_fetch_detail") {
        return toolResult(await retrieval.fetchDetail({ context: trusted, slug: args.slug }));
      }
      if (name === "memory_create") {
        const { slug, ...value } = args;
        value.sources = trusted.sourceRefs;
        const created = await memory.applyOperation(operation(trusted, "create", { slug, value }));
        return toolResult({ memory: created });
      }
      if (name === "memory_update") {
        const { slug, ifMatch, ...patch } = args;
        const updated = await memory.applyOperation(operation(trusted, "update", { slug, ifMatch, patch }));
        return toolResult({ memory: updated });
      }
      if (name === "memory_archive") {
        const archived = await memory.applyOperation(operation(trusted, "archive", {
          slug: args.slug,
          ifMatch: args.ifMatch,
          patch: {},
        }));
        return toolResult({ memory: archived });
      }
      if (name === "memory_digest") {
        if (!digestService) throw new ApiError("adapter_unavailable", "Memory digest service is unavailable");
        if (typeof trusted.spaceId !== "string" || !trusted.spaceId) {
          throw invalid("trusted Memory MCP context requires spaceId for memory_digest");
        }
        if (typeof trusted.spaceSessionId !== "string" || !trusted.spaceSessionId) {
          throw invalid("trusted Memory MCP context requires spaceSessionId for memory_digest");
        }
        if (args.mode === "range" && (!args.fromMessageId || !args.toMessageId)) {
          throw invalid("memory_digest range mode requires fromMessageId and toMessageId");
        }
        const toMessageId = args.toMessageId ?? trusted.triggerMessageId;
        if (!toMessageId) throw invalid("memory_digest requires toMessageId or trusted triggerMessageId");
        const job = await digestService.enqueue({
          agentId: trusted.agentId,
          spaceId: trusted.spaceId,
          spaceSessionId: trusted.spaceSessionId,
          mode: args.mode,
          trigger: "manual",
          fromMessageId: args.fromMessageId,
          toMessageId,
        });
        return toolResult({ job });
      }
      throw invalid(`unknown Memory MCP tool: ${name}`);
    } catch (error) {
      return toolError(error);
    }
  }

  async function handleRpc({ context, request }) {
    const message = requireObject(request, "JSON-RPC request");
    const id = message.id ?? null;
    if (message.method === "initialize") {
      return { jsonrpc: "2.0", id, result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "vera-memory", version: "0.0.1" },
      } };
    }
    if (message.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOL_SPECS } };
    if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (message.method === "tools/call") {
      const params = requireObject(message.params, "tools/call params");
      return { jsonrpc: "2.0", id, result: await callTool({
        context,
        name: params.name,
        arguments: params.arguments,
      }) };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
  }

  return { listTools: () => TOOL_SPECS, callTool, handleRpc };
}
