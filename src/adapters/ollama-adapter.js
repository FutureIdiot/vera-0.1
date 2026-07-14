// Native Ollama HTTP adapter (implemented against Ollama 0.23.2 / gemma4:e4b).
//
// - accepts only Account kind=api, provider=ollama; baseUrl/model are Account data;
// - session continuity is a JSON-serializable { history } array owned by the Account;
// - /api/chat NDJSON message.content maps one-for-one to onDelta; no tool Activity;
// - digestMemory uses an isolated non-streaming request and a provider-compatible
//   projection of Vera's authoritative proposal schema; gateway validation remains final;
// - num_ctx/input capacity, abort, timeout and shutdown are explicit and test-covered;
// - no provider fallback, Workspace access, store access or secret resolution.

import { AdapterError } from "../core/errors.js";
import {
  buildMemoryDigestPrompt,
  MEMORY_DIGEST_SYSTEM_PROMPT,
  parseMemoryDigestEnvelope,
} from "../memory/memory-digest-prompt.js";

const ACTION_FALLBACK = ["create", "update", "archive", "supersede", "skip"];
const SKIP_FALLBACK = ["no_reusable_fact", "unsupported_inference", "ambiguous_match", "duplicate_in_job"];
const OLLAMA_DIGEST_SYSTEM_PROMPT = `${MEMORY_DIGEST_SYSTEM_PROMPT}
Ollama's compatible transport schema uses one flat shape for every action. Fill action-irrelevant string fields with an empty string; they are removed deterministically before Vera's full proposal validator runs.
For update, supersede, or archive, choose exactly one transport target. If the matching catalog entry has a non-empty factId, copy it to targetFactId and set targetMemorySlug to an empty string. Only when the matching catalog entry is unmapped with factId=null may you copy its slug to targetMemorySlug and set targetFactId to an empty string. Never fill both target fields.`;

function inputByteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function collectSchemaValues(node, key, values = new Set()) {
  if (!node || typeof node !== "object") return values;
  if (node.properties?.[key]?.const !== undefined) values.add(node.properties[key].const);
  for (const value of node.properties?.[key]?.enum ?? []) values.add(value);
  for (const child of Object.values(node)) collectSchemaValues(child, key, values);
  return values;
}

// Ollama 0.23.2 can crash while compiling Vera's oneOf/patternProperties/pattern
// combinations. Keep only basic structure here; the full gateway validator is authoritative.
export function projectOllamaDigestSchema(source) {
  if (!source || typeof source !== "object" || source.type !== "object" || !source.properties?.proposals) {
    throw new AdapterError("executor_unavailable", "Ollama memory digest schema is unavailable");
  }
  const actions = [...collectSchemaValues(source, "action")];
  const skipReasons = [...collectSchemaValues(source, "skipReason")];
  return {
    type: "object",
    additionalProperties: false,
    required: ["proposals"],
    properties: {
      proposals: {
        type: "array",
        maxItems: Number(source.properties.proposals.maxItems) || 32,
        items: {
          type: "object",
          additionalProperties: false,
          // Ollama 0.23.2 cannot express Vera's action-specific oneOf safely.
          // Requiring sourced evidence for every transport item is a valid,
          // stricter subset (skip also accepts evidence) and prevents the local
          // model from emitting structurally unauditable write proposals.
          required: [
            "action", "evidenceMessageIds", "targetFactId", "targetMemorySlug",
            "suggestedSlug", "fact", "type", "description", "content", "skipReason",
          ],
          properties: {
            action: { type: "string", enum: actions.length ? actions : ACTION_FALLBACK },
            evidenceMessageIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
            targetFactId: { type: "string" },
            targetMemorySlug: { type: "string" },
            suggestedSlug: { type: "string" },
            fact: {
              type: "object",
              additionalProperties: false,
              required: ["subject", "relation", "qualifiers", "value"],
              properties: {
                subject: { type: "string" },
                relation: { type: "string" },
                qualifiers: { type: "array", items: { type: "string" } },
                value: { type: "string" },
              },
            },
            type: { type: "string" },
            description: { type: "string" },
            content: { type: "string" },
            stains: { type: "object" },
            skipReason: { type: "string", enum: skipReasons.length ? skipReasons : SKIP_FALLBACK },
          },
        },
      },
    },
  };
}

