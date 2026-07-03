// OpenCode daemon adapter（docs/adapter-interface.md 示例 A）。
//
// 架构（salvage-notes.md 第一节第 2 条，实测于 opencode 1.17.9）：
// `opencode serve` 只是状态 + 事件枢纽，不是 LLM 运行器。daemon 常驻管会话
// 状态和全局 SSE（/api/event，按 data.sessionID 路由）；每次 run 起一个短命
// `opencode run --attach` 子进程驱动 LLM loop。
//
// 相比旧 repo 的重写要点（salvage-notes 第四节）：
// - 单例收进工厂闭包，不再用模块级全局变量；
// - abort listener 保存引用、finally 里对称移除（旧代码传新箭头函数等于没移除）；
// - 去掉 `sawAnyTextPart || true` 废弃条件；
// - SSE poller 断线后带延迟自动重连，不再依赖"下一次 acquire 重启"。
//
// 会话连续性：sessionState = { externalSessionId }。无或已失效 → 新建会话 →
// 立即 ctx.persistSessionState() 持久化（防 run 中途崩溃丢 id）；失效重建时
// 通过 onActivity({ phase:"error", label:"session-reset" }) 上报降级，不静默。

import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { access, constants } from "node:fs/promises";

import { AdapterError } from "../core/errors.js";
import { spawnProcess, killProcessTree } from "../core/spawn.js";

const HEALTH_POLL_INTERVAL_MS = 200;
const POLLER_RECONNECT_DELAY_MS = 500;
const POLLER_CONNECT_WAIT_MS = 3000;
const STDOUT_GRACE_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function stripAnsi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

// opencode 的 tool 部件 -> 契约 activity 事件。同一 callId 由 run-controller
// 合并为同一条记录原地更新（pending -> running -> completed/error）。
function mapToolPart(part) {
  const state = part.state || {};
  let detail = state.title || state.input?.command || state.input?.description || state.input?.path || state.input?.pattern || "";
  if (state.status === "completed" && state.output) {
    detail = detail ? `${detail}\n${state.output}` : String(state.output);
  }
  return {
    phase: "tool",
    label: part.tool || "tool",
    detail,
    toolStatus: state.status || "pending",
    callId: part.callID || part.id || null,
  };
}

