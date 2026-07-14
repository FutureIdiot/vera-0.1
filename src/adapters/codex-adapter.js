// Native Codex CLI adapter (verified with codex-cli 0.144.2).
//
// - accepts only Account kind=cli, provider=codex;
// - chat uses non-interactive `codex exec --json`, with sessionState={threadId};
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
import { projectCodexDigestSchema } from "./codex-digest-schema.js";

export { projectCodexDigestSchema } from "./codex-digest-schema.js";

const DIGEST_DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "apps", "browser_use", "computer_use",
  "in_app_browser", "image_generation", "multi_agent", "plugin_sharing", "remote_plugin",
];

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function missingThread(stderr) {
  return /no rollout found for thread id/iu.test(stderr)
    || /(?:thread|session).{0,80}(?:not found|does not exist|unknown|invalid)/iu.test(stderr);
}

function toolActivity(item) {
  const label = item.type || "codex-tool";
  const detail = item.command || item.query || item.name || item.server || "";
  return {
    phase: "tool",
    label,
    detail: typeof detail === "string" ? detail : JSON.stringify(detail),
    toolStatus: item.status || "completed",
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

  function assertAccount(account, code = "unavailable") {
    if (account?.kind !== "cli" || account?.provider !== "codex") {
      throw new AdapterError(code, "Codex adapter Account kind/provider mismatch");
    }
    if (account.connection?.secretRef != null) {
      throw new AdapterError(code, "Codex Account secretRef is not supported");
    }
    if (Array.isArray(account.connection?.args) && account.connection.args.length) {
      throw new AdapterError(code, "Codex Account connection args are not supported");
    }
    const command = String(account.connection?.command ?? "").trim();
    if (command && basename(command) !== "codex") {
      throw new AdapterError(code, "Codex Account command is invalid");
    }
  }

  function resolveBinary(account) {
    const command = String(account?.connection?.command ?? "").trim();
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

  async function runAttempt(ctx, threadId = null) {
    const binary = resolveBinary(ctx.account);
    await assertBinary(binary, "unavailable");
    const directory = await mkdtemp(join(tmpdir(), "vera-codex-chat-"));
    const outputPath = join(directory, "last-message.txt");
    let nextThreadId = threadId;
    let content = "";
    const workspacePath = ctx.workspacePath || process.cwd();
    const args = ["-C", workspacePath, "-a", "never", "-s", chatSandbox, "exec"];
    if (threadId) args.push("resume", threadId);
    args.push("--json", "--skip-git-repo-check", "--output-last-message", outputPath);
    const model = String(ctx.account.model ?? "").trim();
    if (model) args.push("-m", model);
    args.push("-");
    try {
      await execJson({
        binary, args, cwd: workspacePath, input: String(ctx.prompt?.text ?? ""),
        signal: ctx.signal, timeoutMs: watchdogMs,
        onEvent(event) {
          if (event?.type === "thread.started" && typeof event.thread_id === "string") {
            nextThreadId = event.thread_id;
            ctx.persistSessionState?.({ threadId: nextThreadId });
          }
          if (event?.type !== "item.completed") return;
          const item = event.item ?? {};
          if (item.type === "agent_message" && typeof item.text === "string" && item.text) {
            content += item.text;
            ctx.onDelta?.(item.text);
          } else if (isDigestToolItem(item)) {
            ctx.onActivity?.(toolActivity(item));
          }
        },
      });
      if (!content) {
        try { content = await readFile(outputPath, "utf8"); } catch {}
      }
      if (!nextThreadId) throw new AdapterError("provider_error", "Codex CLI did not return a thread id");
      return { content, sessionState: { threadId: nextThreadId } };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function runInner(ctx) {
    assertAccount(ctx.account);
    const promptText = String(ctx.prompt?.text ?? "");
    if (byteLength(promptText) > maxInputBytes) {
      throw new AdapterError("provider_error", "Codex current prompt exceeds the configured input capacity");
    }
    let threadId = null;
    if (ctx.sessionState != null) {
      if (typeof ctx.sessionState?.threadId === "string" && ctx.sessionState.threadId) threadId = ctx.sessionState.threadId;
      else ctx.onActivity?.({ phase: "error", label: "session-reset", detail: "Codex session state was invalid and has been reset" });
    }
    try {
      return await runAttempt(ctx, threadId);
    } catch (error) {
      if (!threadId || !error?.missingThread) throw error;
      ctx.onActivity?.({ phase: "error", label: "session-reset", detail: "Codex thread was unavailable and has been reset" });
      return runAttempt(ctx, null);
    }
  }

  function run(ctx) {
    return trackOperation(runInner(ctx));
  }

  async function digestMemoryInner({ account, payload, signal }) {
    assertAccount(account, "executor_unavailable");
    const binary = resolveBinary(account);
    await assertBinary(binary, "executor_unavailable");
    const prompt = `${MEMORY_DIGEST_SYSTEM_PROMPT}\n\n${buildMemoryDigestPrompt(payload)}`;
    if (byteLength(prompt) > maxInputBytes) {
      throw new AdapterError("executor_failed", "Codex memory digest input exceeds the configured capacity");
    }
    const transportSchema = projectCodexDigestSchema(payload?.proposalSchema);
    const directory = await mkdtemp(join(tmpdir(), "vera-codex-digest-"));
    const schemaPath = join(directory, "output-schema.json");
    const outputPath = join(directory, "last-message.json");
    const model = String(account.model ?? "").trim();
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

  async function shutdown() {
    if (!shutdownController.signal.aborted) shutdownController.abort();
    for (const child of active) killProcessTree(child, "SIGTERM");
    await Promise.allSettled([...operations]);
  }

  return { run, digestMemory, shutdown };
}
