import { access, constants } from "node:fs/promises";
import { basename } from "node:path";

import { AdapterError } from "../core/errors.js";
import { killProcessTree, spawnProcess } from "../core/spawn.js";

function missingSession(stderr) {
  return /(?:session|conversation).{0,80}(?:not found|does not exist|unknown|invalid)/iu.test(stderr);
}

function textContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === "string" ? item : item?.text ?? item?.content ?? "")
      .filter(Boolean)
      .join("\n");
  }
  return value == null ? "" : JSON.stringify(value);
}

export function createClaudeCodeAdapter({ config = {} } = {}) {
  const {
    binary: defaultBinary = "claude",
    watchdogMs = 30 * 60 * 1000,
    permissionMode = "auto",
  } = config;
  const shutdownController = new AbortController();
  const active = new Set();

  function assertRuntime(runtime) {
    if (runtime?.kind !== "cli" || runtime?.provider !== "claude-code") {
      throw new AdapterError("unavailable", "Claude Code adapter runtime kind/provider mismatch");
    }
    if (runtime.connection?.secretRef != null) {
      throw new AdapterError("unavailable", "Claude Code runtime secretRef is not supported");
    }
    if (Array.isArray(runtime.connection?.args) && runtime.connection.args.length) {
      throw new AdapterError("unavailable", "Claude Code runtime connection args are not supported");
    }
    const command = String(runtime.connection?.command ?? "").trim();
    if (command && basename(command) !== "claude") {
      throw new AdapterError("unavailable", "Claude Code runtime command is invalid");
    }
  }

  async function runAttempt(ctx, providerBinding) {
    const binary = String(ctx.runtime.connection?.command ?? "").trim() || defaultBinary;
    if (binary.includes("/")) {
      try { await access(binary, constants.X_OK); }
      catch { throw new AdapterError("unavailable", "Claude Code CLI is unavailable"); }
    }
    const priorSessionId = providerBinding?.providerState?.sessionId ?? null;
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode", permissionMode,
    ];
    if (priorSessionId) args.push("--resume", priorSessionId);
    const model = String(ctx.runtime.model ?? "").trim();
    if (model) args.push("--model", model);

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), watchdogMs);
    timer.unref?.();
    const signal = AbortSignal.any([ctx.signal, timeout.signal, shutdownController.signal].filter(Boolean));
    const child = spawnProcess(binary, args, {
      cwd: ctx.workspacePath || process.cwd(),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    active.add(child);
    let stderr = "";
    let buffer = "";
    let content = "";
    let sessionId = priorSessionId;
    let savedBinding = providerBinding;
    let persistPromise = null;
    let eventError = null;
    let sawThinkingStream = false;
    let fullThinkingCount = 0;
    const toolState = new Map();
    const toolByIndex = new Map();
    const thinkingState = new Map();

    function persist(nextSessionId) {
      if (ctx.sessionMode === "isolated" || !nextSessionId || nextSessionId === priorSessionId || persistPromise) return;
      persistPromise = Promise.resolve(ctx.persistProviderBinding?.(
        { sessionId: nextSessionId },
        providerBinding?.version ?? null,
      )).then((saved) => { savedBinding = saved ?? null; });
    }

    function emitTool(callId, patch = {}) {
      const previous = toolState.get(callId) ?? { name: "tool", input: "", output: "", status: "pending" };
      const next = { ...previous, ...patch };
      toolState.set(callId, next);
      ctx.onActivity?.({
        phase: "tool",
        label: next.name,
        summary: `${next.name} · ${next.status}`,
        detail: [next.input, next.output].filter(Boolean).join("\n"),
        toolStatus: next.status,
        callId,
      });
    }

    function emitThinking(callId, delta) {
      const detail = `${thinkingState.get(callId) ?? ""}${delta ?? ""}`;
      thinkingState.set(callId, detail);
      ctx.onActivity?.({
        phase: "thinking",
        label: "Thinking",
        summary: "正在思考",
        detail,
        callId,
      });
    }

    function consumeMessage(event) {
      const nextSessionId = event?.session_id;
      if (typeof nextSessionId === "string" && nextSessionId) {
        sessionId = nextSessionId;
        persist(nextSessionId);
      }
      if (event?.type === "stream_event") {
        const stream = event.event ?? {};
        const index = stream.index ?? 0;
        const block = stream.content_block;
        if (stream.type === "content_block_start" && block?.type === "tool_use") {
          toolByIndex.set(index, block.id);
          emitTool(block.id, {
            name: block.name || "tool",
            input: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : "",
            status: "running",
          });
        } else if (stream.type === "content_block_delta" && stream.delta?.type === "text_delta") {
          const delta = stream.delta.text ?? "";
          if (delta) {
            content += delta;
            ctx.onDelta?.(delta);
          }
        } else if (stream.type === "content_block_delta" && stream.delta?.type === "thinking_delta") {
          sawThinkingStream = true;
          emitThinking(`thinking-${sessionId ?? "new"}-${index}`, stream.delta.thinking ?? "");
        } else if (stream.type === "content_block_delta" && stream.delta?.type === "input_json_delta") {
          const call = toolByIndex.get(index);
          if (call) emitTool(call, { input: `${toolState.get(call)?.input ?? ""}${stream.delta.partial_json ?? ""}` });
        }
        return;
      }
      if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block?.type === "text" && !content && block.text) {
            content += block.text;
            ctx.onDelta?.(block.text);
          } else if (block?.type === "thinking" && block.thinking && !sawThinkingStream) {
            fullThinkingCount += 1;
            const callId = `thinking-${sessionId ?? "new"}-full-${fullThinkingCount}`;
            if (!thinkingState.has(callId)) emitThinking(callId, block.thinking);
          } else if (block?.type === "tool_use" && block.id) {
            emitTool(block.id, {
              name: block.name || "tool",
              input: JSON.stringify(block.input ?? {}),
              status: "running",
            });
          }
        }
      } else if (event?.type === "user" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block?.type !== "tool_result" || !block.tool_use_id) continue;
          emitTool(block.tool_use_id, {
            output: textContent(block.content),
            status: block.is_error ? "failed" : "completed",
          });
        }
      } else if (event?.type === "result" && event.is_error) {
        throw new AdapterError("provider_error", "Claude Code execution failed");
      } else if (event?.type === "result" && !content && typeof event.result === "string") {
        content = event.result;
        ctx.onDelta?.(event.result);
      }
    }

    const terminate = () => killProcessTree(child, "SIGTERM");
    signal.addEventListener("abort", terminate, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try { consumeMessage(JSON.parse(line)); }
        catch (error) {
          eventError = error;
          terminate();
          break;
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { if (stderr.length < 8000) stderr += chunk.slice(0, 8000 - stderr.length); });
    child.stdin.on("error", () => {});
    child.stdin.end(String(ctx.prompt?.text ?? ""));

    try {
      const exit = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code));
      });
      const tail = buffer.trim();
      if (tail && !eventError) consumeMessage(JSON.parse(tail));
      if (ctx.signal?.aborted || shutdownController.signal.aborted) {
        throw new AdapterError("cancelled", "Claude Code run cancelled");
      }
      if (timeout.signal.aborted) throw new AdapterError("timed_out", "Claude Code run timed out");
      if (eventError) throw eventError;
      if (exit !== 0) {
        const error = new AdapterError("provider_error", "Claude Code execution failed");
        error.missingSession = missingSession(stderr);
        throw error;
      }
      await persistPromise;
      if (!sessionId) throw new AdapterError("provider_error", "Claude Code did not return a session id");
      return savedBinding ? { content, providerBinding: savedBinding } : { content };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("unavailable", "Claude Code CLI is unavailable");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", terminate);
      active.delete(child);
    }
  }

  async function run(ctx) {
    assertRuntime(ctx.runtime);
    let providerBinding = ctx.sessionMode === "isolated" ? null : ctx.providerBinding;
    if (providerBinding != null && (
      !Number.isInteger(providerBinding.version) || providerBinding.version < 1 ||
      typeof providerBinding.providerState?.sessionId !== "string"
    )) {
      ctx.onActivity?.({
        phase: "error",
        label: "session-reset",
        summary: "Claude Code 会话已重置",
        detail: "Claude Code provider binding was invalid and has been reset",
      });
      const rotated = await ctx.rotateProviderBinding?.({ reason: "invalid" });
      providerBinding = rotated?.providerBinding ?? null;
      ctx = { ...ctx, prompt: rotated?.prompt ?? ctx.prompt };
    }
    try {
      return await runAttempt(ctx, providerBinding);
    } catch (error) {
      if (!providerBinding || !error?.missingSession) throw error;
      ctx.onActivity?.({
        phase: "error",
        label: "session-reset",
        summary: "Claude Code 会话已重置",
        detail: "Claude Code session was unavailable and has been reset",
      });
      const rotated = await ctx.rotateProviderBinding?.({ reason: "missing" });
      return runAttempt({ ...ctx, prompt: rotated?.prompt ?? ctx.prompt }, rotated?.providerBinding ?? null);
    }
  }

  async function shutdown() {
    if (shutdownController.signal.aborted) return;
    shutdownController.abort();
    for (const child of active) killProcessTree(child, "SIGTERM");
  }

  return { run, shutdown };
}
