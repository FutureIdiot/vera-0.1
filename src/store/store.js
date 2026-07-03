// JSON 文件存储：启动加载、防抖写盘。集合形状按 api-contract.md 数据形状。
//
// 持久化布局（plan.md Phase 2 注 2）：dataPath 是一个**目录**，目录内按集合
// 分文件——agents.json / spaces.json / … / session-states.json / meta.json，
// 防 memory、profile 等数据增长后混存一个大 JSON。脏跟踪按文件：只重写发生
// 变化的文件（插一条 message 只写 messages.json + meta.json）。
//
// 旧单文件形态启动时自动迁移（只发生一次，legacy 文件保留不删）：
//   a. dataPath 指向已存在的文件 → 改名 <path>.legacy → 原路径建目录 → 写分文件
//   b. dataPath 是目录且内有 store.json → 写分文件 → 改名 store.json.legacy
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

import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

const COLLECTIONS = ["agents", "spaces", "messages", "activities", "approvals", "runs"];

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
    // 响亮失败，且报错带上是哪个文件坏了（裸 SyntaxError 无从排查）
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

export async function createStore({ dataPath, debounceMs = 200 } = {}) {
  if (!dataPath) throw new Error("createStore requires dataPath");

  const data = emptyData();
  const dirty = new Set(); // 待写盘的文件键（FILE_NAMES 的键）
  let writeTimer = null;

  const fileFor = (key) => join(dataPath, FILE_NAMES[key]);

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
    dirty.add(key);
    scheduleSave();
  }

  function markAllDirty() {
    for (const key of Object.keys(FILE_NAMES)) dirty.add(key);
  }

  // 旧单文件（全集合混存一个 JSON）灌进内存结构
  function adoptLegacy(parsed) {
    for (const name of COLLECTIONS) {
      if (Array.isArray(parsed[name])) data[name] = parsed[name];
    }
    if (parsed.sessionStates && typeof parsed.sessionStates === "object") {
      data.sessionStates = parsed.sessionStates;
    }
    data._seq = parsed._seq ?? 0;
    data.eventSeqWatermark = parsed.eventSeqWatermark ?? 0;
  }

  // ---- 启动加载 + 一次性迁移 ----
  const pathStat = await stat(dataPath).catch((err) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });

  // 从旧单文件内容整体重建分文件（迁移 a/b 与崩溃回灌共用）
  async function rebuildFromLegacy(parsed) {
    adoptLegacy(parsed);
    markAllDirty();
    await flush();
  }

  const siblingLegacyPath = `${dataPath}.legacy`; // 迁移 a 的让位文件

  if (pathStat?.isFile()) {
    // 迁移 a：dataPath 本身是旧单文件（老 env 配置残留）。
    // 读 → 原文件让位改名 .legacy → 原路径建目录 → 写分文件。
    const parsed = await readJsonIfExists(dataPath);
    await rename(dataPath, siblingLegacyPath);
    await mkdir(dataPath, { recursive: true });
    await rebuildFromLegacy(parsed);
  } else if (pathStat?.isDirectory()) {
    const storeJsonPath = join(dataPath, "store.json");
    const hasMeta = await fileExists(fileFor("meta"));
    let hasStoreJson = await fileExists(storeJsonPath);

    if (hasStoreJson && hasMeta) {
      // 分文件与旧单文件共存。两种可能：
      //   1. 迁移 b 自身的崩溃窗口——分文件已写完（meta.json 最后写，存在即完整）
      //      但 store.json 还没改名 .legacy。判据：两边 _seq 相等即同源，
      //      安全自动完成迁移（补上改名），走常规目录加载。
      //   2. 人为操作（恢复备份、rsync）产生的混合状态——_seq 不等，
      //      无条件迁移会让旧 store.json 覆盖较新的分文件，拒绝启动人工处置。
      const meta = await readJsonIfExists(fileFor("meta"));
      const legacyParsed = await readJsonIfExists(storeJsonPath);
      if ((meta?._seq ?? 0) === (legacyParsed?._seq ?? 0)) {
        await rename(storeJsonPath, `${storeJsonPath}.legacy`);
        hasStoreJson = false;
      } else {
        throw new Error(
          `store 数据目录 ${dataPath} 内同时存在分文件（meta.json 等）与旧单文件 store.json，` +
            `且两者 _seq 不一致，无法判断哪份是真相。请人工处置：确认要保留哪份数据后，` +
            `删除或移走另一份（保留 store.json 则删分文件走自动迁移；保留分文件则移走 store.json）。`,
        );
      }
    }
    if (hasStoreJson) {
      // 迁移 b：目录里躺着老默认单文件。读 → 写分文件 → 改名 .legacy。
      await rebuildFromLegacy(await readJsonIfExists(storeJsonPath));
      await rename(storeJsonPath, `${storeJsonPath}.legacy`);
    } else if (!hasMeta && (await fileExists(siblingLegacyPath))) {
      // 崩溃回灌（迁移 a 的中间态）：rename 成 .legacy 之后、分文件写完（以
      // meta.json 为完成标记）之前崩溃过。从 .legacy 重迁，幂等。
      await rebuildFromLegacy(await readJsonIfExists(siblingLegacyPath));
    } else {
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
    }
  } else if (await fileExists(siblingLegacyPath)) {
    // 崩溃回灌的更早中间态：迁移 a 在 rename 之后、mkdir 之前崩溃，
    // dataPath 不存在但 .legacy 已让位。同样从 .legacy 重迁。
    await mkdir(dataPath, { recursive: true });
    await rebuildFromLegacy(await readJsonIfExists(siblingLegacyPath));
  }
  // 都不是 → 全新空 store，首次 flush 时 mkdir。

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

  function sessionKey(agentId, spaceId) {
    return `${agentId}:${spaceId}`;
  }

  function getSessionState(agentId, spaceId) {
    return data.sessionStates[sessionKey(agentId, spaceId)] ?? null;
  }

  function setSessionState(agentId, spaceId, sessionState) {
    data.sessionStates[sessionKey(agentId, spaceId)] = sessionState;
    markDirty("sessionStates");
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
    getEventSeqWatermark,
    setEventSeqWatermark,
    flush,
    close,
  };
}
