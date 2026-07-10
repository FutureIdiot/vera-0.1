// Memory vault：Obsidian 兼容的 markdown 文件库（api-contract.md Memory 一节，
// 设计背景见 docs/memory-hook.md R1-R6）。文件即真相，本模块只是文件系统的
// 一层薄封装——不维护内存态缓存、不做检索排序，Phase 5 的权重/dream 另起。
//
// frontmatter 是本契约子集的手写 YAML：字符串标量 + 一层嵌套 map（stains），
// 不引入 yaml 依赖。解析容错：字段缺失或整段 frontmatter 缺失都不崩溃。

import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "../core/errors.js";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// 首字符是 YAML indicator 时裸写会被 YAML 读成结构而非字符串（- ? , & * ! 等；
// : " ' # { } [ ] 在任意位置都危险，由下面的字符类单独覆盖）。
const YAML_INDICATOR_FIRST = /^[-?:,[\]{}#&*!|>'"%@`]/;
// 整个值会被 YAML 读成布尔 / 空值的字面量（大小写不敏感，YAML 1.1 口径）。
const YAML_AMBIGUOUS_LITERAL = /^(?:true|false|null|yes|no|~)$/i;

// 需要加引号的标量：含冒号 / 引号 / 换行等控制空白 / 首尾空白 / 空串，
// 首字符为 indicator，或整个值形如布尔 / null / 纯数字——这些裸写进
// frontmatter 会破坏手写解析，或被真 YAML 读者（如 Obsidian）读成别的类型。
// 引号路径走 JSON.stringify，\n 等控制字符由它正确转义，保持单行。
function needsQuoting(value) {
  return (
    value === "" ||
    /[:"'#{}[\]]/.test(value) ||
    /[\n\r\t]/.test(value) ||
    value.trim() !== value ||
    YAML_INDICATOR_FIRST.test(value) ||
    YAML_AMBIGUOUS_LITERAL.test(value) ||
    !Number.isNaN(Number(value))
  );
}

function scalarToYaml(value) {
  const str = value === null || value === undefined ? "" : String(value);
  return needsQuoting(str) ? JSON.stringify(str) : str;
}

function unquote(raw) {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function serializeFrontmatter({ type, description, status, stains, createdAt, updatedAt }) {
  const lines = ["---"];
  lines.push(`type: ${scalarToYaml(type)}`);
  lines.push(`description: ${scalarToYaml(description)}`);
  lines.push(`status: ${scalarToYaml(status)}`);
  const stainEntries = Object.entries(stains ?? {});
  if (stainEntries.length > 0) {
    lines.push("stains:");
    for (const [agentId, hex] of stainEntries) {
      lines.push(`  ${agentId}: ${scalarToYaml(hex)}`);
    }
  } else {
    lines.push("stains: {}");
  }
  // 时间戳由 gateway 生成，固定 ISO 8601 格式，不含需要转义的字符——按契约
  // 示例原样写，不套引号（区别于 type/description，那两个可能来自调用方输入）。
  lines.push(`createdAt: ${createdAt}`);
  lines.push(`updatedAt: ${updatedAt}`);
  lines.push("---");
  return lines.join("\n");
}

function indentOf(line) {
  return line.match(/^\s*/)[0].length;
}

// 手写子集 YAML 解析：顶层 `key: value` 标量 + 一层嵌套 map（本契约仅
// stains 用到嵌套）。任何解析不出来的行直接跳过，不抛错——坏 frontmatter
// 的文件不应该让 listMemories 崩溃。
function parseFrontmatterLines(lines) {
  const result = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || indentOf(line) > 0) {
      i += 1;
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      i += 1;
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();
    if (rest === "{}") {
      result[key] = {};
      i += 1;
      continue;
    }
    if (rest === "") {
      const map = {};
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "" && indentOf(lines[j]) > 0) {
        const subLine = lines[j];
        const subColonIdx = subLine.indexOf(":");
        if (subColonIdx !== -1) {
          const subKey = subLine.slice(0, subColonIdx).trim();
          map[subKey] = unquote(subLine.slice(subColonIdx + 1));
        }
        j += 1;
      }
      result[key] = map;
      i = j;
      continue;
    }
    result[key] = unquote(rest);
    i += 1;
  }
  return result;
}

// 拆出 frontmatter 与正文。缺失 frontmatter（不以 `---` 起始，或没有闭合的
// `---`）时容错：整篇按正文处理，frontmatter 视为空对象。
function splitFrontmatter(raw) {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: raw };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { frontmatter: {}, body: raw };
  }
  const frontmatter = parseFrontmatterLines(lines.slice(1, endIdx));
  const body = lines
    .slice(endIdx + 1)
    .join("\n")
    .replace(/^\n+/, "");
  return { frontmatter, body };
}

