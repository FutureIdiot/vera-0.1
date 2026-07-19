// Strict validation and persistence for authenticated daemon result callbacks.

import { ApiError } from "../core/errors.js";
import {
  compareAndSetApiHistory,
  compareAndSetProviderBinding,
  providerFingerprintForRuntime,
} from "../spaces/context-state.js";
import { updateContextCompactionTarget } from "../spaces/context-compaction-store.js";

function invalid(message) { throw new ApiError("invalid_request", message); }
function conflict(message) { throw new ApiError("conflict", message); }
function stripInternal({ _seq, ...record }) { return structuredClone(record); }
function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) invalid(`${field} must be a non-empty string`);
  return value.trim();
}
function strictObject(value, { allowed, required = [], name = "body" }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object`);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    invalid(`${name} fields are invalid`);
  }
  return value;
}
function safeOpaque(value, field = "value", { requireObject = true } = {}) {
  if (requireObject && (!value || typeof value !== "object" || Array.isArray(value))) {
    invalid(`${field} must be an object`);
  }
  const visit = (node, path) => {
    if (Array.isArray(node)) return node.forEach((item, index) => visit(item, `${path}[${index}]`));
    if (!node || typeof node !== "object") {
      if (typeof node === "string" && (node.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(node))) {
        invalid(`${path} must not contain a host path`);
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      const normalizedKey = key.toLowerCase();
      const safeUsageTokenCount = /^(input|output|total)tokens$/u.test(normalizedKey);
      if (/(secret|password|path|memory|history)/u.test(normalizedKey) ||
          (normalizedKey.includes("token") && !safeUsageTokenCount)) {
        invalid(`${path}.${key} is not allowed`);
      }
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, field);
}

export function createDaemonRunResults({
  store,
  hub,
  runLifecycle = {},
  authenticate,
  runAuthority,
  assertRunAuthority,
} = {}) {
  function invoke(name, payload) {
    if (typeof runLifecycle[name] !== "function") conflict(`daemon run lifecycle ${name} is unavailable`);
    return runLifecycle[name](payload);
  }

  async function saveProviderBinding(agentSessionId, body, headers) {
    strictObject(body, {
      allowed: ["generation", "accountId", "agentId", "runtimeRevision", "providerState", "ifVersion"],
      required: ["generation", "accountId", "agentId", "runtimeRevision", "providerState", "ifVersion"],
    });
    if (!Number.isInteger(body.generation) || body.generation < 1 ||
        (body.ifVersion !== null && (!Number.isInteger(body.ifVersion) || body.ifVersion < 0))) {
      invalid("provider binding generation or ifVersion is invalid");
    }
    safeOpaque(body.providerState, "providerState");
    const authority = await authenticate(headers);
    const run = store.list("runs").find((candidate) => candidate.status === "running" &&
      candidate.executionTransport === "daemon" && candidate.executionLeaseId &&
      candidate.agentSessionId === agentSessionId && candidate.contextGeneration === body.generation &&
      candidate.accountId === authority.account.id && candidate.agentId === authority.agent.id &&
      candidate.accountSessionId === authority.session.id);
    if (!run || body.accountId !== authority.account.id || body.agentId !== authority.agent.id ||
        body.runtimeRevision !== authority.agent.runtimeRevision || authority.agent.runtimeProfile?.kind === "api") {
      throw new ApiError("forbidden", "Provider binding does not match the active CLI Execution");
    }
    assertRunAuthority(authority, run);
    if (runLifecycle.saveProviderBinding) {
      return invoke("saveProviderBinding", { ...authority, run, agentSessionId, input: structuredClone(body) });
    }
    const runtime = { ...authority.agent.runtimeProfile, connection: authority.agent.runtimeBinding?.connection ?? {} };
    return compareAndSetProviderBinding(store, {
      agentSessionId,
      generation: body.generation,
      accountId: body.accountId,
      providerFingerprint: providerFingerprintForRuntime(runtime),
      providerState: body.providerState,
      ifVersion: body.ifVersion,
    });
  }

  async function saveApiResult(runId, body, headers) {
    strictObject(body, {
      allowed: ["agentSessionId", "generation", "baseHistoryVersion", "assistantMessageIds", "toolTranscript", "usage"],
      required: ["agentSessionId", "generation", "baseHistoryVersion", "assistantMessageIds"],
    });
    if (!Number.isInteger(body.generation) || body.generation < 1 ||
        !Number.isInteger(body.baseHistoryVersion) || body.baseHistoryVersion < 0) {
      invalid("API result generation or history version is invalid");
    }
    if (body.toolTranscript !== undefined) {
      if (!Array.isArray(body.toolTranscript)) invalid("toolTranscript must be an array");
      for (const item of body.toolTranscript) {
        strictObject(item, {
          allowed: ["callId", "name", "arguments", "result", "status"],
          required: ["callId", "name", "arguments", "result", "status"],
          name: "toolTranscript item",
        });
        safeOpaque(item.arguments, "toolTranscript.arguments", { requireObject: false });
        safeOpaque(item.result, "toolTranscript.result", { requireObject: false });
      }
    }
    if (body.usage !== undefined) safeOpaque(body.usage, "usage");
    const authority = await runAuthority(runId, headers);
    if (authority.agent.runtimeProfile?.kind !== "api" || authority.run.role === "subagent" ||
        body.agentSessionId !== authority.run.agentSessionId || body.generation !== authority.run.contextGeneration ||
        !Array.isArray(body.assistantMessageIds) || body.assistantMessageIds.length === 0) {
      throw new ApiError("history_conflict", "API result does not match the main Execution context");
    }
    const messages = body.assistantMessageIds.map((id) => store.find("messages", id));
    if (messages.some((message) => !message || message.runId !== runId || message.status !== "completed")) {
      throw new ApiError("history_conflict", "API result Messages are not completed outputs of this Run");
    }
    if (runLifecycle.saveApiResult) {
      return invoke("saveApiResult", { ...authority, messages, input: structuredClone(body) });
    }
    const trigger = store.find("messages", authority.run.triggerMessageId);
    if (!trigger) throw new ApiError("history_conflict", "Run trigger Message is unavailable");
    let history;
    try {
      history = compareAndSetApiHistory(store, {
        agentSessionId: body.agentSessionId,
        generation: body.generation,
        baseHistoryVersion: body.baseHistoryVersion,
        turn: {
          runId,
          input: {
            sourceMessageId: trigger.id,
            author: trigger.author,
            target: trigger.target,
            content: trigger.content ?? "",
            fileIds: trigger.fileIds ?? [],
            createdAt: trigger.createdAt ?? null,
          },
          assistant: messages.map((message) => ({
            messageId: message.id, content: message.content, createdAt: message.createdAt,
          })),
          ...(body.toolTranscript === undefined ? {} : { toolTranscript: body.toolTranscript }),
          ...(body.usage === undefined ? {} : { usage: body.usage }),
        },
      });
    } catch (error) {
      if (error?.code === "history_conflict") {
        const failed = store.update("runs", runId, {
          status: "failed",
          endedAt: new Date().toISOString(),
          error: { code: "history_conflict", message: "API history result conflicted" },
        });
        hub?.publish("run.ended", { run: stripInternal(failed) });
      }
      throw error;
    }
    store.update("runs", runId, { apiResultVersion: history.version });
    return { historyVersion: history.version };
  }

  async function submitCompaction(jobId, agentId, body, headers) {
    strictObject(body, {
      allowed: ["agentSessionId", "fromGeneration", "status", "checkpoint", "providerBinding", "error"],
      required: ["agentSessionId", "fromGeneration", "status"],
    });
    requiredText(body.agentSessionId, "agentSessionId");
    if (!Number.isInteger(body.fromGeneration) || body.fromGeneration < 1 ||
        !["succeeded", "failed", "cancelled"].includes(body.status)) {
      invalid("compaction generation or status is invalid");
    }
    if (body.error !== undefined) {
      strictObject(body.error, {
        allowed: ["code", "message"], required: ["code", "message"], name: "error",
      });
      requiredText(body.error.code, "error.code");
      requiredText(body.error.message, "error.message");
    }
    if (body.providerBinding !== undefined) safeOpaque(body.providerBinding, "providerBinding");
    const authority = await authenticate(headers);
    if (agentId !== authority.agent.id) throw new ApiError("forbidden", "Compaction target Agent does not match");
    const job = store.find("contextCompactionJobs", jobId);
    const target = job?.targets?.find((candidate) => candidate.agentId === agentId);
    if (!target) throw new ApiError("not_found", `compaction target ${agentId} does not exist`);
    if (target.accountId !== authority.account.id) throw new ApiError("forbidden", "Compaction target Account does not match");
    if (runLifecycle.submitCompactionResult) {
      return invoke("submitCompactionResult", { ...authority, job, target, input: structuredClone(body) });
    }
    const updated = updateContextCompactionTarget(store, { jobId, agentId, ...body });
    hub?.publish("agent-session.compaction.updated", {
      spaceId: updated.spaceId,
      spaceSessionId: updated.spaceSessionId,
      jobId: updated.id,
      agentSession: stripInternal(store.find("agentSessions", target.agentSessionId)),
    });
    return updated;
  }

  return { saveProviderBinding, saveApiResult, submitCompaction };
}
