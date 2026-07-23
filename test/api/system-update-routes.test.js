import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { createRouter } from "../../src/api/router.js";
import { registerSystemUpdateRoutes } from "../../src/api/system-update-routes.js";

function response() {
  let status = null;
  let body = "";
  return {
    writeHead(value) { status = value; },
    end(value = "") { body += value; },
    result() { return { status, body: body ? JSON.parse(body) : null }; },
  };
}

async function request(router, method, path, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = path;
  const res = response();
  await router.handle(req, res);
  return res.result();
}

test("system update routes preserve strict bodies and accepted status", async () => {
  const calls = [];
  const update = { supported: true, state: "idle" };
  const router = createRouter();
  registerSystemUpdateRoutes(router, { updateControl: {
    async getStatus() { calls.push(["get"]); return update; },
    async queueCheck() { calls.push(["check"]); return { ...update, state: "checking" }; },
    async queueApply(body) { calls.push(["apply", body]); return { ...update, state: "queued" }; },
  } });

  assert.deepEqual(await request(router, "GET", "/api/system/update"), { status: 200, body: { update } });
  assert.equal((await request(router, "POST", "/api/system/update/check", {})).status, 202);
  assert.equal((await request(router, "POST", "/api/system/update/check", { extra: true })).status, 400);
  const apply = { targetCommit: "2".repeat(40), ifRequestId: `upd_${"a".repeat(32)}` };
  assert.equal((await request(router, "POST", "/api/system/update/apply", apply)).status, 202);
  assert.equal((await request(router, "POST", "/api/system/update/apply", { ...apply, repo: "evil" })).status, 400);
  assert.deepEqual(calls, [["get"], ["check"], ["apply", apply]]);
});
