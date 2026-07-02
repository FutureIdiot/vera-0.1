// spawn 封装：所有 adapter 一律经这里 spawn 子进程，禁止直接 child_process.spawn
// （docs/adapter-interface.md 三、行为规则）。
//
// 落实 salvage-notes.md 第一节第 3 条的 PATH 坑：从 Finder / launchd 启动时
// process.env.PATH 可能只有 /usr/bin:/bin，spawn 任何 Homebrew 安装的 CLI 都会 ENOENT。
// 这里把常见安装目录前置进 PATH，同时保留原有 PATH 内容。
//
// 本次任务没有调用者（mock adapter 是纯 JS，不 spawn 子进程），先建好给后续
// OpenCode / Claude Code adapter 用。

import { spawn } from "node:child_process";

const EXTRA_PATH_DIRS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];

export function buildProcessEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  const existing = (env.PATH || "").split(":").filter(Boolean);
  const merged = [...EXTRA_PATH_DIRS.filter((dir) => !existing.includes(dir)), ...existing];
  env.PATH = merged.join(":");
  return env;
}

// 包装 child_process.spawn：修正 PATH，其余参数透传。
export function spawnProcess(command, args = [], options = {}) {
  const env = buildProcessEnv(options.env);
  return spawn(command, args, { ...options, env });
}

// kill 树：尽力而为，子进程退出收尾用。先礼后兵（SIGTERM 再 SIGKILL），
// 覆盖“子进程自己又 fork 孙进程”的情况用 detached + 进程组场景。
export function killProcessTree(child, signal = "SIGTERM") {
  if (!child || child.killed) return;
  try {
    if (child.pid) {
      // 若 spawn 时传了 detached:true，pid 即进程组 id，用负数 pid 杀整组。
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // 不是进程组 leader 或已退出，退回普通 kill。
  }
  try {
    child.kill(signal);
  } catch {
    // 已经退出，忽略。
  }
}
