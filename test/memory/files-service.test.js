import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig } from "../../src/core/config.js";
import { createSettingsStore } from "../../src/core/settings-store.js";
import { createStore } from "../../src/store/store.js";
import { createFilesService, normalizeFileMime } from "../../src/memory/files-service.js";
import { migrateFilesPath } from "../../src/api/path-migrations.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vera-files-service-"));
  const config = loadConfig({
    VERA_DATA_PATH: join(root, "data"),
    VERA_MEMORY_VAULT_PATH: join(root, "memory"),
    VERA_FILES_ATTACHMENTS_PATH: join(root, "files"),
  });
  const store = await createStore({ dataPath: config.dataPath, debounceMs: 1 });
  const settingsStore = await createSettingsStore({ dataPath: config.dataPath, config, debounceMs: 1 });
  const files = await createFilesService({
    store,
    settingsStore,
    rootPath: config.files.attachmentsPath,
    maxUploadBytes: 1024,
    maxAttachmentsPerMessage: 4,
  });
  store.insert("spaces", {
    id: "spc_owner",
    name: "Owner",
    seats: [{ agentId: "agt_one" }],
    archivedAt: null,
    createdAt: new Date().toISOString(),
  });
  store.insert("spaces", {
    id: "spc_shared",
    name: "Shared",
    seats: [{ agentId: "agt_one" }],
    archivedAt: null,
    createdAt: new Date().toISOString(),
  });
  return {
    root,
    config,
    store,
    settingsStore,
    files,
    async close() {
      await store.close();
      await settingsStore.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("Files MIME normalization accepts known fallback and rejects mismatches", () => {
  assert.equal(normalizeFileMime("notes.md", "application/octet-stream"), "text/markdown");
  assert.equal(normalizeFileMime("notes.md", "text/plain"), "text/plain");
  assert.throws(() => normalizeFileMime("image.png", "text/plain"), { code: "unsupported_file_type" });
  assert.throws(() => normalizeFileMime("../notes.txt", "text/plain"), { code: "invalid_request" });
});

test("interrupted upload leaves neither metadata nor generated temp files", async () => {
  const ctx = await fixture();
  try {
    const body = Readable.from((async function* generate() {
      yield Buffer.from("partial");
      throw new Error("socket interrupted");
    })());
    await assert.rejects(() => ctx.files.upload({
      spaceId: "spc_owner",
      name: "partial.txt",
      declaredMime: "text/plain",
      body,
    }), /socket interrupted/);
    assert.equal(ctx.store.list("files").length, 0);
    const tempEntries = await readdir(join(ctx.config.files.attachmentsPath, ".vera-tmp"));
    assert.deepEqual(tempEntries, []);
  } finally {
    await ctx.close();
  }
});

test("download validation rejects a generated path replaced by a symbolic link", async () => {
  const ctx = await fixture();
  try {
    const file = await ctx.files.upload({
      spaceId: "spc_owner",
      name: "safe.txt",
      declaredMime: "text/plain",
      body: Readable.from([Buffer.from("safe")]),
    });
    const record = ctx.store.find("files", file.id);
    const path = join(ctx.config.files.attachmentsPath, record.ownerSpaceId, record.storageName);
    await rm(path);
    const outside = join(ctx.root, "outside.txt");
    await writeFile(outside, "unsafe");
    await symlink(outside, path);
    await assert.rejects(() => ctx.files.getReadable("spc_owner", file.id), { code: "invalid_file" });
  } finally {
    await ctx.close();
  }
});

test("download validation rejects an owner directory replaced by a symbolic link", async () => {
  const ctx = await fixture();
  try {
    const file = await ctx.files.upload({
      spaceId: "spc_owner",
      name: "safe.txt",
      declaredMime: "text/plain",
      body: Readable.from([Buffer.from("safe")]),
    });
    const ownerRoot = join(ctx.config.files.attachmentsPath, "spc_owner");
    const movedRoot = join(ctx.root, "moved-owner");
    await rename(ownerRoot, movedRoot);
    await symlink(movedRoot, ownerRoot);
    await assert.rejects(() => ctx.files.getReadable("spc_owner", file.id), { code: "invalid_file" });
  } finally {
    await ctx.close();
  }
});

test("Files migration rolls moved directories back when verification fails", async () => {
  const ctx = await fixture();
  try {
    const file = await ctx.files.upload({
      spaceId: "spc_owner",
      name: "rollback.txt",
      declaredMime: "text/plain",
      body: Readable.from([Buffer.from("rollback")]),
    });
    const record = ctx.store.find("files", file.id);
    const originalPath = join(ctx.config.files.attachmentsPath, record.ownerSpaceId, record.storageName);
    const target = join(ctx.root, "target");
    ctx.files.verifyRoot = async () => { throw new Error("forced verification failure"); };
    await assert.rejects(() => migrateFilesPath({
      config: ctx.config,
      settingsStore: ctx.settingsStore,
      files: ctx.files,
      bootPaths: null,
      target,
    }), /rolled back/);
    assert.equal(await readFile(originalPath, "utf8"), "rollback");
    assert.equal(ctx.files.getRootPath(), ctx.config.files.attachmentsPath);
    assert.equal(ctx.settingsStore.get("paths.filesAttachmentsPath"), undefined);
  } finally {
    await ctx.close();
  }
});
