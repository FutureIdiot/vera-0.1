import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile, stat, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../src/store/store.js";

// dataPath 语义是目录。这里刻意用尚不存在的子目录，顺带覆盖首次 flush 自动建目录。
async function withTempDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "vera-store-test-"));
  const dataPath = join(dir, "data");
  try {
    await fn(dataPath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("insert/find/update/remove round-trip in memory", async () => {
  await withTempDataDir(async (dataPath) => {
    const store = await createStore({ dataPath, debounceMs: 10 });
    const agent = store.insert("agents", { id: "agt_1", name: "Iota" });
    assert.equal(store.find("agents", "agt_1").name, "Iota");
    assert.ok(typeof agent._seq === "number");

    store.update("agents", "agt_1", { name: "Iota2" });
    assert.equal(store.find("agents", "agt_1").name, "Iota2");

    const removed = store.remove("agents", "agt_1");
    assert.equal(removed, true);
    assert.equal(store.find("agents", "agt_1"), null);
    await store.close();
  });
});

test("persists split files to the data dir and reloads on next createStore call", async () => {
  await withTempDataDir(async (dataPath) => {
    const store = await createStore({ dataPath, debounceMs: 10 });
    store.insert("spaces", { id: "spc_1", name: "vera-dev" });
    // session-states 键按 (accountId, spaceId) 存（4.1 起），用 acc_ 前缀避免
    // 触发启动迁移把 agt_ 键重映射到 acc_。
    store.setSessionState("acc_1", "spc_1", { count: 7 });
    store.setEventSeqWatermark(123);
    await store.close(); // flush

    assert.ok(await exists(join(dataPath, "spaces.json")), "spaces.json should be written");
    assert.ok(await exists(join(dataPath, "session-states.json")));
    assert.ok(await exists(join(dataPath, "meta.json")));

    const reloaded = await createStore({ dataPath, debounceMs: 10 });
    const found = reloaded.find("spaces", "spc_1");
    assert.ok(found, "space should survive reload");
    assert.equal(found.name, "vera-dev");
    assert.deepEqual(reloaded.getSessionState("acc_1", "spc_1"), { count: 7 });
    assert.equal(reloaded.getEventSeqWatermark(), 123);
    await reloaded.close();
  });
});

test("sessionState get/set is per (agentId, spaceId)", async () => {
  await withTempDataDir(async (dataPath) => {
    const store = await createStore({ dataPath, debounceMs: 10 });
    assert.equal(store.getSessionState("agt_1", "spc_1"), null);

    store.setSessionState("agt_1", "spc_1", { count: 1 });
    store.setSessionState("agt_1", "spc_2", { count: 99 });

    assert.deepEqual(store.getSessionState("agt_1", "spc_1"), { count: 1 });
    assert.deepEqual(store.getSessionState("agt_1", "spc_2"), { count: 99 });
    await store.close();
  });
});

test("_seq is monotonically increasing across collections", async () => {
  await withTempDataDir(async (dataPath) => {
    const store = await createStore({ dataPath, debounceMs: 10 });
    const a = store.insert("messages", { id: "msg_1" });
    const b = store.insert("activities", { id: "act_1" });
    const c = store.insert("messages", { id: "msg_2" });
    assert.ok(a._seq < b._seq);
    assert.ok(b._seq < c._seq);
    await store.close();
  });
});

// ---- 迁移 ----

const LEGACY_CONTENT = {
  agents: [{ id: "agt_old", name: "Iota", _seq: 1 }],
  spaces: [],
  messages: [{ id: "msg_old", spaceId: "spc_x", content: "老数据", _seq: 2 }],
  activities: [],
  approvals: [],
  runs: [],
  sessionStates: { "agt_old:spc_x": { externalSessionId: "ses_legacy" } },
  _seq: 5,
  eventSeqWatermark: 42,
};

test("migration a: dataPath pointing at a legacy single file becomes a split dir", async () => {
  await withTempDataDir(async (_unused, dir) => {
    const dataPath = join(dir, "olddata.json"); // 老 env 配置残留：直接指向文件
    await writeFile(dataPath, JSON.stringify(LEGACY_CONTENT), "utf8");

    const store = await createStore({ dataPath, debounceMs: 10 });

    // 老数据完整迁入
    assert.equal(store.find("agents", "agt_old").name, "Iota");
    assert.equal(store.find("messages", "msg_old").content, "老数据");
    // 4.1 起 session-states 键按 (accountId, spaceId) 存，启动迁移把 agt_old
    // 重映射到派生 account id acc_old（deriveOwningAccountId）。
    assert.deepEqual(store.getSessionState("acc_old", "spc_x"), { externalSessionId: "ses_legacy" });
    assert.equal(store.getEventSeqWatermark(), 42);
    assert.equal(store.insert("runs", { id: "run_new" })._seq, 6, "_seq 从旧值继续");

    // 磁盘布局：原文件让位成 .legacy，原路径变目录 + 分文件
    const legacyStat = await stat(`${dataPath}.legacy`);
    assert.ok(legacyStat.isFile(), "原单文件应改名为 <path>.legacy 保留");
    const dirStat = await stat(dataPath);
    assert.ok(dirStat.isDirectory(), "dataPath 原路径应变为目录");
    assert.ok(await exists(join(dataPath, "agents.json")));
    assert.ok(await exists(join(dataPath, "meta.json")));

    await store.close();

    // 重启走常规目录加载，不再触发迁移
    const reloaded = await createStore({ dataPath, debounceMs: 10 });
    assert.equal(reloaded.find("agents", "agt_old").name, "Iota");
    assert.ok(reloaded.find("runs", "run_new"), "迁移后新写入的数据也在");
    await reloaded.close();
  });
});

test("migration b: store.json inside the data dir is split and renamed .legacy", async () => {
  await withTempDataDir(async (dataPath) => {
    await mkdir(dataPath, { recursive: true });
    await writeFile(join(dataPath, "store.json"), JSON.stringify(LEGACY_CONTENT), "utf8");

    const store = await createStore({ dataPath, debounceMs: 10 });

    assert.equal(store.find("agents", "agt_old").name, "Iota");
    assert.equal(store.getEventSeqWatermark(), 42);

    assert.ok(!(await exists(join(dataPath, "store.json"))), "store.json 应已改名");
    assert.ok(await exists(join(dataPath, "store.json.legacy")), "legacy 文件保留不删");
    assert.ok(await exists(join(dataPath, "messages.json")));

    const persistedAgents = JSON.parse(await readFile(join(dataPath, "agents.json"), "utf8"));
    assert.equal(persistedAgents[0].id, "agt_old");

    await store.close();

    const reloaded = await createStore({ dataPath, debounceMs: 10 });
    assert.equal(reloaded.find("messages", "msg_old").content, "老数据");
    assert.ok(await exists(join(dataPath, "store.json.legacy")), "重启不重复迁移、不动 legacy");
    await reloaded.close();
  });
});

test("migration a crash-safety: legacy renamed but split files unwritten is re-adopted on restart", async () => {
  await withTempDataDir(async (_unused, dir) => {
    const dataPath = join(dir, "olddata.json");
    // 模拟迁移 a 的崩溃中间态：rename 已完成（.legacy 就位）、目录已建、
    // 分文件一个都没写（无 meta.json 完成标记）
    await writeFile(`${dataPath}.legacy`, JSON.stringify(LEGACY_CONTENT), "utf8");
    await mkdir(dataPath, { recursive: true });

    const store = await createStore({ dataPath, debounceMs: 10 });
    assert.equal(store.find("agents", "agt_old").name, "Iota", "数据应从 .legacy 回灌，不得判成全新空 store");
    assert.equal(store.getEventSeqWatermark(), 42);
    assert.ok(await exists(join(dataPath, "meta.json")), "回灌重迁后分文件应完整");
    assert.ok(await exists(`${dataPath}.legacy`), "legacy 保留不删");
    await store.close();

    // 更早的中间态：rename 完成但 mkdir 都没来得及（dataPath 不存在）
    const dataPath2 = join(dir, "olddata2.json");
    await writeFile(`${dataPath2}.legacy`, JSON.stringify(LEGACY_CONTENT), "utf8");
    const store2 = await createStore({ dataPath: dataPath2, debounceMs: 10 });
    assert.equal(store2.find("messages", "msg_old").content, "老数据");
    await store2.close();
  });
});

test("mixed state: split files + store.json coexisting refuses to start and touches nothing", async () => {
  await withTempDataDir(async (dataPath) => {
    // 先造出一份合法的分文件形态（较新的真相）
    const store = await createStore({ dataPath, debounceMs: 10 });
    store.insert("agents", { id: "agt_newer", name: "较新的数据" });
    await store.close();
    const agentsBefore = await readFile(join(dataPath, "agents.json"), "utf8");

    // 人为把旧备份 store.json 放进来（恢复备份/rsync 的混合状态）
    await writeFile(join(dataPath, "store.json"), JSON.stringify(LEGACY_CONTENT), "utf8");

    await assert.rejects(
      () => createStore({ dataPath, debounceMs: 10 }),
      (err) => {
        assert.match(err.message, /同时存在/, "报错应说明混合状态");
        assert.match(err.message, /store\.json/);
        assert.match(err.message, /人工处置/);
        return true;
      },
    );

    // 分文件与 store.json 都原样未动
    const agentsAfter = await readFile(join(dataPath, "agents.json"), "utf8");
    assert.equal(agentsAfter, agentsBefore, "拒绝启动时不得动分文件");
    assert.ok(await exists(join(dataPath, "store.json")), "store.json 不得被改名或删除");
    assert.ok(!(await exists(join(dataPath, "store.json.legacy"))), "不得触发迁移");
  });
});

test("migration b crash-safety: split files complete but store.json not renamed self-heals on restart", async () => {
  await withTempDataDir(async (dataPath) => {
    await mkdir(dataPath, { recursive: true });
    await writeFile(join(dataPath, "store.json"), JSON.stringify(LEGACY_CONTENT), "utf8");

    // 正常跑完迁移 b 后把 .legacy 改回 store.json，精确复现崩溃窗口：
    // 分文件已写完（meta.json 在场）、store.json 还没让位改名
    const store = await createStore({ dataPath, debounceMs: 10 });
    await store.close();
    await rename(join(dataPath, "store.json.legacy"), join(dataPath, "store.json"));

    // _seq 同源（meta.json 与 store.json 相等）→ 自愈补完改名，正常启动
    const reloaded = await createStore({ dataPath, debounceMs: 10 });
    assert.equal(reloaded.find("agents", "agt_old").name, "Iota", "同源共存应自愈启动而非拒绝");
    assert.equal(reloaded.getEventSeqWatermark(), 42);
    await reloaded.close();

    assert.ok(!(await exists(join(dataPath, "store.json"))), "自愈应把 store.json 改名让位");
    assert.ok(await exists(join(dataPath, "store.json.legacy")), "legacy 保留不删");
  });
});

test("corrupt split file fails loudly with the file path in the error", async () => {
  await withTempDataDir(async (dataPath) => {
    const store = await createStore({ dataPath, debounceMs: 10 });
    store.insert("agents", { id: "agt_1" });
    await store.close();

    await writeFile(join(dataPath, "agents.json"), "{oops not json", "utf8");
    await assert.rejects(
      () => createStore({ dataPath, debounceMs: 10 }),
      (err) => {
        assert.match(err.message, /agents\.json/, "报错必须带上损坏文件的路径");
        assert.match(err.message, /损坏|JSON/);
        return true;
      },
    );
  });
});

// ---- 脏跟踪按文件 ----

test("dirty tracking: inserting an agent writes only agents.json and meta.json", async () => {
  await withTempDataDir(async (dataPath) => {
    const store = await createStore({ dataPath, debounceMs: 10 });
    store.insert("agents", { id: "agt_1", name: "Iota" });
    await store.close(); // flush 脏文件

    assert.ok(await exists(join(dataPath, "agents.json")), "agents.json 应被写");
    assert.ok(await exists(join(dataPath, "meta.json")), "meta.json（_seq 变了）应被写");
    assert.ok(!(await exists(join(dataPath, "messages.json"))), "messages.json 不该被写");
    assert.ok(!(await exists(join(dataPath, "session-states.json"))), "session-states.json 不该被写");

    // 再验证一次增量：只动 message，不应重写 agents.json
    const store2 = await createStore({ dataPath, debounceMs: 10 });
    const agentsStatBefore = await stat(join(dataPath, "agents.json"));
    store2.insert("messages", { id: "msg_1", content: "hi" });
    await store2.close();
    const agentsStatAfter = await stat(join(dataPath, "agents.json"));
    assert.equal(agentsStatBefore.mtimeMs, agentsStatAfter.mtimeMs, "未变的 agents.json 不应被重写");
    assert.ok(await exists(join(dataPath, "messages.json")));
  });
});
