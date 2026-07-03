// 静态文件服务：非 /api/ 路径回退到 frontend/（api-contract.md 系统表）。
// Phase 2 不引入构建步骤，浏览器直接加载原生 ES modules，这里只是一个
// 零依赖的最小静态文件 handler：Content-Type 按扩展名映射 + 路径穿越防护。
//
// 约定与 router.js 一致：handler 返回 true 表示已处理（无论成功与否），
// false 表示未找到文件，交由调用方（server.js）继续兜底（404）。

import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

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

// 把 URL pathname 解析到 root 目录下的绝对路径，拒绝任何逃逸出 root 的请求
// （`..` 穿越、编码绕过等）。逃逸或非法路径返回 null。
function resolveSafePath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = normalize(decoded).replace(/^([.]{2}(\/|\\|$))+/, "");
  const full = join(root, relative);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (full !== root && !full.startsWith(rootWithSep)) return null;
  return full;
}

export function createStaticHandler(root) {
  return async function serveStatic(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") return false;

    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    let filePath = resolveSafePath(root, pathname);
    if (!filePath) return false;

    try {
      let fileStat = await stat(filePath);
      if (fileStat.isDirectory()) {
        filePath = join(filePath, "index.html");
        fileStat = await stat(filePath);
      }
      const body = await readFile(filePath);
      const contentType = MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
      // no-store：防浏览器与 CDN 边缘缓存旧资源（api-contract.md 系统表；Phase 6 换 ETag）。
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": body.length,
        "Cache-Control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return true;
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return false;
      throw err;
    }
  };
}
