import { access, lstat, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { ApiError } from "../core/errors.js";

function invalid(message) {
  return new ApiError("invalid_request", message);
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertPrivateEnough(filePath, info, label) {
  if ((info.mode & 0o002) !== 0 || (info.mode & 0o020) !== 0) {
    throw invalid(`${label} must not be group- or world-writable: ${filePath}`);
  }
  if ((info.mode & 0o400) === 0) throw invalid(`${label} must be readable by its owner: ${filePath}`);
}

/** Resolve and check an extension directory without importing or executing it. */
export async function validateExtensionDirectory(rootPath) {
  if (typeof rootPath !== "string" || !rootPath.trim() || !isAbsolute(rootPath)) {
    throw invalid("rootPath must be an absolute path");
  }
  const requested = resolve(rootPath);
  const requestedInfo = await lstat(requested).catch((error) => {
    throw new ApiError("not_found", `extension directory is unavailable: ${error.message}`);
  });
  if (requestedInfo.isSymbolicLink()) throw invalid("rootPath must not be a symbolic link");
  const rootInfo = await stat(requested).catch((error) => {
    throw new ApiError("not_found", `extension directory is unavailable: ${error.message}`);
  });
  if (!rootInfo.isDirectory()) throw invalid("rootPath must be a directory");
  assertPrivateEnough(requested, rootInfo, "extension directory");

  const canonicalRoot = await realpath(requested);
  const manifestPath = resolve(canonicalRoot, "manifest.json");
  const manifestInfo = await lstat(manifestPath).catch((error) => {
    throw new ApiError("invalid_request", `extension manifest.json is unavailable: ${error.message}`);
  });
  if (!manifestInfo.isFile()) throw invalid("extension manifest.json must be a regular file");
  assertPrivateEnough(manifestPath, manifestInfo, "extension manifest");
  await access(manifestPath, constants.R_OK);

  return Object.freeze({ rootPath: canonicalRoot, manifestPath });
}

export async function validateExtensionEntry(rootPath, entry) {
  const candidate = resolve(rootPath, entry);
  if (!inside(rootPath, candidate)) throw invalid("manifest.entry must remain inside the extension directory");
  const entryPath = await realpath(candidate).catch((error) => {
    throw new ApiError("invalid_request", `extension entry is unavailable: ${error.message}`);
  });
  if (!inside(rootPath, entryPath)) throw invalid("manifest.entry symlink must remain inside the extension directory");
  const info = await lstat(entryPath);
  if (!info.isFile()) throw invalid("manifest.entry must be a regular file");
  assertPrivateEnough(entryPath, info, "extension entry");
  await access(entryPath, constants.R_OK);
  return entryPath;
}
