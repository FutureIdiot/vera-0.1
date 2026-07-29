// Native Codex CLI adapter (verified with codex-cli 0.146.0-alpha.3.1).
//
// - accepts only Account kind=cli, provider=codex;
// - chat uses non-interactive `codex exec --json`, with a versioned CLI
//   provider binding whose providerState is {threadId};
// - compact resumes that exact thread through app-server and waits for the
//   contextCompaction item plus its completed turn;
// - Codex has no token-delta JSONL event, so completed agent_message items map once
//   to onDelta and command/tool items map to Activity;
// - digestMemory always uses a fresh ephemeral temp cwd, read-only/never policy,
//   ignored user config/rules, a Codex-compatible --output-schema, and no fallback;
// - any digest tool item is a contract violation; gateway validation remains final;
// - abort/timeout/shutdown kill the detached process group and temp files are removed.

import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { AdapterError } from "../core/errors.js";
import { killProcessTree, spawnProcess } from "../core/spawn.js";
import {
  buildMemoryDigestPrompt,
  MEMORY_DIGEST_SYSTEM_PROMPT,
  parseMemoryDigestEnvelope,
} from "../memory/memory-digest-prompt.js";
import { buildMemoryDreamPrompt, MEMORY_DREAM_SYSTEM_PROMPT } from "../memory/memory-dream-prompt.js";
import {
  inferToolActivityKind,
  summarizeReasoning,
  summarizeToolActivity,
} from "../core/activity-events.js";
import { projectCodexDigestSchema } from "./codex-digest-schema.js";
import { normalizeCodexDreamProposals, projectCodexDreamSchema } from "./codex-dream-schema.js";
import { compactCodexThread } from "./codex-app-server.js";

export { projectCodexDigestSchema } from "./codex-digest-schema.js";

const DIGEST_DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "apps", "browser_use", "computer_use",
  "in_app_browser", "image_generation", "multi_agent", "plugin_sharing", "remote_plugin",
];

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = {
    input_tokens: "inputTokens",
    output_tokens: "outputTokens",
    reasoning_output_tokens: "thinkingTokens",
    cached_input_tokens: "cacheReadTokens",
    total_tokens: "totalTokens",
    model_context_window: "contextWindowTokens",
  };
  const usage = {};
  for (const [source, target] of Object.entries(fields)) {
    const count = value[source];
    if (Number.isFinite(count) && count >= 0) usage[target] = count;
  }
  return Number.isFinite(usage.inputTokens) ? usage : null;
}

function contextWindowsFromCatalog(catalog, models) {
  if (!Array.isArray(catalog?.models)) return [];
  const allowed = new Set(models);
  return catalog.models.flatMap((item) => {
    const model = typeof item?.slug === "string" ? item.slug.trim() : "";
    const rawWindow = item?.context_window;
    const effectivePercent = item?.effective_context_window_percent;
    if (!allowed.has(model) || !Number.isInteger(rawWindow) || rawWindow <= 0 ||
        !Number.isFinite(effectivePercent) || effectivePercent <= 0 || effectivePercent > 100) {
      return [];
    }
    const contextWindowTokens = Math.floor(rawWindow * effectivePercent / 100);
    return contextWindowTokens > 0 ? [{
      model,
      contextWindowTokens,
      measurement: "provider_reported",
    }] : [];
  }).sort((left, right) => left.model.localeCompare(right.model));
}

function missingThread(stderr) {
  return /no rollout found for thread id/iu.test(stderr)
    || /(?:thread|session).{0,80}(?:not found|does not exist|unknown|invalid)/iu.test(stderr);
}

function toolActivity(item, eventType = "item.completed") {
  const label = item.type || "codex-tool";
  const detail = item.command || item.query || item.name || item.server || "";
  const toolStatus = item.status || (eventType === "item.started" ? "running" : "completed");
  const kind = inferToolActivityKind(label);
  return {
    phase: "tool",
    kind,
    label,
    summary: summarizeToolActivity({ kind, name: label, status: toolStatus }),
    detail: typeof detail === "string" ? detail : JSON.stringify(detail),
    toolStatus,
    callId: item.id || null,
  };
}

function isDigestToolItem(item) {
  return item?.type !== "agent_message" && item?.type !== "reasoning";
}

