// Store-backed Files authorization and safe projections. This module knows
// owners/read policy but never opens a physical attachment path.

import { ApiError } from "../core/errors.js";

function stripInternal({ _seq, storageName, ...rest }) {
  return rest;
}

export function currentFilesPolicy(settingsStore) {
  return settingsStore.getAll()["isolation.files"] ?? "isolated";
}

export function isFileReadable(record, spaceId, policy) {
  if (!record || record.deletedAt) return false;
  if (record.ownerSpaceId === spaceId) return true;
  if (policy === "globalReadable") return true;
  return policy === "specifiedShared" && record.sharedSpaceIds.includes(spaceId);
}

export function publicFile(store, record, requestSpaceId, { includeHash = false } = {}) {
  const owner = store.find("spaces", record.ownerSpaceId);
  const result = {
    ...stripInternal(record),
    canManage: record.ownerSpaceId === requestSpaceId && !record.deletedAt,
    ownerSpace: { id: record.ownerSpaceId, name: owner?.name ?? "已删除 Space" },
  };
  if (!includeHash) delete result.sha256;
  return result;
}

export function requireSpace(store, spaceId) {
  const space = store.find("spaces", spaceId);
  if (!space) throw new ApiError("not_found", `space ${spaceId} does not exist`);
  return space;
}

export function requireActiveFile(store, fileId) {
  const record = store.find("files", fileId);
  if (!record || record.deletedAt) throw new ApiError("not_found", `file ${fileId} does not exist`);
  return record;
}

export function normalizeSharedSpaceIds(store, ownerSpaceId, input) {
  if (!Array.isArray(input)) throw new ApiError("invalid_request", "sharedSpaceIds must be an array");
  const ids = [...new Set(input)];
  if (ids.length !== input.length || ids.some((id) => typeof id !== "string" || id === ownerSpaceId)) {
    throw new ApiError("invalid_request", "sharedSpaceIds must contain unique non-owner Space ids");
  }
  for (const id of ids) requireSpace(store, id);
  return ids.sort();
}