function normalizeOllamaDigestProposals(proposals) {
  if (!Array.isArray(proposals)) return proposals;
  return proposals.map((proposal) => {
    if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return proposal;
    const base = {
      action: proposal.action,
      evidenceMessageIds: proposal.evidenceMessageIds,
    };
    if (proposal.action === "skip") return { ...base, skipReason: proposal.skipReason };
    const target = {
      ...(typeof proposal.targetFactId === "string" && proposal.targetFactId ? { targetFactId: proposal.targetFactId } : {}),
      ...(typeof proposal.targetMemorySlug === "string" && proposal.targetMemorySlug ? { targetMemorySlug: proposal.targetMemorySlug } : {}),
    };
    if (proposal.action === "archive") return { ...base, ...target };
    return {
      ...base,
      ...target,
      fact: proposal.fact,
      ...(proposal.action === "create" ? { suggestedSlug: proposal.suggestedSlug } : {}),
      type: proposal.type,
      description: proposal.description,
      content: proposal.content,
      ...(proposal.stains === undefined ? {} : { stains: proposal.stains }),
    };
  });
}

function resolveAccount(account) {
  if (account?.kind !== "api" || account?.provider !== "ollama") {
    throw new AdapterError("unavailable", "Ollama adapter Account kind/provider mismatch");
  }
  const model = String(account.model ?? "").trim();
  if (!model) throw new AdapterError("unavailable", "Ollama Account model is unavailable");
  if (account.connection?.secretRef != null) {
    throw new AdapterError("unavailable", "Ollama Account secret resolution is unavailable");
  }
  let url;
  try {
    url = new URL(String(account.connection?.baseUrl ?? ""));
  } catch {
    throw new AdapterError("unavailable", "Ollama Account base URL is unavailable");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash) {
    throw new AdapterError("unavailable", "Ollama Account base URL is not allowed");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new AdapterError("unavailable", "Ollama Account base URL is not allowed");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return { baseUrl: url.toString().replace(/\/$/u, ""), model };
}

function validSessionState(value) {
  if (!value || value.schemaVersion !== 1 || (value.stablePrefix !== null && typeof value.stablePrefix !== "string")) return false;
  if (!Array.isArray(value.history) || value.history.length % 2 !== 0) return false;
  return value.history.every((message, index) => {
    const role = index % 2 === 0 ? "user" : "assistant";
    return message && typeof message === "object" && message.role === role && typeof message.content === "string";
  });
}

function trimHistory(history, stablePrefix, turnText, maxInputBytes) {
  const currentBytes = inputByteLength(stablePrefix) + inputByteLength(turnText);
  if (currentBytes > maxInputBytes) throw new AdapterError("provider_error", "Ollama current prompt exceeds the configured input capacity");
  const next = history.map(({ role, content }) => ({ role, content }));
  let total = currentBytes + next.reduce((sum, message) => sum + inputByteLength(message.content), 0);
  while (total > maxInputBytes && next.length >= 2) {
    total -= inputByteLength(next[0].content) + inputByteLength(next[1].content);
    next.splice(0, 2);
  }
  return next;
}

function requestControl(externalSignal, timeoutMs, shutdownSignal) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  timer.unref?.();
  const signals = [timeout.signal, shutdownSignal];
  if (externalSignal) signals.push(externalSignal);
  return {
    signal: AbortSignal.any(signals),
    timedOut: () => timeout.signal.aborted,
    clear: () => clearTimeout(timer),
  };
}

async function parseJsonResponse(response) {
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error("invalid_json");
  }
  if (value?.error) throw new Error("provider_error");
  return value;
}