function updatedAtSortValue(updatedAt) {
  const t = Date.parse(updatedAt ?? "");
  return Number.isNaN(t) ? 0 : t;
}

export function createMemoryVault({ vaultPath, residentIndexMaxLines = 25 }) {
  function slugFromFilename(filename) {
    return filename.slice(0, -3); // 去掉 .md
  }

  function filePathFor(slug) {
    return join(vaultPath, `${slug}.md`);
  }

  function toIndexEntry(slug, frontmatter) {
    return {
      slug,
      type: frontmatter.type ?? "",
      description: frontmatter.description ?? "",
      status: frontmatter.status ?? "active",
      stains: frontmatter.stains ?? {},
      createdAt: frontmatter.createdAt ?? null,
      updatedAt: frontmatter.updatedAt ?? null,
    };
  }

  // 扫描 vault 下 *.md（不递归），按 updatedAt 降序返回元数据（不含正文）。
  // vault 目录不存在视为空列表，不报错。
  async function listMemories() {
    let entries;
    try {
      entries = await readdir(vaultPath, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }

    const memories = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      let raw;
      try {
        raw = await readFile(join(vaultPath, entry.name), "utf8");
      } catch {
        continue; // 单个文件读不了不影响其余（坏文件容错）
      }
      const { frontmatter } = splitFrontmatter(raw);
      memories.push(toIndexEntry(slugFromFilename(entry.name), frontmatter));
    }

    memories.sort((a, b) => updatedAtSortValue(b.updatedAt) - updatedAtSortValue(a.updatedAt));
    return memories;
  }

  // 手动「保存到记忆」（POST /api/memory）。
  async function saveMemory({ slug, type, description, content, stains }) {
    if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
      throw new ApiError("invalid_request", `slug must be kebab-case: ${JSON.stringify(slug)}`);
    }
    const filePath = filePathFor(slug);
    const exists = await readFile(filePath, "utf8").then(
      () => true,
      (err) => {
        if (err.code === "ENOENT") return false;
        throw err;
      },
    );
    if (exists) {
      throw new ApiError("conflict", `memory ${slug} already exists`);
    }

    const now = new Date().toISOString();
    const meta = {
      type: type ?? "",
      description: description ?? "",
      status: "active",
      stains: stains ?? {},
      createdAt: now,
      updatedAt: now,
    };
    const fileText = `${serializeFrontmatter(meta)}\n\n${content ?? ""}\n`;

    await mkdir(vaultPath, { recursive: true });
    await writeFile(filePath, fileText, "utf8");

    return { slug, ...meta };
  }

  // 取单条完整正文（GET /api/memory/:slug）。
  async function getMemory(slug) {
    if (!SLUG_PATTERN.test(slug)) {
      throw new ApiError("invalid_request", `slug must be kebab-case: ${JSON.stringify(slug)}`);
    }
    let raw;
    try {
      raw = await readFile(filePathFor(slug), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") throw new ApiError("not_found", `memory ${slug} does not exist`);
      throw err;
    }
    const { frontmatter, body } = splitFrontmatter(raw);
    const meta = toIndexEntry(slug, frontmatter);
    return { ...meta, content: body.replace(/\n$/, "") };
  }

  // 编辑已有记忆（PATCH /api/memory/:slug）。
  // 乐观并发：ifMatch 与磁盘 updatedAt 不一致 → 409 附 current 让前端重新加载。
  // newSlug：文件 mv（重命名后双链不自动更新，gateway 不扫描全文替换，保持薄封装）。
  async function updateMemory(slug, patch) {
    if (!SLUG_PATTERN.test(slug)) {
      throw new ApiError("invalid_request", `slug must be kebab-case: ${JSON.stringify(slug)}`);
    }
    let raw;
    try {
      raw = await readFile(filePathFor(slug), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") throw new ApiError("not_found", `memory ${slug} does not exist`);
      throw err;
    }
    const { frontmatter, body } = splitFrontmatter(raw);
    const currentUpdatedAt = frontmatter.updatedAt ?? null;

    // 乐观并发校验
    if (patch.ifMatch !== undefined && patch.ifMatch !== currentUpdatedAt) {
      const currentMeta = toIndexEntry(slug, frontmatter);
      const err = new ApiError("conflict", `memory ${slug} was modified since ${patch.ifMatch}`);
      err.current = { slug, ...currentMeta };
      throw err;
    }

    // 归档状态校验
    if (patch.status !== undefined && !["active", "archived"].includes(patch.status)) {
      throw new ApiError("invalid_request", `status must be "active" or "archived"`);
    }

    const newSlug = patch.newSlug;
    if (newSlug !== undefined) {
      if (!SLUG_PATTERN.test(newSlug)) {
        throw new ApiError("invalid_request", `newSlug must be kebab-case: ${JSON.stringify(newSlug)}`);
      }
      if (newSlug !== slug) {
        const targetExists = await readFile(filePathFor(newSlug), "utf8").then(
          () => true,
          (err) => err.code === "ENOENT" ? false : true,
        );
        if (targetExists) {
          throw new ApiError("conflict", `memory ${newSlug} already exists`);
        }
      }
    }

    const now = new Date().toISOString();
    const meta = {
      type: patch.type !== undefined ? patch.type : (frontmatter.type ?? ""),
      description: patch.description !== undefined ? patch.description : (frontmatter.description ?? ""),
      status: patch.status !== undefined ? patch.status : (frontmatter.status ?? "active"),
      stains: patch.stains !== undefined ? patch.stains : (frontmatter.stains ?? {}),
      createdAt: frontmatter.createdAt ?? now,
      updatedAt: now,
    };
    const content = patch.content !== undefined ? patch.content : body.replace(/\n$/, "");
    const fileText = `${serializeFrontmatter(meta)}\n\n${content}\n`;

    const targetSlug = newSlug && newSlug !== slug ? newSlug : slug;
    await mkdir(vaultPath, { recursive: true });

    if (targetSlug !== slug) {
      // 先写新文件，确认成功后再删旧文件（顺序保证崩溃时不丢数据）
      await writeFile(filePathFor(targetSlug), fileText, "utf8");
      await unlink(filePathFor(slug));
    } else {
      await writeFile(filePathFor(slug), fileText, "utf8");
    }

    return { slug: targetSlug, ...meta };
  }

  // 删除记忆文件（DELETE /api/memory/:slug）。不可逆，前端必须二次确认。
  async function deleteMemory(slug) {
    if (!SLUG_PATTERN.test(slug)) {
      throw new ApiError("invalid_request", `slug must be kebab-case: ${JSON.stringify(slug)}`);
    }
    try {
      await unlink(filePathFor(slug));
    } catch (err) {
      if (err.code === "ENOENT") throw new ApiError("not_found", `memory ${slug} does not exist`);
      throw err;
    }
  }

  // 常驻索引注入块：外部会话首条消息头部用（api-contract.md「常驻索引注入」）。
  // 排除 archived，按 updatedAt 降序截断至 residentIndexMaxLines 行；vault 为
  // 空或全部 archived 时返回 null，表示调用方不应注入任何内容。
  async function residentIndex() {
    const active = (await listMemories()).filter((m) => m.status !== "archived");
    if (active.length === 0) return null;

    const lines = active
      .slice(0, residentIndexMaxLines)
      .map((m) => `- [[${m.slug}]] — ${m.description || "（无钩子行）"}`);

    return [
      `Vera 记忆库常驻索引（文件库：${vaultPath}）：`,
      "相关时用你的文件工具展开 [[slug]] 查看详情。",
      "",
      ...lines,
    ].join("\n");
  }

  return { listMemories, saveMemory, getMemory, updateMemory, deleteMemory, residentIndex };
}
