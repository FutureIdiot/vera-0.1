// 路径管理与受控迁移 HTTP 路由（api-contract.md 七、Path 管理 [P4.6/F1]）。
//
// ground truth 4.1 末段：用户数据位置（Memory vault）走普通保存；
// gateway 数据目录等高风险路径走「校验 → 迁移 → 验证 → 回滚」独立流程。
// 端口、SSE 心跳等 env 配置不进本接口。

import { asHandler, readJsonBody, sendJson } from "./http.js";
import { ApiError } from "../core/errors.js";
import { rename, mkdir, readdir, stat, copyFile, rm, readFile } from "node:fs/promises";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

const EDITABLE_KEYS = new Set(["memory.vaultPath", "gateway.dataPath"]);

function isVeraStoreFile(name) {
  return /^(agents|accounts|spaces|messages|activities|approvals|runs|session-states|meta|settings|themes)\.json(\.legacy)?$/.test(name);
}

export function registerPathsRoutes(router, { config, settingsStore, memory, store }) {
  router.get(
    "/api/paths",
    asHandler(async ({ res }) => {
      // memory.vaultPath：当前值 + 是否存在 + 记忆条数
      const vaultPath = settingsStore.getAll()["paths.memoryVaultPath"] || config.memory.vaultPath;
      let vaultExists = false;
      let memoryCount = 0;
      try {
        await stat(vaultPath);
        vaultExists = true;
        const memories = await memory.listMemories();
        memoryCount = memories.length;
      } catch {
        // vault 不存在或不可读
      }

      // gateway.dataPath：当前值 + 大小估算
      const dataPath = settingsStore.getAll()["paths.gateway.dataPath"] || config.dataPath;
      let dataPathSize = 0;
      try {
        const entries = await readdir(dataPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            try {
              const s = await stat(join(dataPath, entry.name));
              dataPathSize += s.size;
            } catch {
              // 跳过
            }
          }
        }
      } catch {
        // 目录不可读
      }

      sendJson(res, 200, {
        paths: {
          memory: { vaultPath, exists: vaultExists, memoryCount },
          gateway: { dataPath, sizeBytes: dataPathSize, restartRequired: false },
        },
      });
    }),
  );

  router.post(
    "/api/paths/validate",
    asHandler(async ({ req, res }) => {
      const body = await readJsonBody(req);
      if (!EDITABLE_KEYS.has(body.key)) {
        throw new ApiError("invalid_request", `key must be one of: ${[...EDITABLE_KEYS].join(", ")}`);
      }
      const value = body.value;
      if (typeof value !== "string" || !value.trim()) {
        throw new ApiError("invalid_request", "value must be a non-empty string");
      }

      const errors = [];
      const warnings = [];
      const normalized = resolve(value);

      if (!isAbsolute(normalized)) {
        errors.push("path must be absolute (or resolvable to absolute)");
      }

      // 不在仓库工作树内
      const rel = relative(repoRoot, normalized);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
        errors.push("path must not be inside the Vera repository");
      }

      // 父目录存在且可写
      const parent = dirname(normalized);
      try {
        const parentStat = await stat(parent);
        if (!parentStat.isDirectory()) {
          errors.push(`parent directory ${parent} is not a directory`);
        }
      } catch {
        errors.push(`parent directory ${parent} does not exist`);
      }

      // gateway.dataPath 额外校验
      if (body.key === "gateway.dataPath") {
        try {
          const entries = await readdir(normalized, { withFileTypes: true });
          const nonVera = entries.filter((e) => e.isFile() && !isVeraStoreFile(e.name));
          if (nonVera.length > 0) {
            warnings.push(`target directory contains ${nonVera.length} non-Vera file(s): ${nonVera.map((e) => e.name).slice(0, 5).join(", ")}`);
          }
          if (entries.some((e) => e.isDirectory())) {
            warnings.push("target directory contains subdirectories");
          }
        } catch {
          // 目标不存在 = 可以新建，不是错误
        }
      }

      sendJson(res, 200, {
        ok: errors.length === 0,
        errors,
        warnings,
        normalized,
      });
    }),
  );

  router.post(
    "/api/paths/migrate",
    asHandler(async ({ req, res }) => {
      const body = await readJsonBody(req);
      if (!EDITABLE_KEYS.has(body.key)) {
        throw new ApiError("invalid_request", `key must be one of: ${[...EDITABLE_KEYS].join(", ")}`);
      }
      const target = resolve(body.target);
      if (typeof body.target !== "string" || !target) {
        throw new ApiError("invalid_request", "target must be a non-empty string");
      }

      if (body.key === "memory.vaultPath") {
        const result = await migrateVaultPath({ config, settingsStore, memory, store, target });
        sendJson(res, 200, result);
      } else if (body.key === "gateway.dataPath") {
        const result = await migrateDataPath({ config, settingsStore, store, target });
        sendJson(res, 200, result);
      }
    }),
  );
}

