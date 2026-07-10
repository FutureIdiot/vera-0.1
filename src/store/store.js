// JSON 文件存储：启动加载、防抖写盘。集合形状按 api-contract.md 数据形状。
//
// 持久化布局（plan.md Phase 2 注 2）：dataPath 是一个**目录**，目录内按集合
// 分文件——agents.json / spaces.json / … / session-states.json / meta.json，
// 防 memory、profile 等数据增长后混存一个大 JSON。脏跟踪按文件：只重写发生
// 变化的文件（插一条 message 只写 messages.json + meta.json）。
//
// 迁移拆分在 src/store/migrations/：
//   - legacy-single-file.mjs：旧单文件 → 分文件的根级骨架（a/b 两类入口 +
//     崩溃回灌）；详见该模块顶部注释
//   - agent-account.mjs：分文件数据形状迁移（4.1 agent 连接字段拆 account +
//     session-states 键重映射；4.4 seat.accountId 剥离）；详见该模块顶部注释
// 本文件只保留读写层（集合内存结构 + flush）+ 启动加载协调（按检测结果调用
// 上述两模块的入口）。
//
// 崩溃安全：meta.json 在 flush 中最后写，它的存在即「分文件形态完整」的标记。
//   - 迁移 a 在 rename 之后、分文件写完之前崩溃 → 重启时目录内无 meta.json
//     且 <dataPath>.legacy 存在 → 从 .legacy 回灌重迁（幂等）。
//   - 目录内同时存在 meta.json 与 store.json（人为恢复备份等混合状态）→
//     拒绝启动，宁可响亮失败也不让旧单文件静默覆盖较新的分文件。
//
// 每条记录插入时会附带一个内部 `_seq`（全局单调递增），用于时间线等需要稳定
// 时序的场景；对外输出前调用方需自行剥离（各 domain 模块的 stripInternal）。
// 这是 store 唯一知道的“排序”概念，store 本身不理解 itemType/timeline 语义。

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  readJsonIfExists,
  fileExists,
  adoptLegacyIntoData,
  detectLegacySingleFile,
  renameLegacyAside,
} from "./migrations/legacy-single-file.mjs";
import {
  needsMigration,
  migrateAgentAccountsAndSeats,
  backupSplitFilesAsLegacy,
} from "./migrations/agent-account.mjs";

const COLLECTIONS = ["agents", "accounts", "spaces", "messages", "activities", "approvals", "runs", "themes"];

// 内存键 -> 目录内文件名
const FILE_NAMES = {
  sessionStates: "session-states.json",
  meta: "meta.json",
};
for (const name of COLLECTIONS) FILE_NAMES[name] = `${name}.json`;

function emptyData() {
  const data = { sessionStates: {}, _seq: 0, eventSeqWatermark: 0 };
  for (const name of COLLECTIONS) data[name] = [];
  return data;
}

