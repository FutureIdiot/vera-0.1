// Space-scoped Files domain. Binary bodies live under the configured attachments
// root while metadata stays in the gateway store. Display names never participate
// in filesystem paths; only gateway-generated Space/File ids do.

import { createHash } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ApiError } from "../core/errors.js";
import { newFileId } from "../core/id.js";
import {
  ensureOrdinaryDirectory,
  inspectStorageRoot,
  isManagedOwnerDirectory,
  normalizeFileMime,
  openVerifiedRecord,
  physicalFilePath,
  removeGeneratedTemps,
  sha256Digest,
  supportedAccept,
  TEMP_DIR,
  TEMP_PREFIX,
  TRASH_DIR,
  validateDisplayName,
  verifyStorageRoot,
} from "./files-storage.js";
import {
  currentFilesPolicy,
  isFileReadable,
  normalizeSharedSpaceIds,
  publicFile,
  requireActiveFile,
  requireSpace,
} from "./files-policy.js";

export { normalizeFileMime } from "./files-storage.js";

export async function createFilesService({
  store,
  settingsStore,
  rootPath,
  maxUploadBytes,
  maxAttachmentsPerMessage,
} = {}) {
  if (!store || !settingsStore || !rootPath) throw new Error("createFilesService requires store, settingsStore, and rootPath");
  let root = resolve(rootPath);
  let queue = Promise.resolve();
  await ensureOrdinaryDirectory(root);
  await removeGeneratedTemps(root);

  function withExclusive(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  function listReadable(spaceId) {
    requireSpace(store, spaceId);
    const policy = currentFilesPolicy(settingsStore);
    const files = store.list("files")
      .filter((record) => isFileReadable(record, spaceId, policy))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.id.localeCompare(right.id))
      .map((record) => publicFile(store, record, spaceId));
    return { files, policy };
  }

  function assertMessageFileIds(spaceId, fileIds = []) {
    requireSpace(store, spaceId);
    if (!Array.isArray(fileIds)) throw new ApiError("invalid_request", "fileIds must be an array");
    if (fileIds.length > maxAttachmentsPerMessage) {
      throw new ApiError("invalid_request", `fileIds may contain at most ${maxAttachmentsPerMessage} items`);
    }
    const unique = [...new Set(fileIds)];
    if (unique.length !== fileIds.length || unique.some((id) => typeof id !== "string")) {
      throw new ApiError("invalid_request", "fileIds must contain unique File ids");
    }
    const policy = currentFilesPolicy(settingsStore);
    for (const fileId of unique) {
      const record = store.find("files", fileId);
      if (!record || record.deletedAt) throw new ApiError("not_found", `file ${fileId} does not exist`);
      if (!isFileReadable(record, spaceId, policy)) throw new ApiError("forbidden", `file ${fileId} is not readable from space ${spaceId}`);
    }
    return unique;
  }

  function projectMessage(message, requestSpaceId = message.spaceId) {
    const policy = currentFilesPolicy(settingsStore);
    const attachments = (message.fileIds ?? []).map((fileId) => {
      const record = store.find("files", fileId);
      if (!record) return { fileId, name: "附件", mime: "application/octet-stream", sizeBytes: 0, state: "unavailable" };
      const state = record.deletedAt ? "deleted" : isFileReadable(record, requestSpaceId, policy) ? "available" : "unavailable";
      return { fileId, name: record.name, mime: record.mime, sizeBytes: record.sizeBytes, state };
    });
    return attachments.length > 0 ? { ...message, attachments } : message;
  }

  async function upload({ spaceId, name, declaredMime, contentLength, body }) {
    const space = requireSpace(store, spaceId);
    if (space.archivedAt) throw new ApiError("conflict", `space ${spaceId} is archived, restore it first`);
    const displayName = validateDisplayName(name);
    const mime = normalizeFileMime(displayName, declaredMime);
    if (Number.isFinite(contentLength) && contentLength > maxUploadBytes) {
      throw new ApiError("file_too_large", `file exceeds ${maxUploadBytes} bytes`);
    }
    return withExclusive(async () => {
      await ensureOrdinaryDirectory(root);
      const id = newFileId();
      const storageName = `${id}.bin`;
      const tempRoot = join(root, TEMP_DIR);
      const ownerRoot = join(root, spaceId);
      await ensureOrdinaryDirectory(tempRoot);
      await ensureOrdinaryDirectory(ownerRoot);
      const tempPath = join(tempRoot, `${TEMP_PREFIX}${id}.tmp`);
      const finalPath = join(ownerRoot, storageName);
      const handle = await open(tempPath, "wx");
      const hash = createHash("sha256");
      let sizeBytes = 0;
      let committed = false;
      try {
        for await (const chunkValue of body) {
          const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
          sizeBytes += chunk.length;
          if (sizeBytes > maxUploadBytes) throw new ApiError("file_too_large", `file exceeds ${maxUploadBytes} bytes`);
          hash.update(chunk);
          await handle.write(chunk);
        }
        await handle.sync();
        await handle.close();
        await rename(tempPath, finalPath);
        const now = new Date().toISOString();
        const record = store.insert("files", {
          id,
          ownerSpaceId: spaceId,
          name: displayName,
          mime,
          sizeBytes,
          sha256: sha256Digest(hash),
          storageName,
          sharedSpaceIds: [],
          version: 1,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
        try {
          await store.flush();
        } catch (error) {
          store.remove("files", id);
          await rm(finalPath, { force: true });
          throw error;
        }
        committed = true;
        return publicFile(store, record, spaceId, { includeHash: true });
      } finally {
        if (!committed) {
          await handle.close().catch(() => {});
          await rm(tempPath, { force: true }).catch(() => {});
        }
      }
    });
  }

  async function getReadable(spaceId, fileId, { includeHash = true } = {}) {
    requireSpace(store, spaceId);
    const record = requireActiveFile(store, fileId);
    if (!isFileReadable(record, spaceId, currentFilesPolicy(settingsStore))) {
      throw new ApiError("not_found", `file ${fileId} does not exist`);
    }
    const handle = await openVerifiedRecord(record, root);
    await handle.close();
    return publicFile(store, record, spaceId, { includeHash });
  }

  async function openDownload(spaceId, fileId) {
    requireSpace(store, spaceId);
    const record = requireActiveFile(store, fileId);
    if (!isFileReadable(record, spaceId, currentFilesPolicy(settingsStore))) {
      throw new ApiError("not_found", `file ${fileId} does not exist`);
    }
    const handle = await openVerifiedRecord(record, root);
    return { file: publicFile(store, record, spaceId), handle };
  }

  async function updateSharing(spaceId, fileId, { sharedSpaceIds, ifMatch }) {
    const space = requireSpace(store, spaceId);
    if (space.archivedAt) throw new ApiError("conflict", `space ${spaceId} is archived, restore it first`);
    return withExclusive(async () => {
      const record = requireActiveFile(store, fileId);
      if (record.ownerSpaceId !== spaceId) throw new ApiError("forbidden", "only the owner Space can update sharing");
      if (!Number.isInteger(ifMatch)) throw new ApiError("invalid_request", "ifMatch must be an integer File version");
      if (record.version !== ifMatch) {
        throw new ApiError("conflict", "File version mismatch", {
          reason: "version_mismatch",
          current: { file: publicFile(store, record, spaceId, { includeHash: true }) },
        });
      }
      const next = store.update("files", fileId, {
        sharedSpaceIds: normalizeSharedSpaceIds(store, spaceId, sharedSpaceIds),
        version: record.version + 1,
        updatedAt: new Date().toISOString(),
      });
      try {
        await store.flush();
      } catch (error) {
        store.update("files", fileId, record);
        throw error;
      }
      return publicFile(store, next, spaceId, { includeHash: true });
    });
  }

  async function tombstoneRecord(record, deletedAt) {
    const path = physicalFilePath(root, record);
    const trashRoot = join(root, TRASH_DIR);
    await ensureOrdinaryDirectory(trashRoot);
    const trashPath = join(trashRoot, `${record.id}-${Date.now()}.bin`);
    const verified = await openVerifiedRecord(record, root);
    await verified.close();
    await rename(path, trashPath);
    const previous = { ...record };
    try {
      const updated = store.update("files", record.id, {
        deletedAt,
        updatedAt: deletedAt,
        version: record.version + 1,
      });
      await store.flush();
      await rm(trashPath, { force: true });
      return updated;
    } catch (error) {
      store.update("files", record.id, previous);
      await rename(trashPath, path).catch(() => {});
      throw error;
    }
  }

  async function deleteFile(spaceId, fileId, ifMatch) {
    const space = requireSpace(store, spaceId);
    if (space.archivedAt) throw new ApiError("conflict", `space ${spaceId} is archived, restore it first`);
    return withExclusive(async () => {
      const record = requireActiveFile(store, fileId);
      if (record.ownerSpaceId !== spaceId) throw new ApiError("forbidden", "only the owner Space can delete a File");
      if (!Number.isInteger(ifMatch)) throw new ApiError("invalid_request", "ifMatch must be an integer File version");
      if (record.version !== ifMatch) {
        throw new ApiError("conflict", "File version mismatch", {
          reason: "version_mismatch",
          current: { file: publicFile(store, record, spaceId, { includeHash: true }) },
        });
      }
      await tombstoneRecord(record, new Date().toISOString());
    });
  }

  async function deleteOwnedBySpace(spaceId, deletedAt = new Date().toISOString()) {
    return withExclusive(async () => {
      const records = store.list("files").filter((record) => record.ownerSpaceId === spaceId && !record.deletedAt);
      if (records.length === 0) return [];
      const trashRoot = join(root, TRASH_DIR);
      await ensureOrdinaryDirectory(trashRoot);
      const moved = [];
      try {
        for (const record of records) {
          const verified = await openVerifiedRecord(record, root);
          await verified.close();
          const source = physicalFilePath(root, record);
          const trash = join(trashRoot, `${record.id}-${Date.now()}-${moved.length}.bin`);
          await rename(source, trash);
          moved.push({ record, source, trash });
        }
        for (const { record } of moved) {
          store.update("files", record.id, {
            deletedAt,
            updatedAt: deletedAt,
            version: record.version + 1,
          });
        }
        await store.flush();
        for (const { trash } of moved) await rm(trash, { force: true });
        return records.map((record) => record.id);
      } catch (error) {
        for (const { record } of moved) store.update("files", record.id, record);
        for (const { source, trash } of moved.reverse()) {
          await rename(trash, source).catch(() => {});
        }
        throw error;
      }
    });
  }

  async function inspect() {
    const active = store.list("files").filter((record) => !record.deletedAt);
    return inspectStorageRoot(root, active);
  }

  async function verifyRoot(candidateRoot) {
    const candidate = resolve(candidateRoot);
    return verifyStorageRoot(candidate, store.list("files").filter((item) => !item.deletedAt));
  }

  function reopen({ rootPath: nextRoot }) {
    root = resolve(nextRoot);
  }

  return {
    withExclusive,
    listReadable,
    assertMessageFileIds,
    projectMessage,
    upload,
    getReadable,
    openDownload,
    updateSharing,
    deleteFile,
    deleteOwnedBySpace,
    inspect,
    verifyRoot,
    reopen,
    getRootPath: () => root,
    maxUploadBytes,
    supportedAccept: supportedAccept(),
    isManagedOwnerDirectory,
  };
}