export function createOllamaAdapter({ config }) {
  const {
    watchdogMs = 30 * 60 * 1000,
    digestTimeoutMs = 5 * 60 * 1000,
    numCtx = 16384,
    maxInputBytes = 12000,
  } = config ?? {};
  const shutdownController = new AbortController();

  function assertOpen(code) {
    if (shutdownController.signal.aborted) throw new AdapterError(code, "Ollama adapter is shut down");
  }

  async function run(ctx) {
    assertOpen("unavailable");
    const { baseUrl, model } = resolveAccount(ctx.account);
    if (ctx.signal?.aborted) throw new AdapterError("cancelled", "Ollama run cancelled");
    const turnText = String(ctx.prompt?.turnText ?? ctx.prompt?.text ?? "");
    const stateValid = ctx.sessionState == null || validSessionState(ctx.sessionState);
    const stablePrefix = stateValid && ctx.sessionState
      ? ctx.sessionState.stablePrefix
      : (typeof ctx.prompt?.residentBlock === "string" ? ctx.prompt.residentBlock : null);
    let history = stateValid && ctx.sessionState ? ctx.sessionState.history : [];
    if (!stateValid) {
      ctx.onActivity?.({ phase: "error", label: "session-reset", detail: "Ollama history state was invalid and has been reset" });
    }
    history = trimHistory(history, stablePrefix, turnText, maxInputBytes);
    const persistedBeforeRun = { schemaVersion: 1, stablePrefix, history };
    await ctx.persistSessionState?.(persistedBeforeRun);

    const control = requestControl(ctx.signal, watchdogMs, shutdownController.signal);
    let response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson" },
        body: JSON.stringify({
          model,
          stream: true,
          think: false,
          messages: [
            ...(stablePrefix ? [{ role: "system", content: stablePrefix }] : []),
            ...history,
            { role: "user", content: turnText },
          ],
          options: { num_ctx: numCtx },
        }),
        signal: control.signal,
      });
      if (!response.ok || !response.body) throw new Error("provider_error");
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let done = false;
      const consume = (line) => {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch { throw new Error("invalid_json"); }
        if (event?.error) throw new Error("provider_error");
        if (Array.isArray(event?.message?.tool_calls) && event.message.tool_calls.length) throw new Error("provider_error");
        const delta = event?.message?.content;
        if (typeof delta === "string" && delta) {
          content += delta;
          ctx.onDelta?.(delta);
        }
        if (event?.done === true) done = true;
      };
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          consume(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      }
      buffer += decoder.decode();
      consume(buffer);
      if (!done || !content) throw new Error("incomplete_stream");
      const historyUserText = typeof ctx.prompt?.historyUserText === "string" && ctx.prompt.historyUserText
        ? ctx.prompt.historyUserText
        : null;
      const sessionState = {
        schemaVersion: 1,
        stablePrefix,
        history: historyUserText
          ? [...history, { role: "user", content: historyUserText }, { role: "assistant", content }]
          : history,
      };
      return { content, sessionState };
    } catch (error) {
      if (ctx.signal?.aborted) throw new AdapterError("cancelled", "Ollama run cancelled");
      if (control.timedOut()) throw new AdapterError("timed_out", "Ollama run timed out");
      if (shutdownController.signal.aborted) throw new AdapterError("cancelled", "Ollama run cancelled during shutdown");
      if (!response) throw new AdapterError("unavailable", "Ollama service is unavailable");
      throw new AdapterError("provider_error", "Ollama provider request failed");
    } finally {
      control.clear();
    }
  }

  async function digestMemory({ account, payload, signal }) {
    assertOpen("executor_unavailable");
    let resolved;
    try { resolved = resolveAccount(account); } catch { throw new AdapterError("executor_unavailable", "Ollama memory digest executor is unavailable"); }
    if (signal?.aborted) throw new AdapterError("cancelled", "Ollama memory digest cancelled");
    const prompt = buildMemoryDigestPrompt(payload);
    if (inputByteLength(OLLAMA_DIGEST_SYSTEM_PROMPT) + inputByteLength(prompt) > maxInputBytes) {
      throw new AdapterError("executor_failed", "Ollama memory digest input exceeds the configured capacity");
    }
    const format = projectOllamaDigestSchema(payload?.proposalSchema);
    const control = requestControl(signal, digestTimeoutMs, shutdownController.signal);
    let response;
    try {
      response = await fetch(`${resolved.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          model: resolved.model,
          stream: false,
          think: false,
          messages: [
            { role: "system", content: OLLAMA_DIGEST_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          format,
          options: { num_ctx: numCtx, temperature: 0 },
        }),
        signal: control.signal,
      });
      if (!response.ok) throw new Error("provider_error");
      const body = await parseJsonResponse(response);
      if (Array.isArray(body?.message?.tool_calls) && body.message.tool_calls.length) throw new Error("provider_error");
      const envelope = parseMemoryDigestEnvelope(body?.message?.content);
      return {
        proposals: normalizeOllamaDigestProposals(envelope.proposals),
        execution: {
          adapter: "ollama",
          primaryModel: resolved.model,
          effectiveModel: resolved.model,
          fallbackUsed: false,
          fallbackReason: null,
          attempts: 1,
        },
      };
    } catch (error) {
      if (signal?.aborted) throw new AdapterError("cancelled", "Ollama memory digest cancelled");
      if (control.timedOut()) throw new AdapterError("timed_out", "Ollama memory digest timed out");
      if (shutdownController.signal.aborted) throw new AdapterError("cancelled", "Ollama memory digest cancelled during shutdown");
      if (!response) throw new AdapterError("executor_unavailable", "Ollama memory digest executor is unavailable");
      throw new AdapterError("executor_failed", "Ollama memory digest executor failed");
    } finally {
      control.clear();
    }
  }

  async function shutdown() {
    if (!shutdownController.signal.aborted) shutdownController.abort();
  }

  return { run, digestMemory, shutdown };
}
