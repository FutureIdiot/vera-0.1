import { AdapterError } from "../core/errors.js";
import { killProcessTree, spawnProcess } from "../core/spawn.js";

function compactError(message = "Codex native context compaction failed") {
  return new AdapterError("provider_error", message);
}

export async function compactCodexThread({
  binary,
  threadId,
  cwd,
  sandbox,
  signal,
  timeoutMs,
}) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  timer.unref?.();
  const combined = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  const child = spawnProcess(binary, ["app-server", "--stdio"], {
    cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 1;
  let buffer = "";
  let closed = false;
  let killTimer = null;
  let compactTurnId = null;
  let compactionCompleted = false;
  const pending = new Map();
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  let resolveTerminal;
  let rejectTerminal;
  const terminal = new Promise((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  void terminal.catch(() => {});

  const terminate = () => {
    if (closed || killTimer) return;
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
  const fail = (error) => {
    const normalized = error instanceof AdapterError ? error : compactError();
    for (const request of pending.values()) request.reject(normalized);
    pending.clear();
    rejectTerminal(normalized);
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
      if (!error) return;
      pending.delete(id);
      reject(compactError());
    });
  });
  const onMessage = (message) => {
    if (message && Object.hasOwn(message, "id")) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(compactError());
      else entry.resolve(message.result);
      return;
    }
    if (message?.method === "turn/started" && message.params?.threadId === threadId) {
      compactTurnId = message.params?.turn?.id ?? null;
      return;
    }
    if (message?.method === "item/completed" &&
        message.params?.threadId === threadId &&
        message.params?.item?.type === "contextCompaction") {
      compactTurnId ??= message.params?.turnId ?? null;
      compactionCompleted = true;
      return;
    }
    if (message?.method === "turn/completed" &&
        message.params?.threadId === threadId &&
        message.params?.turn?.id === compactTurnId) {
      if (compactionCompleted && message.params.turn.status === "completed") resolveTerminal();
      else rejectTerminal(compactError());
    }
  };
  const abort = () => {
    fail(new AdapterError(signal?.aborted ? "cancelled" : "timed_out",
      signal?.aborted ? "Codex native context compaction cancelled" : "Codex native context compaction timed out"));
    terminate();
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try { onMessage(JSON.parse(line)); }
      catch {
        fail(compactError());
        terminate();
        break;
      }
    }
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.once("error", () => {
    fail(compactError("Codex app-server is unavailable"));
  });
  child.once("exit", () => {
    closed = true;
    if (killTimer) clearTimeout(killTimer);
    resolveExit();
    fail(compactError());
  });
  combined.addEventListener("abort", abort, { once: true });

  try {
    if (combined.aborted) abort();
    await request("initialize", {
      clientInfo: {
        name: "vera-agent-daemon",
        title: "Vera Agent Daemon",
        version: "0.1.0",
      },
    });
    await request("thread/resume", {
      threadId,
      cwd,
      approvalPolicy: "never",
      sandbox,
    });
    await request("thread/compact/start", { threadId });
    await terminal;
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", abort);
    terminate();
    let cleanupTimer;
    await Promise.race([
      exited,
      new Promise((resolve) => { cleanupTimer = setTimeout(resolve, 750); }),
    ]);
    clearTimeout(cleanupTimer);
  }
}
