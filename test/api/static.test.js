import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createStaticHandler } from "../../src/api/static.js";

let root;
let serveStatic;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "vera-static-test-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>Vera</title>");
  await writeFile(join(root, "app.js"), "console.log('vera');\n");
  await writeFile(join(root, "assets", "main-AbCdEf123456.js"), "export const vera = true;\n");
  serveStatic = createStaticHandler(root);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function request(method, url, headers = {}) {
  const response = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(statusCode, responseHeaders) {
      this.statusCode = statusCode;
      this.headers = responseHeaders;
    },
    end(body) {
      this.body = body;
    },
  };

  return {
    req: { method, url, headers },
    res: response,
  };
}

test("GET serves index HTML with an ETag and production HTML cache policy", async () => {
  const { req, res } = request("GET", "/");

  assert.equal(await serveStatic(req, res), true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "text/html; charset=utf-8");
  assert.equal(res.headers["Cache-Control"], "no-cache");
  assert.match(res.headers.ETag, /^"[A-Za-z0-9_-]+"$/);
  assert.equal(Buffer.from(res.body).toString(), "<!doctype html><title>Vera</title>");
});

test("HEAD returns the GET headers without a response body", async () => {
  const { req, res } = request("HEAD", "/app.js");

  assert.equal(await serveStatic(req, res), true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "text/javascript; charset=utf-8");
  assert.equal(res.headers["Content-Length"], Buffer.byteLength("console.log('vera');\n"));
  assert.equal(res.body, undefined);
});

test("matching If-None-Match returns 304 without a response body", async () => {
  const first = request("GET", "/index.html");
  await serveStatic(first.req, first.res);

  const conditional = request("GET", "/index.html", {
    "if-none-match": first.res.headers.ETag,
  });
  assert.equal(await serveStatic(conditional.req, conditional.res), true);
  assert.equal(conditional.res.statusCode, 304);
  assert.equal(conditional.res.headers.ETag, first.res.headers.ETag);
  assert.equal(conditional.res.headers["Cache-Control"], "no-cache");
  assert.equal(conditional.res.body, undefined);
});

test("hashed Vite assets receive immutable one-year caching", async () => {
  const { req, res } = request("GET", "/assets/main-AbCdEf123456.js");

  assert.equal(await serveStatic(req, res), true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "public, max-age=31536000, immutable");
  assert.match(res.headers.ETag, /^"[A-Za-z0-9_-]+"$/);
});

test("extensionless navigation falls back to index HTML", async () => {
  const { req, res } = request("GET", "/settings/accounts", { accept: "text/html" });

  assert.equal(await serveStatic(req, res), true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "text/html; charset=utf-8");
  assert.equal(res.headers["Cache-Control"], "no-cache");
  assert.equal(Buffer.from(res.body).toString(), "<!doctype html><title>Vera</title>");
});

test("missing assets do not fall back to index HTML", async () => {
  const { req, res } = request("GET", "/assets/missing-12345678.js", {
    accept: "text/html,*/*",
  });

  assert.equal(await serveStatic(req, res), false);
  assert.equal(res.statusCode, null);
  assert.equal(res.body, null);
});

test("path traversal attempts are rejected without leaking files", async () => {
  for (const url of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/%2e%2e/secret.txt"]) {
    const { req, res } = request("GET", url, { accept: "*/*" });
    assert.equal(await serveStatic(req, res), false, url);
    assert.equal(res.statusCode, null, url);
    assert.equal(res.body, null, url);
  }
});
