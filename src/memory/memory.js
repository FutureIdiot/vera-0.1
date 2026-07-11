// Agent-scoped Obsidian-compatible Memory vault. The filesystem is the source
// of truth; this module keeps no memory index cache, only the currently active
// vault root so paths can be hot-switched after a verified migration.

import { readFile, writeFile, mkdir, readdir, unlink, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ApiError } from "../core/errors.js";
import { serializeFrontmatter, splitFrontmatter, toIndexEntry } from "./memory-format.js";

const AGENT_ID_PATTERN = /^agt_[a-z0-9]+$/;
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function assertAgentId(agentId) {
  if (typeof agentId !== "string" || !AGENT_ID_PATTERN.test(agentId)) {
    throw new ApiError("invalid_request", `invalid agentId: ${JSON.stringify(agentId)}`);
  }
}

function assertSlug(slug, field = "slug") {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
    throw new ApiError("invalid_request", `${field} must be kebab-case: ${JSON.stringify(slug)}`);
  }
}

function updatedAtSortValue(updatedAt) {
  const time = Date.parse(updatedAt ?? "");
  return Number.isNaN(time) ? 0 : time;
}

export function createMemoryVault({ vaultPath, residentIndexMaxLines = 25 }) {
  let activeVaultPath = resolve(vaultPath);

  const agentPathFor = (agentId) => {
    assertAgentId(agentId);
    return join(activeVaultPath, agentId);
  };
  const filePathFor = (agentId, slug) => join(agentPathFor(agentId), `${slug}.md`);

  async function listMemories(agentId) {
    const agentPath = agentPathFor(agentId);
    let entries;
    try {
      entries = await readdir(agentPath, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    const memories = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try {
        const raw = await readFile(join(agentPath, entry.name), "utf8");
        const { frontmatter } = splitFrontmatter(raw);
        memories.push(toIndexEntry(entry.name.slice(0, -3), frontmatter));
      } catch {
        // A single unreadable file must not hide the rest of the agent vault.
      }
    }
    memories.sort((a, b) => updatedAtSortValue(b.updatedAt) - updatedAtSortValue(a.updatedAt));
    return memories;
  }

  async function saveMemory(agentId, { slug, type, description, content, stains }) {
    assertSlug(slug);
    const filePath = filePathFor(agentId, slug);
    const exists = await readFile(filePath, "utf8").then(
      () => true,
      (err) => (err.code === "ENOENT" ? false : Promise.reject(err)),
    );
    if (exists) throw new ApiError("conflict", `memory ${slug} already exists for agent ${agentId}`);

    const now = new Date().toISOString();
    const meta = { type: type ?? "", description: description ?? "", status: "active", stains: stains ?? {}, createdAt: now, updatedAt: now };
    await mkdir(agentPathFor(agentId), { recursive: true });
    await writeFile(filePath, `${serializeFrontmatter(meta)}\n\n${content ?? ""}\n`, "utf8");
    return { slug, ...meta };
  }

  async function getMemory(agentId, slug) {
    assertSlug(slug);
    let raw;
    try {
      raw = await readFile(filePathFor(agentId, slug), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") throw new ApiError("not_found", `memory ${slug} does not exist for agent ${agentId}`);
      throw err;
    }
    const { frontmatter, body } = splitFrontmatter(raw);
    return { ...toIndexEntry(slug, frontmatter), content: body.replace(/\n$/, "") };
  }

  async function updateMemory(agentId, slug, patch) {
    const current = await getMemory(agentId, slug);
    if (patch.ifMatch !== undefined && patch.ifMatch !== current.updatedAt) {
      const err = new ApiError("conflict", `memory ${slug} was modified since ${patch.ifMatch}`);
      err.current = current;
      throw err;
    }
    if (patch.status !== undefined && !["active", "archived"].includes(patch.status)) {
      throw new ApiError("invalid_request", 'status must be "active" or "archived"');
    }
    const targetSlug = patch.newSlug ?? slug;
    assertSlug(targetSlug, "newSlug");
    if (targetSlug !== slug) {
      const targetExists = await readFile(filePathFor(agentId, targetSlug), "utf8").then(
        () => true,
        (err) => (err.code === "ENOENT" ? false : Promise.reject(err)),
      );
      if (targetExists) throw new ApiError("conflict", `memory ${targetSlug} already exists for agent ${agentId}`);
    }

    const meta = {
      type: patch.type ?? current.type,
      description: patch.description ?? current.description,
      status: patch.status ?? current.status,
      stains: patch.stains ?? current.stains,
      createdAt: current.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const content = patch.content ?? current.content;
    const targetPath = filePathFor(agentId, targetSlug);
    await writeFile(targetPath, `${serializeFrontmatter(meta)}\n\n${content}\n`, "utf8");
    if (targetSlug !== slug) await unlink(filePathFor(agentId, slug));
    return { slug: targetSlug, ...meta };
  }

  async function deleteMemory(agentId, slug) {
    assertSlug(slug);
    try {
      await unlink(filePathFor(agentId, slug));
    } catch (err) {
      if (err.code === "ENOENT") throw new ApiError("not_found", `memory ${slug} does not exist for agent ${agentId}`);
      throw err;
    }
  }

  async function residentIndex(agentId) {
    const active = (await listMemories(agentId)).filter((memory) => memory.status !== "archived");
    if (active.length === 0) return null;
    const lines = active.slice(0, residentIndexMaxLines).map((memory) => `- [[${memory.slug}]] — ${memory.description || "（无钩子行）"}`);
    return [
      `Vera 记忆库常驻索引（文件库：${agentPathFor(agentId)}）：`,
      "相关时用你的文件工具展开 [[slug]] 查看详情。",
      "",
      ...lines,
    ].join("\n");
  }

  async function inspect() {
    let entries;
    try {
      entries = await readdir(activeVaultPath, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return { exists: false, memoryCount: 0, agentDirectoryCount: 0, legacyUnscopedCount: 0 };
      throw err;
    }
    let memoryCount = 0;
    let agentDirectoryCount = 0;
    let legacyUnscopedCount = 0;
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) legacyUnscopedCount += 1;
      if (!entry.isDirectory() || !AGENT_ID_PATTERN.test(entry.name)) continue;
      agentDirectoryCount += 1;
      const files = await readdir(join(activeVaultPath, entry.name), { withFileTypes: true });
      memoryCount += files.filter((file) => file.isFile() && file.name.endsWith(".md")).length;
    }
    return { exists: (await stat(activeVaultPath)).isDirectory(), memoryCount, agentDirectoryCount, legacyUnscopedCount };
  }

  function reopen({ vaultPath: nextVaultPath }) {
    if (typeof nextVaultPath !== "string" || !nextVaultPath.trim()) throw new Error("reopen requires vaultPath");
    activeVaultPath = resolve(nextVaultPath);
    return activeVaultPath;
  }

  return {
    listMemories, saveMemory, getMemory, updateMemory, deleteMemory, residentIndex,
    inspect, reopen, getVaultPath: () => activeVaultPath,
  };
}