export function createOpencodeAdapter({ config }) {
  const {
    binary: defaultBinary,
    daemonPort = 0,
    idleShutdownMs = 5 * 60 * 1000,
    watchdogMs = 30 * 60 * 1000,
    // 以下两项主要供测试注入，不走环境变量
    healthCheckTimeoutMs = 5000,
    shutdownGraceMs = 5000,
  } = config;

  let daemon = null; // { child, baseUrl, password, authHeader, pollerAbort, pollerConnected, exitPromise }
  let daemonStarting = null; // 并发首跑只起一个 daemon
  const sessionListeners = new Map(); // sessionID -> (event) => void
  let inFlight = 0;
  let idleTimer = null;

  function resolveBinary(agent) {
    const command = agent?.connection?.command;
    if (command && (command.split("/").pop() || "") === "opencode") return command;
    return defaultBinary;
  }

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleIdleShutdown() {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      if (inFlight === 0) void stopDaemon();
    }, idleShutdownMs);
    idleTimer.unref?.();
  }

  function dispatch(event) {
    const sid = event?.data?.sessionID;
    if (!sid) return;
    const listener = sessionListeners.get(sid);
    if (!listener) return;
    try {
      listener(event);
    } catch {
      // listener 不得把异常抛回流循环
    }
  }

  async function startPoller(handle) {
    const { signal } = handle.pollerAbort;
    while (!signal.aborted) {
      try {
        const resp = await fetch(`${handle.baseUrl}/api/event`, {
          headers: { authorization: handle.authHeader, accept: "text/event-stream" },
          signal,
        });
        if (!resp.ok || !resp.body) throw new Error(`event stream ${resp.status}`);
        handle.markPollerConnected();
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of resp.body) {
          buf += decoder.decode(chunk, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                dispatch(JSON.parse(line.slice(6)));
              } catch {
                // 忽略坏帧
              }
            }
          }
        }
      } catch {
        // 断线/网络错误：延迟后重连（daemon 死掉时 signal 会被 abort，循环退出）
      }
      if (!signal.aborted) await sleep(POLLER_RECONNECT_DELAY_MS);
    }
  }

  async function startDaemon(binary) {
    try {
      await access(binary, constants.X_OK);
    } catch {
      throw new AdapterError("unavailable", `opencode binary not found or not executable: ${binary}`);
    }

    const port = daemonPort || (await pickFreePort());
    const password = randomUUID();
    const baseUrl = `http://127.0.0.1:${port}`;
    const authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

    const child = spawnProcess(binary, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: "opencode" },
    });
    child.unref?.();

    let exited = false;
    const exitPromise = new Promise((resolve) => {
      child.once("exit", () => {
        exited = true;
        resolve();
      });
    });

    // 健康检查轮询（salvage-notes：GET /api/session + basic auth）
    const deadline = Date.now() + healthCheckTimeoutMs;
    let lastErr = "timeout";
    let healthy = false;
    while (Date.now() < deadline && !exited) {
      try {
        const resp = await fetch(`${baseUrl}/api/session`, {
          headers: { authorization: authHeader },
          signal: AbortSignal.timeout(800),
        });
        if (resp.ok) {
          healthy = true;
          break;
        }
        lastErr = `health ${resp.status}`;
      } catch (err) {
        lastErr = err.message;
      }
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }
    if (!healthy) {
      killProcessTree(child, "SIGKILL");
      throw new AdapterError("unavailable", `opencode daemon failed to start: ${lastErr}`);
    }

    let markPollerConnected;
    const pollerConnected = new Promise((resolve) => {
      markPollerConnected = resolve;
    });
    const handle = {
      child,
      baseUrl,
      password,
      authHeader,
      binary,
      pollerAbort: new AbortController(),
      pollerConnected,
      markPollerConnected,
      exitPromise,
    };
    child.once("exit", () => {
      handle.pollerAbort.abort();
      if (daemon === handle) daemon = null;
    });
    void startPoller(handle);
    return handle;
  }

  async function ensureDaemon(binary) {
    clearIdleTimer();
    if (daemon && daemon.child.exitCode === null && !daemon.child.killed) return daemon;
    if (!daemonStarting) {
      daemonStarting = startDaemon(binary).then(
        (handle) => {
          daemon = handle;
          daemonStarting = null;
          return handle;
        },
        (err) => {
          daemonStarting = null;
          throw err;
        },
      );
    }
    return daemonStarting;
  }

  async function stopDaemon() {
    const handle = daemon;
    daemon = null;
    if (!handle) return;
    handle.pollerAbort.abort();
    if (handle.child.exitCode === null && !handle.child.killed) {
      killProcessTree(handle.child, "SIGTERM");
      const force = setTimeout(() => killProcessTree(handle.child, "SIGKILL"), shutdownGraceMs);
      force.unref?.();
      await handle.exitPromise;
      clearTimeout(force);
    }
  }

  async function sessionExists(handle, id) {
    try {
      const resp = await fetch(`${handle.baseUrl}/api/session/${encodeURIComponent(id)}`, {
        headers: { authorization: handle.authHeader },
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async function createSession(handle) {
    let body;
    try {
      const resp = await fetch(`${handle.baseUrl}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: handle.authHeader },
        body: "{}",
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) throw new Error(`${resp.status}`);
      body = await resp.json();
    } catch (err) {
      throw new AdapterError("unavailable", `opencode session create failed: ${err.message}`);
    }
    const id = body?.data?.id ?? body?.id;
    if (!id) throw new AdapterError("unavailable", "opencode session create returned no id");
    return id;
  }

  function buildRunnerArgs(handle, agent, sessionId, promptText) {
    const args = ["run", "--attach", handle.baseUrl, "-u", "opencode", "-p", handle.password];
    const model = String(agent?.model || "").trim();
    if (model) args.push("-m", model);
    const connArgs = Array.isArray(agent?.connection?.args) ? agent.connection.args : [];
    const variantIdx = connArgs.indexOf("--variant");
    if (variantIdx >= 0 && connArgs[variantIdx + 1]) args.push("--variant", String(connArgs[variantIdx + 1]));
    // -s 必须显式传，否则 opencode 用"本项目最后一个会话"，并发会串线（salvage-notes）
    args.push("-c", "-s", sessionId, "--dangerously-skip-permissions");
    args.push(promptText);
    return args;
  }

  async function run(ctx) {
    const { agent, prompt, sessionState, workspacePath, onDelta, onActivity, persistSessionState, signal } = ctx;
    if (signal?.aborted) throw new AdapterError("cancelled", "aborted before start");

    clearIdleTimer();
    inFlight += 1;
    let child = null;
    let watchdogTimer = null;
    let abortHandler = null;
    let sessionId = null;

    try {
      const binary = resolveBinary(agent);
      const handle = await ensureDaemon(binary);
      // 等 poller 连上再投递，避免漏事件；等不到也继续（子进程退出 + stdout 兜底）
      await Promise.race([handle.pollerConnected, sleep(POLLER_CONNECT_WAIT_MS)]);

      // 会话：复用 -> 验证 -> 失效重建（必须上报，不得静默）
      sessionId = sessionState?.externalSessionId ?? null;
      let staleSessionId = null;
      if (sessionId && !(await sessionExists(handle, sessionId))) {
        staleSessionId = sessionId;
        sessionId = null;
      }
      if (!sessionId) {
        sessionId = await createSession(handle);
        persistSessionState?.({ externalSessionId: sessionId });
        if (staleSessionId) {
          onActivity?.({
            phase: "error",
            label: "session-reset",
            detail: `opencode 会话 ${staleSessionId} 已失效（daemon 重启？），已新建 ${sessionId} 继续，上下文从头开始`,
          });
        }
      }

      let cumulativeText = "";
      let sawIdle = false;
      let cancelled = false;
      let settleResolve;
      let settleReject;
      const settled = new Promise((resolve, reject) => {
        settleResolve = resolve;
        settleReject = reject;
      });
      settled.catch(() => {}); // race 输掉的一方的 rejection 不得变成 unhandled

      sessionListeners.set(sessionId, (event) => {
        const data = event.data || {};
        switch (event.type) {
          case "message.part.delta":
            if (data.field === "text" && data.delta) {
              cumulativeText += data.delta;
              onDelta?.(data.delta);
            }
            break;
          case "message.part.updated": {
            const part = data.part || {};
            if (part.type === "tool") onActivity?.(mapToolPart(part));
            break;
          }
          case "session.status":
            // 反复 busy 用同一 callId 合并成一条 working activity，避免刷屏
            if (data.status?.type === "busy") {
              onActivity?.({ phase: "working", label: "opencode", detail: "running", callId: `working-${sessionId}` });
            }
            break;
          case "session.idle":
            sawIdle = true;
            settleResolve();
            break;
          case "session.error":
          case "message.error":
            settleReject(
              new AdapterError("provider_error", `opencode ${event.type}: ${JSON.stringify(data).slice(0, 300)}`),
            );
            break;
          default:
            break;
        }
      });

      // 短命 runner 子进程驱动 LLM loop
      const runnerArgs = buildRunnerArgs(handle, agent, sessionId, prompt.text);
      child = spawnProcess(handle.binary, runnerArgs, {
        cwd: workspacePath || process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: handle.password, OPENCODE_SERVER_USERNAME: "opencode" },
      });
      let stdoutText = "";
      let stderrText = "";
      child.stdout.on("data", (chunk) => {
        stdoutText += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderrText += chunk.toString();
      });

      abortHandler = () => {
        cancelled = true;
        killProcessTree(child, "SIGTERM");
        settleReject(new AdapterError("cancelled", "run cancelled"));
      };
      signal?.addEventListener("abort", abortHandler, { once: true });

      const exitPromise = new Promise((resolve, reject) => {
        child.once("error", (err) => reject(new AdapterError("unavailable", `opencode run spawn failed: ${err.message}`)));
        child.once("exit", (code) => {
          if (cancelled) return; // settled 已被 cancelled 拒绝
          if (code !== 0 && !sawIdle) {
            reject(new AdapterError("provider_error", stderrText.trim() || `opencode run exited with code ${code}`));
          } else {
            resolve();
          }
        });
      });
      exitPromise.catch(() => {});

      watchdogTimer = setTimeout(() => {
        killProcessTree(child, "SIGTERM");
        settleReject(new AdapterError("timed_out", `opencode run timed out after ${watchdogMs}ms`));
      }, watchdogMs);
      watchdogTimer.unref?.();

      // 完成判定：session.idle（settled）或子进程退出，先到先赢；
      // 取消与看门狗都通过 settleReject 走 settled 这条路。
      await Promise.race([settled, exitPromise]);

      // idle 可能先于子进程退出到达：零 delta 需要 stdout 兜底时，
      // 给子进程短暂宽限把最终输出写完，否则兜底值恒为空。
      if (!cumulativeText && child.exitCode === null && !child.killed) {
        const exitedQuietly = new Promise((resolve) => child.once("exit", resolve));
        await Promise.race([exitedQuietly, sleep(STDOUT_GRACE_MS)]);
      }

      const content = (cumulativeText || stripAnsi(stdoutText)).trim();
      return { content, sessionState: { externalSessionId: sessionId } };
    } finally {
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      if (sessionId) sessionListeners.delete(sessionId);
      if (child && child.exitCode === null && !child.killed) killProcessTree(child, "SIGTERM");
      inFlight -= 1;
      if (inFlight === 0) scheduleIdleShutdown();
    }
  }

  async function shutdown() {
    clearIdleTimer();
    await stopDaemon();
  }

  return { run, shutdown };
}
