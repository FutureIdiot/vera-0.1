import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

function decodeSafePath(rawPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.split(/[\\/]+/).includes("..")) return null;
  return decoded;
}

function resolveSafePath(root, rawPathname) {
  const decoded = decodeSafePath(rawPathname);
  if (decoded === null) return null;
  const rootPath = resolve(root);
  const fullPath = resolve(rootPath, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  const offset = relative(rootPath, fullPath);
  if (offset === ".." || offset.startsWith(`..${sep}`) || resolve(fullPath) === resolve(rootPath, "..")) return null;
  return fullPath;
}

function etagFor(body) {
  return `"${createHash("sha256").update(body).digest("base64url")}"`;
}

function isHashedAsset(pathname) {
  return /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(pathname);
}

function cacheControlFor(pathname) {
  return isHashedAsset(pathname)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

function acceptsSpaFallback(req, pathname) {
  if (pathname.startsWith("/assets/") || extname(pathname)) return false;
  const accept = req.headers.accept;
  return !accept || accept.includes("text/html") || accept.includes("*/*");
}

async function readStaticFile(filePath) {
  let fileStat = await stat(filePath);
  let finalPath = filePath;
  if (fileStat.isDirectory()) {
    finalPath = resolve(filePath, "index.html");
    fileStat = await stat(finalPath);
  }
  if (!fileStat.isFile()) return null;
  return { finalPath, body: await readFile(finalPath) };
}

export function createStaticHandler(root, { spaFallback = true } = {}) {
  return async function serveStatic(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") return false;

    const rawPathname = (req.url || "/").split(/[?#]/, 1)[0] || "/";
    const decoded = decodeSafePath(rawPathname);
    if (decoded === null) return false;
    const pathname = decoded === "/" ? "/index.html" : decoded;
    let filePath = resolveSafePath(root, pathname);
    if (!filePath) return false;

    let file;
    try {
      file = await readStaticFile(filePath);
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
    }

    if (!file && spaFallback && acceptsSpaFallback(req, pathname)) {
      filePath = resolveSafePath(root, "/index.html");
      try {
        file = await readStaticFile(filePath);
      } catch (err) {
        if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
      }
    }
    if (!file) return false;

    const etag = etagFor(file.body);
    const responsePath = file.finalPath.endsWith(`${sep}index.html`) ? "/index.html" : pathname;
    const headers = {
      "Content-Type": MIME_TYPES[extname(file.finalPath).toLowerCase()] || "application/octet-stream",
      "Content-Length": file.body.length,
      "Cache-Control": cacheControlFor(responsePath),
      ETag: etag,
    };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { "Cache-Control": headers["Cache-Control"], ETag: etag });
      res.end();
      return true;
    }
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : file.body);
    return true;
  };
}
