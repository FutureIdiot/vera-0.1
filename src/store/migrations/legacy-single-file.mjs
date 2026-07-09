// 旧单文件 → 分文件迁移的根级协调（store.js 启动加载阶段调）。
//
// 历史（plan.md Phase 2 注 2）：Vera 最早 dataPath 指向单个 store.json（所有
// 集合混存一个 JSON）。Phase 2 改为分文件形态——dataPath 是目录，agents.json /
// spaces.json / … / session-states.json / meta.json 各一文件。本模块负责把
// 旧单文件 adopting 进当前的内存结构，并让位旧文件为 .legacy。
//
// 两类入口：
//   a. dataPath 本身指向已存在的文件（老 env 配置残留）→ 让位 .legacy → 原路径建目录
//   b. dataPath 是目录但里面有 store.json → 让位 store.json.legacy
//
// 崩溃安全（meta.json 在 flush 中最后写）：迁移 a/b 在 rename 之后、分文件
// 写完之前崩溃 → 重启时无 meta.json + .legacy 存在 → 从 .legacy 回灌重迁
// （幂等）。如果目录内同时存在 meta.json 与 store.json 且 _seq 不等（人为
// 恢复备份/rsync 的混合状态）→ 拒绝启动，宁可响亮失败也不让旧单文件静默
// 覆盖较新分文件。
//
// 本模块只负责"单文件→分文件"的根级骨架；agent 连接字段剥离 / session-states
// 键重映射 / seat.accountId 剥离等"分文件内部的 v0→v1 数据形状迁移"在
// agent-account.mjs 里。

import { readFile, writeFile, mkdir, rename, stat, copyFile } from "node:fs/promises";
import { join } from "node:path";

async function readJsonIfExists(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`store 文件损坏（JSON 解析失败）：${path}：${err.message}`);
  }
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export { readJsonIfExists, fileExists };

// 把旧单文件 parsed 整体灌进当前内存 data（按现有 COLLECTIONS 表填字段，
// 缺失字段不动）。不持久化——持久化由调用方 doFlush / markAllDirty + flush。
export function adoptLegacyIntoData(data, parsed, COLLECTIONS) {
  for (const name of COLLECTIONS) {
    if (Array.isArray(parsed[name])) data[name] = parsed[name];
  }
  if (parsed.sessionStates && typeof parsed.sessionStates === "object") {
    data.sessionStates = parsed.sessionStates;
  }
  data._seq = parsed._seq ?? 0;
  data.eventSeqWatermark = parsed.eventSeqWatermark ?? 0;
}

// 探测启动形态：检测 dataPath 是旧单文件、目录里有 store.json、还是崩溃
// 回灌中间态。返回 mode 让 store.js 协调如何调用 adoptLegacyIntoData +
// renameLegacyAside（调用方需要 dataPath 的上下文来报错，所以不在本模块抛
// "混合状态拒绝"的错，返 mode 让调用方根据 mode 决定怎么报错）。
export async function detectLegacySingleFile({ dataPath, fileFor, siblingLegacyPath, storeJsonPath }) {
  let pathStat;
  try {
    pathStat = await stat(dataPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    pathStat = null;
  }

  // a. dataPath 本身是文件（老 env 配置残留）
  if (pathStat?.isFile()) {
    return { mode: "single-file", parsed: await readJsonIfExists(dataPath) };
  }

  if (pathStat?.isDirectory()) {
    const hasMeta = await fileExists(fileFor("meta"));
    const hasStoreJson = await fileExists(storeJsonPath);
    if (hasStoreJson && hasMeta) {
      const meta = await readJsonIfExists(fileFor("meta"));
      const legacyParsed = await readJsonIfExists(storeJsonPath);
      if ((meta?._seq ?? 0) === (legacyParsed?._seq ?? 0)) {
        // 自愈：分文件已完整（meta.json 在场），store.json 还没让位同名—同源
        // 自动补完改名，走常规目录加载
        return { mode: "self-heal-rename", parsed: null };
      }
      // 混合状态拒绝（错误信息由 store.js 拼，它有 dataPath 上下文）
      return { mode: "mixed-state-refuse", parsed: null };
    }
    if (hasStoreJson) {
      return { mode: "dir-store-json", parsed: await readJsonIfExists(storeJsonPath) };
    }
    if (!hasMeta && (await fileExists(siblingLegacyPath))) {
      // 崩溃回灌：rename 完成但分文件没写完——从 .legacy 重灌
      return { mode: "crash-recover-a", parsed: await readJsonIfExists(siblingLegacyPath) };
    }
  } else if (await fileExists(siblingLegacyPath)) {
    // 崩溃回灌更早中间态：rename 完成但 mkdir 都没来得及（dataPath 不存在）
    return { mode: "crash-recover-a-early", parsed: await readJsonIfExists(siblingLegacyPath) };
  }

  return { mode: null, parsed: null };
}

// 让位旧文件为 .legacy（或自愈改名）+ 必要时 mkdir dataPath。依赖 mode
// 决定具体操作。dir-store-json 模式要求调用方先 rebuildFromLegacy 再调
// 这里（rename store.json → store.json.legacy）。
export async function renameLegacyAside({ dataPath, storeJsonPath, siblingLegacyPath, mode }) {
  if (mode === "single-file") {
    await rename(dataPath, siblingLegacyPath);
    await mkdir(dataPath, { recursive: true });
  } else if (mode === "dir-store-json") {
    await rename(storeJsonPath, `${storeJsonPath}.legacy`);
  } else if (mode === "self-heal-rename") {
    await rename(storeJsonPath, `${storeJsonPath}.legacy`);
  } else if (mode === "crash-recover-a" || mode === "crash-recover-a-early") {
    await mkdir(dataPath, { recursive: true });
  }
}