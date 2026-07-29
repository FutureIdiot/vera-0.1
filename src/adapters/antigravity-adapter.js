// Antigravity CLI adapter (verified with agy 1.1.8).
//
// - accepts only kind=cli, provider=antigravity and an explicit Project id;
// - runs `agy --output-format stream-json` in the frozen Account Workspace;
// - persists {conversationId}, resumes with --conversation, and treats a
//   different init conversation id as a missing binding before any reply;
// - maps public agent_response/tool events to delta/Activity and normalizes
//   result usage; hidden reasoning is never projected;
// - relies on Antigravity's persisted fine-grained permission rules, never its
//   dangerous bypass or scratch sandbox, and resumes once after a structured
//   headless permission soft-deny so the agent can finish without retrying it;
// - abort/timeout/shutdown terminate the detached process group.

import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { AdapterError } from "../core/errors.js";
import {
  inferToolActivityKind,
  summarizeToolActivity,
} from "../core/activity-events.js";
import { killProcessTree, spawnProcess } from "../core/spawn.js";
import { publicProviderRunError } from "./provider-run-error.js";

const USAGE_FIELDS = {
  input_tokens: "inputTokens",
  output_tokens: "outputTokens",
  thinking_tokens: "thinkingTokens",
  cache_read_tokens: "cacheReadTokens",
  total_tokens: "totalTokens",
};

