// Physical Files storage validation. Only gateway-generated ids participate in
// paths; display names are validated separately and never joined into a path.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { ApiError } from "../core/errors.js";

const MIME_BY_EXTENSION = new Map([
  [".txt", ["text/plain"]],
  [".md", ["text/markdown", "text/plain"]],
  [".json", ["application/json"]],
  [".csv", ["text/csv", "text/plain"]],
  [".pdf", ["application/pdf"]],
  [".png", ["image/png"]],
  [".jpg", ["image/jpeg"]],
  [".jpeg", ["image/jpeg"]],
  [".gif", ["image/gif"]],
  [".webp", ["image/webp"]],
  [".zip", ["application/zip"]],
  [".docx", ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]],
  [".xlsx", ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]],
  [".pptx", ["application/vnd.openxmlformats-officedocument.presentationml.presentation"]],
]);

export const TEMP_DIR = ".vera-tmp";
export const TRASH_DIR = ".vera-trash";
export const TEMP_PREFIX = "upload-";
const SPACE_ID_PATTERN = /^spc_[a-z0-9]+$/;
const FILE_ID_PATTERN = /^fil_[a-z0-9]+$/;

export function sha256Digest(hash) {
  return `sha256:${hash.digest("hex")}`;
}

export function validateDisplayName(name) {
  if (typeof name !== "string" || !name || name === "." || name === ".." ||
      name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new ApiError("invalid_request", "file name must be one display name without path segments");
  }
  return name;
}

export function normalizeFileMime(name, declaredMime) {
  validateDisplayName(name);
  const extension = extname(name).toLowerCase();
  const allowed = MIME_BY_EXTENSION.get(extension);
  if (!allowed) throw new ApiError("unsupported_file_type", `unsupported file extension: ${extension || "(none)"}`);
  const declared = typeof declaredMime === "string"
    ? declaredMime.split(";")[0].trim().toLowerCase()
    : "";
  if (!declared || declared === "application/octet-stream") return allowed[0];
  if (!allowed.includes(declared)) {
    throw new ApiError("unsupported_file_type", `MIME ${declared} does not match ${extension}`);
  }
  return declared;
}

export async function requireOrdinaryDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ApiError("invalid_file", "Files storage root must be an ordinary directory");
  }
}

export async function ensureOrdinaryDirectory(path) {
  await mkdir(path, { recursive: true });
  await requireOrdinaryDirectory(path);
}

export async function removeGeneratedTemps(root) {
  const tempRoot = join(root, TEMP_DIR);
  let entries;
  try {
    entries = await readdir(tempRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith(TEMP_PREFIX)) {
      await rm(join(tempRoot, entry.name), { force: true });
    }
  }
}

async function digestHandle(handle) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return sha256Digest(hash);
}

export function physicalFilePath(root, record) {
  if (!FILE_ID_PATTERN.test(record.id) || !SPACE_ID_PATTERN.test(record.ownerSpaceId) ||
      record.storageName !== `${record.id}.bin`) {
    throw new ApiError("invalid_file", `File ${record.id} has an unsafe storage path`);
  }
  return join(root, record.ownerSpaceId, record.storageName);
}

export async function openVerifiedRecord(record, root) {
  const ownerRoot = join(root, record.ownerSpaceId);
  const path = physicalFilePath(root, record);
  await requireOrdinaryDirectory(root);
  await requireOrdinaryDirectory(ownerRoot);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size !== record.sizeBytes) {
      throw new ApiError("invalid_file", `File ${record.id} failed size validation`);
    }
    const digest = await digestHandle(handle);
    if (digest !== record.sha256) throw new ApiError("invalid_file", `File ${record.id} failed hash validation`);
    return handle;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof ApiError) throw error;
    if (["ENOENT", "ELOOP"].includes(error.code)) {
      throw new ApiError("invalid_file", `File ${record.id} is missing or unsafe`);
    }
    throw error;
  }
}

export async function inspectStorageRoot(root, records) {
  let exists = true;
  try {
    const info = await lstat(root);
    exists = info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") exists = false;
    else throw error;
  }
  return {
    attachmentsPath: root,
    exists,
    activeCount: records.length,
    sizeBytes: records.reduce((sum, record) => sum + record.sizeBytes, 0),
  };
}

export async function verifyStorageRoot(root, records) {
  await ensureOrdinaryDirectory(root);
  for (const record of records) {
    const handle = await openVerifiedRecord(record, root);
    await handle.close();
  }
  return true;
}

export function supportedAccept() {
  return [...MIME_BY_EXTENSION.keys()].join(",");
}

export function isManagedOwnerDirectory(name) {
  return SPACE_ID_PATTERN.test(name);
}
