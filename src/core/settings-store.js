// 系统设置存储（Phase 4.5 / F1）：直接读写 <dataPath>/settings.json，不进 store.js
// （4.3+4.4 在并行分支动 store.js，本步用独立模块避免冲突）。
//
// 语义（plan.md 4.5 / api-contract.md「配置 [P4]」+ F1 扩 appearance/paths）：
//   - config.js 是启动默认 source（env 派生），settings.json 是运行时覆盖。
//   - getAll() 返回合并视图（overrides 叠 defaults），给前端 GET /api/settings。
//   - get(key) 本步仅返回 overrides[key]（未设则 undefined），不 fallback 到
//     defaults——让 4.6 的 consumer 自己决定用 config 当前值还是快照，保持灵活。
//   - null 语义（F1 / api-contract.md 336）：对已知 key 传 null = 删除 override、
//     恢复 config 默认值。null 不能创建未知 key。
//
// 字段白名单严格遵守 ground truth 4.1 / 4.3 + api-contract.md Appearance/Paths
// 字段清单，不扩；运维参数（端口、数据路径、SSE 心跳/缓冲、store 落盘、daemon
// 回收、run 看门狗）走 env 不进此模块（ground truth 4.1 末段边界）。setAll 按
// 白名单校验，未知 key 或类型不合 → ApiError invalid_request（asHandler 映射 400）。
// 只 persist overrides，不 persist 默认值。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "./errors.js";

// 每个白名单 key 的类型约束。
// type: "enum" 带 values 数组；"number" 可带 min（含）/ exclusiveMin（不含）；
// "string" 仅类型检查。null 对任何已知 key 都是合法值——表示删除 override 恢复
// 默认（api-contract.md 336），validatePatch 跳过类型校验，setAll 删键。
// 新增 key 必须先过 ground truth 4.1/4.3 + api-contract.md 字段清单，不得自行扩。
const ALLOWED_KEYS = {
  // 数据隔离规则（ground truth 4.1「数据隔离规则」）
  "isolation.memory": { type: "enum", values: ["isolated", "globalReadable", "perSpace"] },
  "isolation.files": { type: "enum", values: ["isolated", "specifiedShared", "globalReadable"] },
  "isolation.agentState": { type: "enum", values: ["isolated", "globalVisible"] },
  // 记忆整理（ground truth 4.1「记忆整理」：触发时机 + 注入预算）
  "memory.digestTrigger": { type: "enum", values: ["scheduled", "realtime", "manual"] },
  "memory.digestSchedule": { type: "string" },
  "memory.injectionBudgetResidentLines": { type: "number", min: 0 },
  // 消息呈现（ground truth 4.1「消息呈现」：气泡切分规则）
  "presentation.bubbleBoundaryPattern": { type: "string" },
  "presentation.bubbleMinLength": { type: "number", min: 0 },
  "presentation.bubbleMaxLength": { type: "number", min: 0 },
  // Appearance（ground truth 4.3 / api-contract.md Appearance 字段 [P4.6/F1]）
  "appearance.theme": { type: "enum", values: ["system", "light", "dark", "custom"] },
  "appearance.themeId": { type: "string" },
  "appearance.themeColor": { type: "string" },
  "appearance.accentColor": { type: "string" },
  "appearance.fontFamily": { type: "string" },
  "appearance.fontSize.phone.chat": { type: "number", exclusiveMin: 0 },
  "appearance.fontSize.phone.management": { type: "number", exclusiveMin: 0 },
  "appearance.fontSize.desktop.chat": { type: "number", exclusiveMin: 0 },
  "appearance.fontSize.desktop.management": { type: "number", exclusiveMin: 0 },
  "appearance.bubbleRadius.phone": { type: "number", min: 0 },
  "appearance.bubbleRadius.desktop": { type: "number", min: 0 },
  "appearance.bubbleGap.phone": { type: "number", min: 0 },
  "appearance.bubbleGap.desktop": { type: "number", min: 0 },
  "appearance.windowMargin.phone.chat": { type: "number", min: 0 },
  "appearance.windowMargin.phone.management": { type: "number", min: 0 },
  "appearance.windowMargin.desktop.chat": { type: "number", min: 0 },
  "appearance.windowMargin.desktop.management": { type: "number", min: 0 },
  // 路径（ground truth 4.1 末段 / api-contract.md 七、Path 管理 [P4.6/F1]）
  "paths.memoryVaultPath": { type: "string" },
  "paths.gateway.dataPath": { type: "string" },
};

// 从传入的 config 派生默认值（构造时一次性拍快照）。defaults 不写盘，只用于
// getAll 合并视图。config 仍是启动默认 source，settings 覆盖之。
// appearance.* 从 config.appearance 嵌套对象展平成点分 key（唯一默认源，
// ground truth 4.3 / api-contract.md 352）。
function deriveDefaults(config) {
  const a = config.appearance ?? {};
  const fs = a.fontSize ?? {};
  const br = a.bubbleRadius ?? {};
  const bg = a.bubbleGap ?? {};
  const wm = a.windowMargin ?? {};
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
    "appearance.theme": a.theme ?? "system",
    "appearance.themeId": a.themeId ?? null,
    "appearance.themeColor": a.themeColor ?? "",
    "appearance.accentColor": a.accentColor ?? "",
    "appearance.fontFamily": a.fontFamily ?? "system",
    "appearance.fontSize.phone.chat": fs.phone?.chat ?? 14,
    "appearance.fontSize.phone.management": fs.phone?.management ?? 14,
    "appearance.fontSize.desktop.chat": fs.desktop?.chat ?? 16,
    "appearance.fontSize.desktop.management": fs.desktop?.management ?? 16,
    "appearance.bubbleRadius.phone": br.phone ?? 16,
    "appearance.bubbleRadius.desktop": br.desktop ?? 16,
    "appearance.bubbleGap.phone": bg.phone ?? 4,
    "appearance.bubbleGap.desktop": bg.desktop ?? 10,
    "appearance.windowMargin.phone.chat": wm.phone?.chat ?? 12,
    "appearance.windowMargin.phone.management": wm.phone?.management ?? 12,
    "appearance.windowMargin.desktop.chat": wm.desktop?.chat ?? 64,
    "appearance.windowMargin.desktop.management": wm.desktop?.management ?? 8,
    "paths.memoryVaultPath": config.memory.vaultPath,
    "paths.gateway.dataPath": config.dataPath,
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
      // null = 删除 override 恢复默认（api-contract.md 336），跳过类型校验。
      // setAll 那边负责实际删键。null 不能创建未知 key（上面已挡）。
      if (value === null) continue;
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
        if (spec.min !== undefined && value < spec.min) {
          throw new ApiError("invalid_request", `${key} must be >= ${spec.min}`);
        }
        if (spec.exclusiveMin !== undefined && value <= spec.exclusiveMin) {
          throw new ApiError("invalid_request", `${key} must be > ${spec.exclusiveMin}`);
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
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        // null = 删除 override 恢复默认（api-contract.md 336）
        if (Object.prototype.hasOwnProperty.call(overrides, key)) {
          delete overrides[key];
          changed = true;
        }
      } else {
        overrides[key] = value;
        changed = true;
      }
    }
    if (changed) {
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
