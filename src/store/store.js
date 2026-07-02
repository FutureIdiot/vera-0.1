// JSON 文件存储：启动加载、防抖写盘。集合形状按 api-contract.md 数据形状。
//
// 每条记录插入时会附带一个内部 `_seq`（全局单调递增），用于时间线等需要稳定
// 时序的场景；对外输出前调用方需自行剥离（各 domain 模块的 stripInternal）。
// 这是 store 唯一知道的“排序”概念，store 本身不理解 itemType/timeline 语义。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const COLLECTIONS = ["agents", "spaces", "messages", "activities", "approvals", "runs"];

function emptyData() {
  const data = { sessionStates: {}, _seq: 0 };
  for (const name of COLLECTIONS) data[name] = [];
  return data;
}

export async function createStore({ dataPath, debounceMs = 200 } = {}) {
  if (!dataPath) throw new Error("createStore requires dataPath");

  let data;
  try {
    const raw = await readFile(dataPath, "utf8");
    const parsed = JSON.parse(raw);
    data = { ...emptyData(), ...parsed };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    data = emptyData();
  }

  let writeTimer = null;
  let dirty = false;

  async function flush() {
    if (!dirty) return;
    dirty = false;
    await mkdir(dirname(dataPath), { recursive: true });
    await writeFile(dataPath, JSON.stringify(data, null, 2), "utf8");
  }

  function scheduleSave() {
    dirty = true;
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      void flush();
    }, debounceMs);
    writeTimer.unref?.();
  }

  function assertCollection(name) {
    if (!Array.isArray(data[name])) {
      throw new Error(`unknown store collection: ${name}`);
    }
  }

  function nextSeq() {
    data._seq += 1;
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
    scheduleSave();
    return stamped;
  }

  function update(name, id, patch) {
    assertCollection(name);
    const idx = data[name].findIndex((item) => item.id === id);
    if (idx === -1) return null;
    data[name][idx] = { ...data[name][idx], ...patch };
    scheduleSave();
    return data[name][idx];
  }

  function remove(name, id) {
    assertCollection(name);
    const idx = data[name].findIndex((item) => item.id === id);
    if (idx === -1) return false;
    data[name].splice(idx, 1);
    scheduleSave();
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
    scheduleSave();
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
    flush,
    close,
  };
}