const PERMISSION_DENIED_CONTINUATION = [
  "Vera control notice: the previous tool request was denied by the headless permission policy.",
  "Do not retry that tool or request elevated permissions.",
  "Continue within the permissions already available and give the user a concise final response explaining any limitation.",
].join(" ");

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function validConversationBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
      !Number.isInteger(binding.version) || binding.version < 1) return false;
  const state = binding.providerState;
  return Boolean(state && typeof state === "object" && !Array.isArray(state) &&
    Object.keys(state).length === 1 &&
    typeof state.conversationId === "string" && state.conversationId.trim());
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = {};
  for (const [source, target] of Object.entries(USAGE_FIELDS)) {
    const count = value[source];
    if (Number.isFinite(count) && count >= 0) usage[target] = count;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function permissionDeniedTool(step) {
  if (String(step?.state ?? "").toUpperCase() !== "ERROR") return false;
  const error = step?.tool_info?.error;
  if (error == null) return false;
  const fields = error && typeof error === "object" && !Array.isArray(error)
    ? [error.name, error.code, error.type, error.message, JSON.stringify(error)]
    : [error];
  return fields.some((value) => {
    const text = String(value ?? "").trim();
    return /(?:^|[./\s])PermissionUserDeniedError(?:$|[\s:])/u.test(text) ||
      /^User denied permission to (?:\S|\s)+/u.test(text);
  });
}

function toolActivity(step) {
  const info = step?.tool_info && typeof step.tool_info === "object" ? step.tool_info : {};
  const name = String(step?.tool_name || info.name || "tool");
  const state = String(step?.state || "").toUpperCase();
  const toolStatus = state === "ACTIVE" ? "running"
    : state === "DONE" ? "completed"
      : state === "ERROR" ? "failed"
        : "pending";
  const kind = inferToolActivityKind(name);
  const detail = [info.parameters, info.output, info.error]
    .filter((item) => item !== undefined && item !== null && item !== "")
    .map((item) => typeof item === "string" ? item : JSON.stringify(item))
    .join("\n");
  return {
    phase: "tool",
    kind,
    label: name,
    summary: permissionDeniedTool(step)
      ? "工具权限申请已自动拒绝"
      : summarizeToolActivity({ kind, name, status: toolStatus }),
    detail,
    toolStatus,
    callId: `antigravity-${step?.conversation_id ?? "new"}-${step?.step_index ?? "tool"}`,
  };
}

export function createAntigravityAdapter({ config = {} } = {}) {
  const {
    binary: defaultBinary = "agy",
    projectId = null,
    mode = "accept-edits",
    watchdogMs = 30 * 60 * 1000,
    maxInputBytes = 131072,
  } = config;
  if (!["accept-edits", "plan"].includes(mode)) {
    throw new TypeError("Antigravity mode must be accept-edits or plan");
  }
  if (!Number.isInteger(watchdogMs) || watchdogMs <= 0 ||
      !Number.isInteger(maxInputBytes) || maxInputBytes <= 0) {
    throw new TypeError("Antigravity capacity and watchdog must be positive integers");
  }

  const shutdownController = new AbortController();
  const active = new Set();
  const operations = new Set();

  function track(operation) {
    operations.add(operation);
    operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
    return operation;
  }

  function assertRuntime(runtime) {
    if (runtime?.kind !== "cli" || runtime?.provider !== "antigravity") {
      throw new AdapterError("unavailable", "Antigravity adapter runtime kind/provider mismatch");
    }
    if (runtime.connection?.secretRef != null) {
      throw new AdapterError("unavailable", "Antigravity runtime secretRef is not supported");
    }
    if (Array.isArray(runtime.connection?.args) && runtime.connection.args.length) {
      throw new AdapterError("unavailable", "Antigravity runtime connection args are not supported");
    }
    const command = String(runtime.connection?.command ?? "").trim();
    if (command && basename(command) !== "agy") {
      throw new AdapterError("unavailable", "Antigravity runtime command is invalid");
    }
  }

  function resolveBinary(runtime) {
    const command = String(runtime?.connection?.command ?? "").trim();
    return command || defaultBinary;
  }

  async function assertBinary(binary) {
    if (!binary.includes("/")) return;
    try {
      await access(binary, constants.X_OK);
    } catch {
      throw new AdapterError("unavailable", "Antigravity CLI is unavailable");
    }
  }

  async function runAttempt(ctx, providerBinding) {
    const binary = resolveBinary(ctx.runtime);
    await assertBinary(binary);
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new AdapterError("unavailable", "Antigravity Project is not configured");
    }
    const workspacePath = await realpath(resolve(ctx.workspacePath || process.cwd()));
    const priorConversationId = providerBinding?.providerState?.conversationId ?? null;
    const model = String(ctx.runtime?.model ?? "").trim();
    if (!model) throw new AdapterError("unavailable", "Antigravity runtime model is required");
    const prompt = String(ctx.prompt?.text ?? "");
    if (byteLength(prompt) > maxInputBytes) {
      throw new AdapterError("provider_error", "Antigravity current prompt exceeds the configured input capacity");
    }
    const args = [
      "--project", projectId.trim(),
      ...(priorConversationId ? ["--conversation", priorConversationId] : []),
      "--model", model,
      "--mode", mode,
      "--output-format", "stream-json",
      "--print-timeout", `${Math.ceil(watchdogMs / 1000)}s`,
      "--print", prompt,
    ];
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), watchdogMs);
    timer.unref?.();
    const signal = AbortSignal.any([
      ...(ctx.signal ? [ctx.signal] : []),
      timeoutController.signal,
      shutdownController.signal,
    ]);
    let child;
    let killTimer = null;
    let buffer = "";
    let stderr = "";
    let eventTail = Promise.resolve();
    let eventError = null;
    let resultEvent = null;
    let conversationId = priorConversationId;
    let content = "";
    let sawDelta = false;
    let sawPermissionDenied = false;
    let savedBinding = providerBinding;
    let persistPromise = null;

    const terminate = () => {
      if (!child || killTimer) return;
      killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 500);
      killTimer.unref?.();
    };

    const persist = async (nextConversationId) => {
      if (ctx.sessionMode === "isolated" || priorConversationId === nextConversationId) return;
      if (typeof ctx.persistProviderBinding !== "function") {
        throw new AdapterError("provider_error", "Antigravity provider binding persistence is unavailable");
      }
      const saved = await ctx.persistProviderBinding(
        { conversationId: nextConversationId },
        providerBinding?.version ?? null,
      );
      if (!validConversationBinding(saved) ||
          saved.providerState.conversationId !== nextConversationId) {
        throw new AdapterError("provider_error", "Antigravity provider binding persistence failed");
      }
      savedBinding = saved;
    };

    async function consume(event) {
      if (event?.event === "init") {
        const nextConversationId = event.conversation_id;
        if (typeof nextConversationId !== "string" || !nextConversationId) {
          throw new AdapterError("provider_error", "Antigravity CLI did not return a conversation id");
        }
        if (typeof event.init?.cwd !== "string" || !event.init.cwd ||
            await realpath(resolve(event.init.cwd)).catch(() => null) !== workspacePath) {
          throw new AdapterError("provider_error", "Antigravity CLI used an unexpected Workspace");
        }
        if (event.init?.model !== model) {
          throw new AdapterError("provider_error", "Antigravity CLI used an unexpected model");
        }
        if (priorConversationId && nextConversationId !== priorConversationId) {
          const error = new AdapterError("provider_error", "Antigravity conversation is unavailable");
          error.missingConversation = true;
          throw error;
        }
        conversationId = nextConversationId;
        persistPromise ??= persist(nextConversationId);
        await persistPromise;
        return;
      }
      if (event?.event === "step_update") {
        const step = event.step_update ?? {};
        if (step.step_type === "agent_response" && typeof step.text_delta === "string" && step.text_delta) {
          sawDelta = true;
          content += step.text_delta;
          await ctx.onDelta?.(step.text_delta);
        } else if (step.step_type === "tool") {
          if (permissionDeniedTool(step)) sawPermissionDenied = true;
          await ctx.onActivity?.(toolActivity(step));
        }
        return;
      }
      if (event?.event === "result") resultEvent = event.result ?? null;
    }

    function queueEvent(event) {
      eventTail = eventTail.then(() => consume(event));
      eventTail.catch((error) => {
        eventError ??= error;
        terminate();
      });
    }

    try {
      if (ctx.signal?.aborted) throw new AdapterError("cancelled", "Antigravity run cancelled");
      if (shutdownController.signal.aborted) {
        throw new AdapterError("unavailable", "Antigravity adapter is shut down");
      }
      child = spawnProcess(binary, args, {
        cwd: workspacePath,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      active.add(child);
      signal.addEventListener("abort", terminate, { once: true });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          try {
            queueEvent(JSON.parse(line));
          } catch (error) {
            eventError ??= error;
            terminate();
            break;
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 8000) stderr += chunk.slice(0, 8000 - stderr.length);
      });
      const exit = await new Promise((resolveExit, reject) => {
        child.once("error", (error) => {
          error.spawnFailed = true;
          reject(error);
        });
        child.once("exit", (code, exitSignal) => resolveExit({ code, exitSignal }));
      });
      const tail = buffer.trim();
      if (tail && !eventError) {
        try { queueEvent(JSON.parse(tail)); } catch (error) { eventError ??= error; }
      }
      await eventTail.catch(() => {});
      if (ctx.signal?.aborted || shutdownController.signal.aborted) {
        throw new AdapterError("cancelled", "Antigravity run cancelled");
      }
      if (timeoutController.signal.aborted) {
        throw new AdapterError("timed_out", "Antigravity run timed out");
      }
      if (eventError) throw eventError;
      if (exit.code !== 0 || !resultEvent || resultEvent.status !== "SUCCESS") {
        throw publicProviderRunError("Antigravity", { payload: resultEvent, stderr });
      }
      if (!conversationId) {
        throw new AdapterError("provider_error", "Antigravity CLI did not return a conversation id");
      }
      if (resultEvent.conversation_id !== conversationId) {
        throw new AdapterError("provider_error", "Antigravity CLI returned an inconsistent conversation id");
      }
      await persistPromise;
      if (!sawDelta && typeof resultEvent.response === "string" && resultEvent.response) {
        content = resultEvent.response;
        await ctx.onDelta?.(resultEvent.response);
      }
      const usage = normalizeUsage(resultEvent.usage);
      return {
        content,
        ...(savedBinding ? { providerBinding: savedBinding } : {}),
        ...(usage ? { usage } : {}),
        permissionDenied: sawPermissionDenied,
        conversationId,
      };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      if (!error?.spawnFailed && child) {
        throw new AdapterError("provider_error", "Antigravity CLI execution failed");
      }
      throw new AdapterError("unavailable", "Antigravity CLI is unavailable");
    } finally {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", terminate);
      if (child) active.delete(child);
    }
  }

  async function runInner(ctx) {
    assertRuntime(ctx.runtime);
    let prompt = ctx.prompt;
    let providerBinding = ctx.sessionMode === "isolated" ? null : ctx.providerBinding;
    if (providerBinding != null && !validConversationBinding(providerBinding)) {
      ctx.onActivity?.({
        phase: "error",
        kind: "error",
        label: "session-reset",
        summary: "Antigravity 会话已重置",
        detail: "Antigravity provider binding was invalid and has been reset",
      });
      const rotated = await ctx.rotateProviderBinding?.({ reason: "invalid" });
      if (!rotated) throw new AdapterError("provider_error", "Antigravity session rotation is unavailable");
      prompt = rotated.prompt ?? prompt;
      providerBinding = rotated.providerBinding ?? null;
    }
    let attempt;
    try {
      attempt = await runAttempt({ ...ctx, prompt }, providerBinding);
    } catch (error) {
      if (!providerBinding || !error?.missingConversation) throw error;
      ctx.onActivity?.({
        phase: "error",
        kind: "error",
        label: "session-reset",
        summary: "Antigravity 会话已重置",
        detail: "Antigravity conversation was unavailable and has been reset",
      });
      const rotated = await ctx.rotateProviderBinding?.({ reason: "missing" });
      if (!rotated) throw new AdapterError("provider_error", "Antigravity session rotation is unavailable");
      attempt = await runAttempt(
        { ...ctx, prompt: rotated.prompt ?? ctx.prompt },
        rotated.providerBinding ?? null,
      );
    }
    if (attempt.permissionDenied && !attempt.content) {
      const continuationBinding = attempt.providerBinding ?? {
        version: 1,
        providerState: { conversationId: attempt.conversationId },
      };
      attempt = await runAttempt({
        ...ctx,
        prompt: { text: PERMISSION_DENIED_CONTINUATION },
      }, continuationBinding);
      if (attempt.permissionDenied || !attempt.content) {
        throw new AdapterError(
          "provider_error",
          "Antigravity did not complete after a denied tool request",
        );
      }
    }
    const { permissionDenied: _permissionDenied, conversationId: _conversationId, ...result } = attempt;
    if (ctx.sessionMode === "isolated") delete result.providerBinding;
    return result;
  }

  function run(ctx) {
    return track(runInner(ctx));
  }

  async function shutdown() {
    if (!shutdownController.signal.aborted) shutdownController.abort();
    for (const child of active) killProcessTree(child, "SIGTERM");
    await Promise.allSettled([...operations]);
  }

  return { run, shutdown };
}