export function createCodexAdapter({ config = {} }) {
  const {
    binary: defaultBinary = "codex",
    chatSandbox = "workspace-write",
    watchdogMs = 30 * 60 * 1000,
    digestTimeoutMs = 5 * 60 * 1000,
    dreamTimeoutMs = 10 * 60 * 1000,
    maxInputBytes = 12000,
  } = config;
  if (!["read-only", "workspace-write"].includes(chatSandbox)) {
    throw new TypeError("Codex chatSandbox must be read-only or workspace-write");
  }
  const shutdownController = new AbortController();
  const active = new Set();
  const operations = new Set();

  function trackOperation(operation) {
    operations.add(operation);
    operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
    return operation;
  }

  function assertRuntime(runtime, code = "unavailable") {
    if (runtime?.kind !== "cli" || runtime?.provider !== "codex") {
      throw new AdapterError(code, "Codex adapter runtime kind/provider mismatch");
    }
    if (runtime.connection?.secretRef != null) {
      throw new AdapterError(code, "Codex runtime secretRef is not supported");
    }
    if (Array.isArray(runtime.connection?.args) && runtime.connection.args.length) {
      throw new AdapterError(code, "Codex runtime connection args are not supported");
    }
    const command = String(runtime.connection?.command ?? "").trim();
    if (command && basename(command) !== "codex") {
      throw new AdapterError(code, "Codex runtime command is invalid");
    }
  }

  function resolveBinary(runtime) {
    const command = String(runtime?.connection?.command ?? "").trim();
    return command && basename(command) === "codex" ? command : defaultBinary;
  }

  async function assertBinary(binary, code) {
    if (!binary.includes("/")) return;
    try {
      await access(binary, constants.X_OK);
    } catch {
      throw new AdapterError(code, code === "executor_unavailable"
        ? "Codex memory digest executor is unavailable"
        : "Codex CLI is unavailable");
    }
  }

  async function execJson({ binary, args, cwd, input, signal, timeoutMs, digest = false, onEvent }) {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    timer.unref?.();
    const combined = signal
      ? AbortSignal.any([signal, timeoutController.signal, shutdownController.signal])
      : AbortSignal.any([timeoutController.signal, shutdownController.signal]);
    let child;
    let abortHandler;
    let killTimer;
    let stderr = "";
    let buffer = "";
    let eventError = null;
    try {
      if (signal?.aborted) throw new AdapterError("cancelled", digest ? "memory digest cancelled" : "Codex run cancelled");
      if (shutdownController.signal.aborted) {
        throw new AdapterError(digest ? "executor_unavailable" : "unavailable", "Codex adapter is shut down");
      }
      child = spawnProcess(binary, args, { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      active.add(child);
      const terminate = () => {
        if (killTimer) return;
        killProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            try { child.kill("SIGKILL"); } catch {}
          }
        }, 500);
        killTimer.unref?.();
      };
      abortHandler = terminate;
      combined.addEventListener("abort", abortHandler, { once: true });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          try {
            onEvent(JSON.parse(line));
          } catch (error) {
            eventError = error;
            terminate();
            break;
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 8000) stderr += chunk.slice(0, 8000 - stderr.length);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);

      const exit = await new Promise((resolve, reject) => {
        child.once("error", (error) => {
          error.spawnFailed = true;
          reject(error);
        });
        child.once("exit", (code, exitSignal) => resolve({ code, exitSignal }));
      });
      const tail = buffer.trim();
      if (tail && !eventError) {
        try { onEvent(JSON.parse(tail)); } catch (error) { eventError = error; }
      }
      if (signal?.aborted) throw new AdapterError("cancelled", digest ? "memory digest cancelled" : "Codex run cancelled");
      if (timeoutController.signal.aborted) {
        throw new AdapterError("timed_out", digest ? "Codex memory digest timed out" : "Codex run timed out");
      }
      if (shutdownController.signal.aborted) {
        throw new AdapterError("cancelled", digest ? "memory digest cancelled" : "Codex run cancelled");
      }
      if (eventError) throw eventError;
      if (exit.code !== 0) {
        const error = new AdapterError(digest ? "executor_failed" : "provider_error",
          digest ? "Codex memory digest executor failed" : "Codex CLI execution failed");
        error.missingThread = !digest && missingThread(stderr);
        throw error;
      }
      return exit;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      if (!error?.spawnFailed && child) {
        throw new AdapterError(digest ? "executor_failed" : "provider_error",
          digest ? "Codex memory digest executor failed" : "Codex CLI execution failed");
      }
      throw new AdapterError(digest ? "executor_unavailable" : "unavailable",
        digest ? "Codex memory digest executor is unavailable" : "Codex CLI is unavailable");
    } finally {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (abortHandler) combined.removeEventListener("abort", abortHandler);
      if (child) active.delete(child);
    }
  }

  async function runAttempt(ctx, providerBinding = null) {
    const binary = resolveBinary(ctx.runtime);
    await assertBinary(binary, "unavailable");
    const directory = await mkdtemp(join(tmpdir(), "vera-codex-chat-"));
    const outputPath = join(directory, "last-message.txt");
    const threadId = providerBinding?.providerState?.threadId ?? null;
    let nextThreadId = threadId;
    let nextProviderBinding = providerBinding;
    let persistPromise = null;
    let persistError = null;
    let content = "";
    let reasoningCount = 0;
    let usage = null;
    const initialReasoningCallId = `thinking-${threadId ?? "new"}`;
    const workspacePath = ctx.workspacePath || process.cwd();
    const args = ["-C", workspacePath, "-a", "never", "-s", chatSandbox, "exec"];
    if (threadId) args.push("resume", threadId);
    args.push("--json", "--skip-git-repo-check", "--output-last-message", outputPath);
    const model = String(ctx.runtime.model ?? "").trim();
    if (model) args.push("-m", model);
    args.push("-");
    try {
      ctx.onActivity?.({
        phase: "thinking",
        kind: "reasoning",
        label: "Codex",
        summary: "正在分析请求",
        callId: initialReasoningCallId,
      });
      await execJson({
        binary, args, cwd: workspacePath, input: String(ctx.prompt?.text ?? ""),
        signal: ctx.signal, timeoutMs: watchdogMs,
        onEvent(event) {
          if (event?.type === "thread.started" && typeof event.thread_id === "string") {
            nextThreadId = event.thread_id;
            if (ctx.sessionMode !== "isolated" && event.thread_id !== threadId) {
              try {
                persistPromise = Promise.resolve(ctx.persistProviderBinding?.(
                  { threadId: nextThreadId },
                  providerBinding?.version ?? null,
                )).then(
                  (saved) => { nextProviderBinding = saved ?? null; },
                  (error) => { persistError = error; },
                );
              } catch (error) {
                persistError = error;
              }
            }
          }
          if (event?.type === "turn.completed") {
            usage = normalizeUsage(event.usage);
            return;
          }
          if (!["item.started", "item.completed"].includes(event?.type)) return;
          const item = event.item ?? {};
          if (event.type === "item.completed" &&
              item.type === "agent_message" && typeof item.text === "string" && item.text) {
            content += item.text;
            ctx.onDelta?.(item.text);
          } else if (item.type === "reasoning") {
            const publicSummary = item.text ?? item.summary ?? "";
            if (publicSummary) {
              reasoningCount += 1;
              ctx.onActivity?.({
                phase: "thinking",
                kind: "reasoning",
                label: "Codex",
                summary: summarizeReasoning(publicSummary),
                callId: reasoningCount === 1
                  ? initialReasoningCallId
                  : item.id || `${initialReasoningCallId}-${reasoningCount}`,
              });
            }
          } else if (isDigestToolItem(item)) {
            ctx.onActivity?.(toolActivity(item, event.type));
          }
        },
      });
      if (!content) {
        try { content = await readFile(outputPath, "utf8"); } catch {}
      }
      if (!nextThreadId) throw new AdapterError("provider_error", "Codex CLI did not return a thread id");
      await persistPromise;
      if (persistError) throw persistError;
      return {
        content,
        ...(nextProviderBinding ? { providerBinding: nextProviderBinding } : {}),
        ...(ctx.sessionMode === "main" && usage ? { usage } : {}),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function runInner(ctx) {
    assertRuntime(ctx.runtime);
    const assertPromptCapacity = (prompt) => {
      if (byteLength(prompt?.text) <= maxInputBytes) return;
      throw new AdapterError("provider_error", "Codex current prompt exceeds the configured input capacity");
    };
    let prompt = ctx.prompt;
    let providerBinding = ctx.sessionMode === "isolated" ? null : ctx.providerBinding;
    if (providerBinding != null && (
      !Number.isInteger(providerBinding?.version) || providerBinding.version < 1 ||
      typeof providerBinding?.providerState?.threadId !== "string" || !providerBinding.providerState.threadId
    )) {
      ctx.onActivity?.({
        phase: "error",
        kind: "error",
        label: "session-reset",
        summary: "Codex 会话已重置",
        detail: "Codex provider binding was invalid and has been reset",
      });
      const rotated = await ctx.rotateProviderBinding?.({ reason: "invalid" });
      prompt = rotated?.prompt ?? prompt;
      providerBinding = rotated?.providerBinding ?? null;
    }
    assertPromptCapacity(prompt);
    try {
      return await runAttempt({ ...ctx, prompt }, providerBinding);
    } catch (error) {
      if (!providerBinding || !error?.missingThread) throw error;
      ctx.onActivity?.({
        phase: "error",
        kind: "error",
        label: "session-reset",
        summary: "Codex 会话已重置",
        detail: "Codex thread was unavailable and has been reset",
      });
      const rotated = await ctx.rotateProviderBinding?.({ reason: "missing" });
      const prompt = rotated?.prompt ?? ctx.prompt;
      assertPromptCapacity(prompt);
      return runAttempt({ ...ctx, prompt }, rotated?.providerBinding ?? null);
    }
  }

  function run(ctx) {
    return trackOperation(runInner(ctx));
  }

  async function discoverRuntimeCapabilities(runtime) {
    assertRuntime(runtime, "executor_unavailable");
    const binary = resolveBinary(runtime);
    await assertBinary(binary, "executor_unavailable");
    let catalog = null;
    await execJson({
      binary,
      args: ["debug", "models", "--bundled"],
      cwd: process.cwd(),
      input: "",
      signal: null,
      timeoutMs: digestTimeoutMs,
      digest: true,
      onEvent(event) {
        if (event?.models) catalog = event;
      },
    });
    const models = runtime.runtimeCapabilities?.models ?? [runtime.model];
    const schemaDirectory = await mkdtemp(join(tmpdir(), "vera-codex-schema-"));
    let nativeCompaction = false;
    try {
      await execJson({
        binary,
        args: ["app-server", "generate-json-schema", "--out", schemaDirectory],
        cwd: process.cwd(),
        input: "",
        signal: null,
        timeoutMs: digestTimeoutMs,
        digest: true,
        onEvent() {},
      });
      const clientRequests = await readFile(join(schemaDirectory, "ClientRequest.json"), "utf8");
      nativeCompaction = clientRequests.includes('"thread/compact/start"');
    } catch {
      nativeCompaction = false;
    } finally {
      await rm(schemaDirectory, { recursive: true, force: true });
    }
    return {
      ...runtime.runtimeCapabilities,
      models: [...models],
      modelContexts: contextWindowsFromCatalog(catalog, models),
      ...(nativeCompaction ? { contextCompaction: "native" } : {}),
    };
  }

  async function compactSessionInner({ input, runtime, workspacePath, signal }) {
    assertRuntime(runtime);
    const providerBinding = input?.providerBinding;
    const threadId = providerBinding?.providerState?.threadId;
    if (!Number.isInteger(providerBinding?.version) || providerBinding.version < 1 ||
        typeof threadId !== "string" || !threadId) {
      throw new AdapterError("provider_error", "Codex native context compaction requires a current thread");
    }
    const binary = resolveBinary(runtime);
    await assertBinary(binary, "unavailable");
    await compactCodexThread({
      binary,
      threadId,
      cwd: workspacePath ?? process.cwd(),
      sandbox: chatSandbox,
      signal,
      timeoutMs: watchdogMs,
    });
    return { providerBinding };
  }

  function compactSession(input) {
    return trackOperation(compactSessionInner(input));
  }

  async function digestMemoryInner({ runtime, taskModel, payload, signal }) {
    assertRuntime(runtime, "executor_unavailable");
    const binary = resolveBinary(runtime);
    await assertBinary(binary, "executor_unavailable");
    const prompt = `${MEMORY_DIGEST_SYSTEM_PROMPT}\n\n${buildMemoryDigestPrompt(payload)}`;
    if (byteLength(prompt) > maxInputBytes) {
      throw new AdapterError("executor_failed", "Codex memory digest input exceeds the configured capacity");
    }
    const transportSchema = projectCodexDigestSchema(payload?.proposalSchema);
    const directory = await mkdtemp(join(tmpdir(), "vera-codex-digest-"));
    const schemaPath = join(directory, "output-schema.json");
    const outputPath = join(directory, "last-message.json");
    const model = String(taskModel ?? "").trim();
    if (!model) throw new AdapterError("executor_unavailable", "Codex memory digest task model is unavailable");
    let structured = "";
    try {
      await writeFile(schemaPath, `${JSON.stringify(transportSchema)}\n`, { mode: 0o600 });
      const args = ["-C", directory, "-a", "never", "-s", "read-only"];
      for (const feature of DIGEST_DISABLED_FEATURES) args.push("--disable", feature);
      args.push(
        "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
        "--json", "--output-schema", schemaPath, "--output-last-message", outputPath,
      );
      if (model) args.push("-m", model);
      args.push("-");
      await execJson({
        binary, args, cwd: directory, input: prompt, signal, timeoutMs: digestTimeoutMs, digest: true,
        onEvent(event) {
          if (!event?.type?.startsWith("item.")) return;
          const item = event.item ?? {};
          if (isDigestToolItem(item)) {
            throw new AdapterError("executor_failed", "Codex memory digest attempted to use a tool");
          }
          if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
            structured = item.text;
          }
        },
      });
      try { structured = await readFile(outputPath, "utf8"); } catch {}
      const envelope = parseMemoryDigestEnvelope(structured);
      return {
        ...envelope,
        execution: {
          adapter: "codex", primaryModel: model || null, effectiveModel: model || null,
          fallbackUsed: false, fallbackReason: null, attempts: 1,
        },
      };
    } catch (error) {
      if (signal?.aborted) throw new AdapterError("cancelled", "memory digest cancelled");
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("executor_failed", "Codex memory digest executor failed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  function digestMemory(input) {
    return trackOperation(digestMemoryInner(input));
  }

  async function dreamMemoryInner({ runtime, taskModel, payload, signal }) {
    assertRuntime(runtime, "executor_unavailable");
    const binary = resolveBinary(runtime);
    await assertBinary(binary, "executor_unavailable");
    const prompt = `${MEMORY_DREAM_SYSTEM_PROMPT}\n\n${buildMemoryDreamPrompt(payload)}`;
    if (byteLength(prompt) > maxInputBytes) throw new AdapterError("executor_failed", "Codex memory Dream input exceeds the configured capacity");
    const transportSchema = projectCodexDreamSchema(payload?.proposalSchema);
    const directory = await mkdtemp(join(tmpdir(), "vera-codex-dream-"));
    const schemaPath = join(directory, "output-schema.json");
    const outputPath = join(directory, "last-message.json");
    const model = String(taskModel ?? "").trim();
    if (!model) throw new AdapterError("executor_unavailable", "Codex memory Dream task model is unavailable");
    let structured = "";
    try {
      await writeFile(schemaPath, `${JSON.stringify(transportSchema)}\n`, { mode: 0o600 });
      const args = ["-C", directory, "-a", "never", "-s", "read-only"];
      for (const feature of DIGEST_DISABLED_FEATURES) args.push("--disable", feature);
      args.push("exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--json", "--output-schema", schemaPath, "--output-last-message", outputPath, "-m", model, "-");
      await execJson({
        binary, args, cwd: directory, input: prompt, signal, timeoutMs: dreamTimeoutMs, digest: true,
        onEvent(event) {
          if (!event?.type?.startsWith("item.")) return;
          const item = event.item ?? {};
          if (isDigestToolItem(item)) throw new AdapterError("executor_failed", "Codex memory Dream attempted to use a tool");
          if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") structured = item.text;
        },
      });
      try { structured = await readFile(outputPath, "utf8"); } catch {}
      const envelope = parseMemoryDigestEnvelope(structured);
      return {
        ...envelope,
        proposals: normalizeCodexDreamProposals(envelope.proposals),
        execution: { adapter: "codex", primaryModel: model, effectiveModel: model, fallbackUsed: false, fallbackReason: null, attempts: 1 },
      };
    } catch (error) {
      if (signal?.aborted) throw new AdapterError("cancelled", "memory Dream cancelled");
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("executor_failed", "Codex memory Dream executor failed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  function dreamMemory(input) { return trackOperation(dreamMemoryInner(input)); }

  async function shutdown() {
    if (!shutdownController.signal.aborted) shutdownController.abort();
    for (const child of active) killProcessTree(child, "SIGTERM");
    await Promise.allSettled([...operations]);
  }

  return { run, compactSession, discoverRuntimeCapabilities, digestMemory, dreamMemory, shutdown };
}