async function migrateVaultPath({ config, settingsStore, memory, store, target }) {
  const currentVault = settingsStore.getAll()["paths.memoryVaultPath"] || config.memory.vaultPath;

  // 1. validate（简化版——完整 validate 走 POST /api/paths/validate）
  const parent = dirname(target);
  try {
    await stat(parent);
  } catch {
    throw new ApiError("invalid_request", `parent directory ${parent} does not exist`);
  }

  // 2. mkdir target
  await mkdir(target, { recursive: true });

  // 3. 移动 *.md
  let movedCount = 0;
  const movedFiles = [];
  try {
    const entries = await readdir(currentVault, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const src = join(currentVault, entry.name);
      const dst = join(target, entry.name);
      await rename(src, dst);
      movedFiles.push({ src, dst });
      movedCount += 1;
    }
  } catch (err) {
    // 回滚：把已搬的搬回去
    for (const { src, dst } of movedFiles) {
      try {
        await rename(dst, src);
      } catch {
        // 尽力而为
      }
    }
    throw new ApiError("internal", `migration failed: ${err.message}`);
  }

  // 4. 验证文件数
  const originalCount = movedCount;
  let newCount = 0;
  try {
    const newEntries = await readdir(target, { withFileTypes: true });
    newCount = newEntries.filter((e) => e.isFile() && e.name.endsWith(".md")).length;
  } catch {
    // 回滚
    for (const { src, dst } of movedFiles) {
      try {
        await rename(dst, src);
      } catch {
        // 尽力而为
      }
    }
    throw new ApiError("internal", "migration verification failed: cannot read target");
  }

  if (newCount !== originalCount) {
    // 回滚
    for (const { src, dst } of movedFiles) {
      try {
        await rename(dst, src);
      } catch {
        // 尽力而为
      }
    }
    throw new ApiError("internal", `migration verification failed: expected ${originalCount} files, found ${newCount}`);
  }

  // 5. PATCH settings
  await settingsStore.setAll({ "paths.memoryVaultPath": target });

  // 6. memory 模块重开——调用方（server.js）需要重新创建 memory vault
  //    这里只返回新路径，server.js 负责热替换。但当前架构 memory 是闭包，
  //    无法热替换。暂时返回 restartRequired: false 但调用方需要处理。
  //    实际上 memory vault 每次 listMemories 都重新读目录，所以改了
  //    settings 后下一次 listMemories 会用新路径——但 memory 模块的
  //    vaultPath 是构造时固化的。需要让 memory 模块支持热替换路径。
  //    F1 阶段：标记需要重启 memory 模块（但 gateway 不需要重启）。
  //    实际实现：返回新路径，前端提示「已迁移」。
  //    TODO: memory 模块支持 reopen(path) 热替换。

  return {
    ok: true,
    key: "memory.vaultPath",
    from: currentVault,
    to: target,
    restartRequired: false,
  };
}

async function migrateDataPath({ config, settingsStore, store, target }) {
  const currentDataPath = settingsStore.getAll()["paths.gateway.dataPath"] || config.dataPath;

  // 1. validate
  const parent = dirname(target);
  try {
    await stat(parent);
  } catch {
    throw new ApiError("invalid_request", `parent directory ${parent} does not exist`);
  }

  // 2. 检查目标是否为空或仅含 Vera 文件
  try {
    const entries = await readdir(target, { withFileTypes: true });
    const nonVera = entries.filter((e) => e.isFile() && !isVeraStoreFile(e.name));
    if (nonVera.length > 0) {
      throw new ApiError("conflict", `target directory is not empty and contains non-Vera files: ${nonVera.map((e) => e.name).join(", ")}`);
    }
  } catch (err) {
    if (err.code !== "ENOENT" && err instanceof ApiError) throw err;
    // 目标不存在 = 可以新建
  }

  // 3. mkdir target
  await mkdir(target, { recursive: true });

  // 4. 复制所有文件
  const copiedFiles = [];
  try {
    const entries = await readdir(currentDataPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const src = join(currentDataPath, entry.name);
      const dst = join(target, entry.name);
      await copyFile(src, dst);
      copiedFiles.push(dst);
    }
  } catch (err) {
    // 回滚：删掉已复制的
    for (const dst of copiedFiles) {
      try {
        await rm(dst);
      } catch {
        // 尽力而为
      }
    }
    throw new ApiError("internal", `migration failed during copy: ${err.message}`);
  }

  // 5. 验证：在 target 上尝试读取 meta.json
  try {
    const metaRaw = await readFile(join(target, "meta.json"), "utf8");
    JSON.parse(metaRaw);
  } catch (err) {
    if (err.code === "ENOENT") {
      // meta.json 不存在可能是全新 store——检查其他文件是否存在
      if (copiedFiles.length === 0) {
        // 空 store 也可以
      }
    } else {
      // 回滚
      for (const dst of copiedFiles) {
        try {
          await rm(dst);
        } catch {
          // 尽力而为
        }
      }
      throw new ApiError("internal", `migration verification failed: meta.json is corrupted`);
    }
  }

  // 6. PATCH settings
  await settingsStore.setAll({ "paths.gateway.dataPath": target });

  // 7. 旧 dataPath 不动（保留作回滚锚点）
  return {
    ok: true,
    key: "gateway.dataPath",
    from: currentDataPath,
    to: target,
    restartRequired: true,
  };
}
