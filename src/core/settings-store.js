// 系统设置存储（Phase 4.5）：直接读写 <dataPath>/settings.json，不进 store.js
// （4.3+4.4 在并行分支动 store.js，本步用独立模块避免冲突）。
//
// 语义（plan.md 4.5 / api-contract.md「配置 [P4]」）：
//   - config.js 是启动默认 source（env 派生），settings.json 是运行时覆盖。
//   - getAll() 返回合并视图（overrides 叠 defaults），给前端 GET /api/settings。
//   - get(key) 本步仅返回 overrides[key]（未设则 undefined），不 fallback 到
//     defaults——让 4.6 的 consumer 自己决定用 config 当前值还是快照，保持灵活。
//
// 字段白名单严格遵守 ground truth 4.1，不扩；运维参数（端口、数据路径、SSE 心跳/
// 缓冲、store 落盘、daemon 回收、run 看门狗）走 env 不进此模块（ground truth 4.1
// 末段边界）。setAll 按白名单校验，未知 key 或类型不合 → ApiError invalid_request
// （asHandler 映射 400）。只 persist overrides，不 persist 默认值。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "./errors.js";

// 每个白名单 key 的类型约束。type: "enum" 带 values 数组；"number"/"string" 仅类型检查。
// 新增 key 必须先过 ground truth 4.1 + api-contract.md 字段清单，不得自行扩。
const ALLOWED_KEYS = {
  // 数据隔离规则（ground truth 4.1「数据隔离规则」）
  "isolation.memory": { type: "enum", values: ["isolated", "globalReadable", "perSpace"] },
  "isolation.files": { type: "enum", values: ["isolated", "specifiedShared", "globalReadable"] },
  "isolation.agentState": { type: "enum", values: ["isolated", "globalVisible"] },
  // 记忆整理（ground truth 4.1「记忆整理」：触发时机 + 注入预算）
  "memory.digestTrigger": { type: "enum", values: ["scheduled", "realtime", "manual"] },
  "memory.digestSchedule": { type: "string" },
  "memory.injectionBudgetResidentLines": { type: "number" },
  // 消息呈现（ground truth 4.1「消息呈现」：气泡切分规则）
  "presentation.bubbleBoundaryPattern": { type: "string" },
  "presentation.bubbleMinLength": { type: "number" },
  "presentation.bubbleMaxLength": { type: "number" },
};

// 从传入的 config 派生默认值（构造时一次性拍快照）。defaults 不写盘，只用于
// getAll 合并视图。config 仍是启动默认 source，settings 覆盖之。
function deriveDefaults(config) {
  return {
    "isolation.memory": "isolated",
    "isolation.files": "isolated",
    "isolation.agentState": "globalVisible",
    "memory.digestTrigger": "scheduled",
    "memory.digestSchedule": "0 3 * * *",
    "memory.injectionBudgetResidentLines": config.memory.residentIndexMaxLines,
    "presentation.bubbleBoundaryPattern": config.bubbles.boundaryPattern,
    "presentation.bubbleMinLength": config.bubbles.minLength,
    "presentation.bubbleMaxLength": config.bubbles.maxLength,
  };
}

export async function createSettingsStore({ dataPath, config, debounceMs = 200 } = {}) {
  if (!dataPath) throw new Error("createSettingsStore requires dataPath");
  if (!config) throw new Error("createSettingsStore requires config");

  const filePath = join(dataPath, "settings.json");
  const defaults = deriveDefaults(config);
  let overrides = {};
  let writeTimer = null;
  let dirty = false;
  let flushing = null;

  async function readFromDisk() {
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return {};
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      // 解析失败静默返空（方案要求：文件不存在或解析失败返默认对象）
      return {};
    }
  }

  async function load() {
    const parsed = await readFromDisk();
    // 只认白名单 key，磁盘被人塞脏数据不进内存
    overrides = {};
    for (const key of Object.keys(ALLOWED_KEYS)) {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) {
        overrides[key] = parsed[key];
      }
    }
    return getAll();
  }

  function get(key) {
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_KEYS, key)) return undefined;
    return Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : undefined;
  }

  function getAll() {
    const merged = {};
    for (const key of Object.keys(ALLOWED_KEYS)) {
      merged[key] = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : defaults[key];
    }
    return merged;
  }

  function validatePatch(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const spec = ALLOWED_KEYS[key];
      if (!spec) {
        throw new ApiError("invalid_request", `unknown setting key: ${key}`);
      }
      if (spec.type === "enum") {
        if (!spec.values.includes(value)) {
          throw new ApiError(
            "invalid_request",
            `invalid value for ${key}: expected one of ${spec.values.join(", ")}`,
          );
        }
      } else if (spec.type === "number") {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new ApiError("invalid_request", `${key} must be a finite number`);
        }
      } else if (spec.type === "string") {
        if (typeof value !== "string") {
          throw new ApiError("invalid_request", `${key} must be a string`);
        }
      }
    }
  }

  async function doFlush() {
    await mkdir(dataPath, { recursive: true });
    await writeFile(filePath, JSON.stringify(overrides, null, 2), "utf8");
  }

  async function flush() {
    while (flushing) await flushing.catch(() => {});
    if (!dirty) return;
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

  async function setAll(patch) {
    validatePatch(patch);
    if (Object.keys(patch).length > 0) {
      for (const [key, value] of Object.entries(patch)) {
        overrides[key] = value;
      }
      dirty = true;
      scheduleSave();
    }
    return getAll();
  }

  async function close() {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    await flush();
  }

  await load();

  return { load, get, getAll, setAll, close };
}
