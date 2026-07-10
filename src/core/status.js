// 中控台状态追踪器（api-contract.md 八、中控台 Status API [P4.6/F1]）。
// 进程内存中的运行时状态聚合——不持久化，重启归零。
// recentErrors 是环形缓冲（默认 20 条），收集 ApiError 与其他模块的告警。
//
// setErrorRecorder 模式：asHandler（src/api/http.js）在 catch 里调用
// recordError，不需要改 asHandler 签名或侵入每个 route。

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_RECENT_ERRORS = 20;

let errorRecorder = null;

// 供 asHandler 调用——设置后 recordError 才有效果。
export function setErrorRecorder(recorder) {
  errorRecorder = recorder;
}

// 任何模块都可以调用这个记录错误；recorder 未设时静默丢弃。
export function recordError(scope, code, message) {
  errorRecorder?.(scope, code, message);
}

// 递归计算目录下所有文件总大小（字节）。用于 gateway.dataPath 大小估算。
async function dirSize(dirPath) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(fullPath);
    } else if (entry.isFile()) {
      try {
        const s = await stat(fullPath);
        total += s.size;
      } catch {
        // 单文件读不了跳过
      }
    }
  }
  return total;
}

export function createStatusTracker({ config, pkgVersion = "0.0.1" }) {
  const startedAt = new Date().toISOString();
  const pid = process.pid;
  const recentErrors = [];

  function addError(scope, code, message) {
    recentErrors.push({ ts: new Date().toISOString(), scope, code, message });
    if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.shift();
  }

  // 设置全局 error recorder，让 asHandler 的 catch 能记录到这里
  setErrorRecorder(addError);

  async function getStatus({ store, hub, memory, settingsStore }) {
    const uptimeMs = Date.now() - new Date(startedAt).getTime();

    // store 集合计数
    const collections = {};
    for (const name of ["agents", "accounts", "spaces", "messages", "activities", "approvals", "runs", "themes"]) {
      collections[name] = store.list(name).length;
    }

    // memory vault 状态
    let memoryStatus = { vaultPath: config.memory.vaultPath, vaultExists: false, memoryCount: 0 };
    try {
      const s = await stat(config.memory.vaultPath);
      const memories = await memory.listMemories();
      memoryStatus = { vaultPath: config.memory.vaultPath, vaultExists: s.isDirectory(), memoryCount: memories.length };
    } catch {
      // vault 不存在或不可读
    }

    // dataPath 大小估算（递归）
    const dataPathSize = await dirSize(config.dataPath);

    // accounts presence（联邦前全 offline）
    const accounts = store.list("accounts").map(({ id, owningAgentId, presence, lastSeenAt }) => ({
      accountId: id,
      agentId: owningAgentId,
      presence: presence ?? "offline",
      lastSeenAt: lastSeenAt ?? null,
    }));

    // themes count
    const themesCount = store.list("themes").length;

    return {
      gateway: {
        version: pkgVersion,
        pid,
        startedAt,
        uptimeMs,
        dataPath: config.dataPath,
        dataPathRollbackPending: false,
      },
      sse: {
        currentSeq: hub.currentSeq(),
        bufferSize: config.sse.bufferSize,
        connectedClients: hub.subscriberCount(),
      },
      store: {
        kind: "file",
        collections,
        sessionStates: 0,
        themesCount,
        lastFlushAt: null,
      },
      memory: memoryStatus,
      agents: {
        federation: "disabled",
        onlineAccounts: 0,
        accounts,
      },
      recentErrors: [...recentErrors],
    };
  }

  return { getStatus, addError };
}