export async function createStore({ dataPath, debounceMs = 200 } = {}) {
  if (!dataPath) throw new Error("createStore requires dataPath");

  const data = emptyData();
  const dirty = new Set(); // 待写盘的文件键（FILE_NAMES 的键）
  let writeTimer = null;

  const fileFor = (key) => join(dataPath, FILE_NAMES[key]);
  const storeJsonPath = join(dataPath, "store.json");
  const siblingLegacyPath = `${dataPath}.legacy`; // 迁移 a 的让位文件

  function serialize(key) {
    if (key === "meta") return { _seq: data._seq, eventSeqWatermark: data.eventSeqWatermark };
    if (key === "sessionStates") return data.sessionStates;
    return data[key];
  }

  let flushing = null; // 进行中的写盘，串行化 flush/close 的并发窗口

  async function doFlush() {
    // meta.json 必须最后写：它的存在是「分文件完整」的崩溃安全标记
    const keys = [...dirty].sort((a, b) => (a === "meta") - (b === "meta"));
    dirty.clear();
    await mkdir(dataPath, { recursive: true });
    for (const key of keys) {
      await writeFile(fileFor(key), JSON.stringify(serialize(key), null, 2), "utf8");
    }
  }

  async function flush() {
    while (flushing) await flushing.catch(() => {});
    if (dirty.size === 0) return;
    flushing = doFlush();
    try {
      await flushing;
    } finally {
      flushing = null;
    }
  }

  function scheduleSave() {
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      void flush();
    }, debounceMs);
    writeTimer.unref?.();
  }

  function markDirty(key) {
    if (Array.isArray(key)) {
      for (const k of key) dirty.add(k);
    } else {
      dirty.add(key);
    }
    scheduleSave();
  }

  function markAllDirty() {
    for (const key of Object.keys(FILE_NAMES)) dirty.add(key);
  }

  // 旧单文件内容 → adopt 进内存 → 跑 agent/account 数据形状迁移 → 全集合落盘。
  // 迁移 a/b 与崩溃回灌（detectLegacySingleFile 检测出的三类 mode）共用本函数。
  async function rebuildFromLegacy(parsed) {
    adoptLegacyIntoData(data, parsed, COLLECTIONS);
    if (needsMigration({ data })) {
      await migrateAgentAccountsAndSeats({ data, flush, markDirty });
    }
    markAllDirty();
    await flush();
  }

  // ---- 启动加载 + 协调迁移 ----
  const detected = await detectLegacySingleFile({ dataPath, fileFor, siblingLegacyPath, storeJsonPath });

  if (detected.mode === "mixed-state-refuse") {
    throw new Error(
      `store 数据目录 ${dataPath} 内同时存在分文件（meta.json 等）与旧单文件 store.json，` +
        `且两者 _seq 不一致，无法判断哪份是真相。请人工处置：确认要保留哪份数据后，` +
        `删除或移走另一份（保留 store.json 则删分文件走自动迁移；保留分文件则移走 store.json）。`,
    );
  }

  if (detected.mode === "single-file") {
    // 迁移 a：dataPath 本身是旧单文件（老 env 配置残留）。
    // 让位 .legacy → 原路径建目录 → rebuildFromLegacy 写分文件。
    await renameLegacyAside({ dataPath, storeJsonPath, siblingLegacyPath, mode: "single-file" });
    await rebuildFromLegacy(detected.parsed);
  } else if (detected.mode === "dir-store-json") {
    // 迁移 b：目录里躺着老默认单文件。先 rebuildFromLegacy 写分文件 → 再让位 store.json。
    await rebuildFromLegacy(detected.parsed);
    await renameLegacyAside({ dataPath, storeJsonPath, siblingLegacyPath, mode: "dir-store-json" });
  } else if (detected.mode === "crash-recover-a" || detected.mode === "crash-recover-a-early") {
    // 崩溃回灌：rename 之后、分文件没写完（甚至 mkdir 都没到）→ 从 .legacy 重灌重迁。
    await renameLegacyAside({ dataPath, storeJsonPath, siblingLegacyPath, mode: detected.mode });
    await rebuildFromLegacy(detected.parsed);
  } else if (detected.mode === "self-heal-rename") {
    // 自愈：分文件完整、store.json 还没让位同源改名 → 补完改名 → 走常规目录加载。
    await renameLegacyAside({ dataPath, storeJsonPath, siblingLegacyPath, mode: "self-heal-rename" });
    await loadDirectoryRegularly();
  } else if (detected.mode === null) {
    await loadDirectoryRegularly();
  }
  // 都不是 → 全新空 store，首次 flush 时 mkdir。

  async function loadDirectoryRegularly() {
    // 常规目录加载：缺哪个文件哪个集合就用空默认值。
    for (const name of COLLECTIONS) {
      const arr = await readJsonIfExists(fileFor(name));
      if (Array.isArray(arr)) data[name] = arr;
    }
    const sessionStates = await readJsonIfExists(fileFor("sessionStates"));
    if (sessionStates && typeof sessionStates === "object") data.sessionStates = sessionStates;
    const meta = await readJsonIfExists(fileFor("meta"));
    if (meta) {
      data._seq = meta._seq ?? 0;
      data.eventSeqWatermark = meta.eventSeqWatermark ?? 0;
    }
    if (needsMigration({ data })) {
      // 旧分文件已有实际数据，迁移前备份为 .legacy 作回滚锚点（幂等）。
      await backupSplitFilesAsLegacy({
        fileFor,
        keys: ["agents", "accounts", "spaces", "sessionStates", "meta"],
      });
      await migrateAgentAccountsAndSeats({ data, flush, markDirty });
    }
  }

  function assertCollection(name) {
    if (!Array.isArray(data[name])) {
      throw new Error(`unknown store collection: ${name}`);
    }
  }

  function nextSeq() {
    data._seq += 1;
    markDirty("meta");
    return data._seq;
  }

  function list(name) {
    assertCollection(name);
    return data[name];
  }

  function find(name, id) {
    assertCollection(name);
    return data[name].find((item) => item.id === id) ?? null;
  }

  function insert(name, record) {
    assertCollection(name);
    const stamped = { ...record, _seq: nextSeq() };
    data[name].push(stamped);
    markDirty(name);
    return stamped;
  }

  function update(name, id, patch) {
    assertCollection(name);
    const idx = data[name].findIndex((item) => item.id === id);
    if (idx === -1) return null;
    data[name][idx] = { ...data[name][idx], ...patch };
    markDirty(name);
    return data[name][idx];
  }

  function remove(name, id) {
    assertCollection(name);
    const idx = data[name].findIndex((item) => item.id === id);
    if (idx === -1) return false;
    data[name].splice(idx, 1);
    markDirty(name);
    return true;
  }

  function sessionKey(accountId, spaceId) {
    return `${accountId}:${spaceId}`;
  }

  function getSessionState(accountId, spaceId) {
    return data.sessionStates[sessionKey(accountId, spaceId)] ?? null;
  }

  function setSessionState(accountId, spaceId, sessionState) {
    data.sessionStates[sessionKey(accountId, spaceId)] = sessionState;
    markDirty("sessionStates");
  }

  function clearSessionStatesForAccount(accountId) {
    let changed = false;
    for (const key of Object.keys(data.sessionStates)) {
      if (key.startsWith(`${accountId}:`)) {
        delete data.sessionStates[key];
        changed = true;
      }
    }
    if (changed) markDirty("sessionStates");
  }

  // SSE seq 水位（api-contract.md「seq 跨重启单调」）：hub 每次 publish 后回写，
  // 重启时 server 用它算跳跃后的起始 seq。防抖落盘，最后 ~debounceMs 的推进
  // 可能丢失——跳跃量（缓冲长度）覆盖这个误差。
  function getEventSeqWatermark() {
    return data.eventSeqWatermark ?? 0;
  }

  function setEventSeqWatermark(seq) {
    if (seq > (data.eventSeqWatermark ?? 0)) {
      data.eventSeqWatermark = seq;
      markDirty("meta");
    }
  }

  async function close() {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    await flush();
  }

  return {
    list,
    find,
    insert,
    update,
    remove,
    nextSeq,
    getSessionState,
    setSessionState,
    clearSessionStatesForAccount,
    getEventSeqWatermark,
    setEventSeqWatermark,
    flush,
    close,
  };
}